# jev-fc-buddy

An **AI teammate for classic NES co-op games**, played in the browser and sold as coin codes on the
[Termix](https://termix.ai) agent marketplace (agent.family).

- Agent harness: [pi](https://pi.dev) (`@earendil-works/pi-coding-agent` SDK) — runs the buyer chat through [OpenRouter](https://openrouter.ai) (any OpenAI-compatible relay works)
- Decision model: [TypeSafe Jev](https://typesafe.ai) (System One) — typed, probability-backed action choices several times a second (`skills/typesafe-ai`). OpenRouter serves Jev on the same key through its System One endpoint (`/api/v1/systemone`, beta)
- Marketplace: [termix-agent-skills](https://termix.ai/skills?v=1.8.0) v1.8.0 — hosting, orders, delivery, settlement (`skills/termix-agent-skills`, vendored unchanged)
- Emulator: [jsnes](https://github.com/bfirsh/jsnes) in the player's browser; the server never streams video
- Games: Contra (run-and-gun) and Battle City (top-down tanks). Games are plug-in profiles under `games/<id>/`; nothing outside that folder is title-specific. Each profile names a `genre` that selects the reflex policy: `run-and-gun` (follow / cover / jump / prone) or `tank` (lanes, shells, a base to protect)

## How it works

```
buyer buys N USDC on Termix ──▶ hosting loop: accept (on-chain) ──▶ mint code worth N coins ──▶ deliver code + play URL
                                                                                               │
player opens /?code=FC-…  ──▶ redeem ──▶ Insert coin (1 coin = one timed window, COIN_SESSION_MINUTES) ──▶ browser loads ROM
        │                                 leaving and coming back inside the window is free (now − insert time < minutes)
        │
        ├─ browser: jsnes runs the game · P1 = keyboard / gamepad · P2 = the AI · reports RAM 12×/s over WebSocket
        │
        └─ server (one brain per session):
             reflex policy (every tick, code)      → keeps the buddy moving: follow / cover / shoot / dodge
             Jev (TypeSafe, ~4×/s, typed Choice)   → picks the action + "partner in danger?" / "jump now?" probabilities
           every controller change and Jev verdict is pushed to the browser: the PAD view lights the buttons on an
           on-screen NES controller and floats each move up like a rhythm game; the LOG view is the plain text stream
```

The AI normally holds controller 2, so on the title screen it presses SELECT until the game is in
2-player mode and then START. Both players share the screen; the buddy stays within a "follow
distance" of the human and never hogs the scroll.

In Battle City only controller 1 works on the title screen, so there the AI taps SELECT/START on
controller 1 (`start.controller` in the profile) and then plays as player 2 (the green tank, right of
the base); the human is player 1 (yellow, left of the base) as usual. The tank policy puts
survival first: it shoots down shells that are coming at it when it faces them, steps out of their
lane otherwise, never lingers at point-blank range, refuses to fire along any lane that ends in the
eagle or its wall (or through the partner), and only then goes hunting — preferring enemies that
threaten the base and firing positions within reach of it.

## Requirements

- Node.js ≥ 22
- An OpenRouter key (`RELAY_API_KEY`, relay `https://openrouter.ai/api`) — buyer chat **and Jev**
  (`jev-latest` → `~typesafe/jev-latest`, $0.042/M input). A direct TypeSafe account can be used
  instead by setting `TYPESAFE_API_KEY` + `TYPESAFE_BASE_URL=https://api.typesafe.ai`. Without any
  key the buddy still plays on the reflex policy and the page says "Jev offline"
- The game ROM(s) in `roms/` (not distributed)
- Only for selling: a dedicated hot wallet (`WALLET_KEY`) with a little gas on the chosen chain

## Quick start (local play, no marketplace)

```bash
git clone git@github.com:work4life2/jev-fc-buddy.git && cd jev-fc-buddy
npm install --ignore-scripts
npm run build                        # tsc + copies jsnes into web/vendor
cp .env.example .env
#   .env.local (git-ignored):  RELAY_API_KEY=sk-or-v1-...
cp /path/to/contra.nes roms/contra.nes            # and/or roms/battlecity.nes (Battle City (J), 24592 bytes)
npm run doctor
npm run code -- mint 3               # prints FC-XXXX-XXXX-XXXX and the play URL
npm run serve -- --local             # http://localhost:8790/?code=FC-...
```

Operator dashboard (relay spend, revenue, coins, live sessions, minutes per coin, one-click mint):
`http://localhost:8790/admin` (or `ADMIN_PATH`). It asks for `ADMIN_TOKEN` once and keeps it in the browser;
with no token configured only loopback callers are admins.

### Coins and play windows

One coin opens a play window of `COIN_SESSION_MINUTES` (default 10; the dashboard can change it at runtime,
new coins only). The clock starts when the coin is inserted and keeps running whether or not the page is
open, so a player can quit and come back with the same code for free while the window lasts. Only one
browser session per window can run at a time: inserting the code elsewhere takes over. When the window
ends the next Insert coin spends the next coin; a code with no coins left is refused. `/api/redeem`,
`/api/sessions` and `/api/admin/*` are rate-limited per IP by nginx in production.

Headless end-to-end check (runs jsnes in Node, opens a session, streams RAM, applies the AI's inputs):

```bash
node scripts/headless-play.mjs --seconds 60                      # first playable game
node scripts/headless-play.mjs --seconds 60 --game battlecity    # a specific one (tank games get a wandering dummy human)
```

Adding `&auto=1` to a play URL spends a coin on page load (testing aid).

### Controls

| NES | Keyboard | Gamepad (default = standard mapping) |
| --- | --- | --- |
| D-pad | W A S D (or arrows) | d-pad / left stick |
| A (jump) | K (or X) | bottom / top face button |
| B (fire) | J (or Z) | left / right face button, R1 / R2 |
| Start | Enter | Start |
| Select | Shift | Select |

Gamepads differ, so the play page has a **🎮 Map** panel (also linked from the coin page): click *Set*
next to an action and press the button or push the stick you want. The mapping is stored in the
browser's localStorage per gamepad id and reloaded automatically.

## Selling on Termix

```bash
#   .env.local: WALLET_KEY=0x...   (key mode, unattended; fund with a little gas)
npm run setup -- agents              # list this wallet's agents → A2A_AGENT_ID in .env
npm run setup -- mint <name> "<display name>"     # if there is none yet (needs gas)
npm run setup -- listing [cover.png] # publish the listing (SERVICE_PRICE per coin)
npm start                            # play server + hosting loop
```

Every funded order becomes one code worth `floor(price × COINS_PER_DOLLAR)` coins (1 $ = 1 coin by
default). The code and the play URL (`PLAY_BASE_URL/?code=…`) are uploaded as the delivery
artifact, submitted on-chain and posted in the order conversation. Buyer chat is answered by the
pi chat session. Orders are re-swept every `SWEEP_INTERVAL_SECONDS`; delivered orders whose challenge
window elapsed are claimed automatically. Jobs are persisted in `data/jobs/`, codes in `data/coins.json`.

## Deploying (bare-metal, pull-based)

`deploy/` mirrors 3dcardagent's setup: a systemd service, a one-minute timer that redeploys when
origin/main moves, and an nginx site with Let's Encrypt. On a fresh Ubuntu box with nginx:

```
scp .env.local roms/*.nes root@host:/opt/jev-fc-buddy/      # PUBLIC_BASE_URL=https://<host>, ADMIN_TOKEN=…, HTTP_HOST=127.0.0.1
ssh root@host 'curl -fsSL https://raw.githubusercontent.com/work4life2/jev-fc-buddy/main/deploy/server-bootstrap.sh | bash'
```

After that, `git push` is the deploy. See AGENTS.md → Production for the live server.

### Play page on Vercel

The repo's `vercel.json` builds only the static page: `npm run build:web` copies jsnes into `web/vendor`
and writes `web/config.js` with `JEV_API_BASE` (the build command defaults it to the production API
host; set the `JEV_API_BASE` environment variable in the Vercel project to override). Output directory is
`web`. On the server set `PLAY_BASE_URL=https://<vercel host>` and add that origin to `ALLOWED_ORIGINS`;
the server then redirects `/` there and serves only `/api/*`, `/ws` and the operator page.

## Models

```bash
npm run model                        # show chat / thinking / jev
npm run model -- list [filter]       # the relay's live catalog (relay/<id>)
npm run model -- chat relay/google/gemini-3.1-flash-lite
npm run model -- reset
```

The only LLM in the loop is the buyer-chat model (it explains the service and answers support questions,
nothing else). In-game decisions are Jev plus the reflex policy; there is no commentary model. Jev's model id
is `TYPESAFE_MODEL` (default `jev-latest`). `node scripts/chat-dry-run.mjs` sends sample buyer messages
through the real prompt and model without posting anything to Termix.

## Adding a game

Create `games/<id>/game.json` (see `games/contra/game.json` for a side-scroller and
`games/battlecity/game.json` for a top-down tank game): ROM file name, `genre`, screen size, which
controller is the human's / the AI's, the RAM addresses for player positions, lives, state and the
enemy table, how phases (title / loading / playing / game over) are recognised, the 2-player start
procedure (`loadingStart` when a stage screen wants another START), reflex distances, and a short
brief of the game (`coachBrief`, kept for Jev's context). Tank games add a `tank` block: the object table of tanks (with the sprite-id
ranges that tell moving / standing / spawning / exploding apart), the shell table, the power-up
bytes, the tile-map shadow with the tile ids per terrain, and the base cells. Drop the ROM into
`roms/`. The doctor and the play page pick it up on restart. For RAM maps, disassemblies such as
[nes-contra-us](https://github.com/vermiceli/nes-contra-us) or the Data Crystal wiki are the source;
when neither has what you need, run the ROM in jsnes under Node and diff RAM while pressing buttons
(that is how the Battle City map was made).

## Layout

```
src/index.ts           CLI: serve · code · setup · model · doctor · jobs · pi
src/server/http.ts     REST (/api/redeem, /api/sessions, /api/games/:id/rom, /api/admin/*), WebSocket, static page or redirect
src/server/dashboard.ts operator dashboard page · src/server/spend.ts relay (OpenRouter) key spend
src/ai/observe.ts      RAM bytes → game-agnostic observation (via the game profile)
src/ai/policy.ts       reflex policy (run-and-gun): intent → held buttons
src/ai/tankPolicy.ts   reflex policy (tank): shells, lanes, path finding, base protection
src/ai/jev.ts          TypeSafe Jev: typed Choice / Noul questions over the observation
src/ai/player.ts       the brain: reflex ⟷ Jev, ops stream
src/coins/store.ts     coin codes and play windows (data/coins.json) · src/runtimeConfig.ts runtime overrides (models, minutes per coin)
src/termix/, src/hosting/, src/jobs/   marketplace: hosting loop, orders → codes → delivery, buyer chat
games/<id>/game.json   game profiles          web/   play page (vanilla JS + jsnes)
skills/                termix-agent-skills, typesafe-ai (vendored)
```

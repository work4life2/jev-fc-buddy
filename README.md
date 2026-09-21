# jev-fc-buddy

An **AI teammate for classic NES co-op games**, played in the browser and sold as coin codes on the
[Termix](https://termix.ai) agent marketplace (agent.family).

- Agent harness: [pi](https://pi.dev) (`@earendil-works/pi-coding-agent` SDK) — runs the in-game coach and the buyer chat through the same OpenAI-compatible relay as `3dcardagent`
- Decision model: [TypeSafe Jev](https://typesafe.ai) (System One) — typed, probability-backed action choices several times a second (`skills/typesafe-ai`)
- Marketplace: [termix-agent-skills](https://termix.ai/skills?v=1.8.0) v1.8.0 — hosting, orders, delivery, settlement (`skills/termix-agent-skills`, vendored unchanged)
- Emulator: [jsnes](https://github.com/bfirsh/jsnes) in the player's browser; the server never streams video
- First game: Contra (魂斗罗). Games are plug-in profiles under `games/<id>/`; nothing outside that folder is title-specific

## How it works

```
buyer buys N USDC on Termix ──▶ hosting loop: accept (on-chain) ──▶ mint code worth N coins ──▶ deliver code + play URL
                                                                                               │
player opens /?code=FC-…  ──▶ redeem ──▶ Insert coin (1 coin = one session, COIN_SESSION_MINUTES) ──▶ browser loads ROM
        │
        ├─ browser: jsnes runs the game · P1 = keyboard / gamepad · P2 = the AI · reports RAM 12×/s over WebSocket
        │
        └─ server (one brain per session):
             reflex policy (every tick, code)      → keeps the buddy moving: follow / cover / shoot / dodge
             Jev (TypeSafe, ~4×/s, typed Choice)   → picks the action + "partner in danger?" / "jump now?" probabilities
             coach (pi session on the relay, ~10 s) → plan + one line of commentary (screenshot included for vision models)
           every controller change, Jev verdict and coach line is pushed to the right-hand danmaku stream
```

The AI holds controller 2, so on the title screen it presses SELECT until the game is in 2-player
mode and then START. Both players share the screen; the buddy stays within a "follow distance" of the
human and never hogs the scroll.

## Requirements

- Node.js ≥ 22
- A key for the OpenAI-compatible relay (`RELAY_API_KEY`, default relay `https://www.cun.ai`) — coach + chat
- A TypeSafe key (`TYPESAFE_API_KEY`) for Jev. **The relay does not serve Jev**; without the key the
  buddy still plays on reflex + coach and the ops stream says "Jev offline"
- The game ROM(s) in `roms/` (not distributed)
- Only for selling: a dedicated hot wallet (`WALLET_KEY`) with a little gas on the chosen chain

## Quick start (local play, no marketplace)

```bash
git clone git@github.com:work4life2/jev-fc-buddy.git && cd jev-fc-buddy
npm install --ignore-scripts
npm run build                        # tsc + copies jsnes into web/vendor
cp .env.example .env
#   .env.local (git-ignored):  RELAY_API_KEY=sk-...   TYPESAFE_API_KEY=...
cp /path/to/contra.nes roms/contra.nes
npm run doctor
npm run code -- mint 3               # prints FC-XXXX-XXXX-XXXX and the play URL
npm run serve -- --local             # http://localhost:8790/?code=FC-...
```

Operator dashboard (codes, live sessions, one-click mint): `http://localhost:8790/admin` (loopback, or
`Authorization: Bearer $ADMIN_TOKEN`).

Headless end-to-end check (runs jsnes in Node, opens a session, streams RAM, applies the AI's inputs):

```bash
node scripts/headless-play.mjs --seconds 60
```

Adding `&auto=1` to a play URL spends a coin on page load (testing aid).

### Controls

| NES | Keyboard | Gamepad (standard mapping) |
| --- | --- | --- |
| D-pad | arrows | d-pad / left stick |
| A (jump) | X or K | bottom / top face button |
| B (fire) | Z or J | left / right face button, R1 / R2 |
| Start | Enter | Start |
| Select | Shift | Select |

## Selling on Termix

```bash
#   .env.local: WALLET_KEY=0x...   (key mode, unattended; fund with a little gas)
npm run setup -- agents              # list this wallet's agents → A2A_AGENT_ID in .env
npm run setup -- mint <name> "<display name>"     # if there is none yet (needs gas)
npm run setup -- listing [cover.png] # publish the listing (SERVICE_PRICE per coin)
npm start                            # play server + hosting loop
```

Every funded order becomes one code worth `floor(price × COINS_PER_DOLLAR)` coins (1 $ = 1 coin by
default). The code and the play URL (`PUBLIC_BASE_URL/?code=…`) are uploaded as the delivery
artifact, submitted on-chain and posted in the order conversation. Buyer chat is answered by the
pi chat session. Orders are re-swept every `SWEEP_INTERVAL_SECONDS`; delivered orders whose challenge
window elapsed are claimed automatically. Jobs are persisted in `data/jobs/`, codes in `data/coins.json`.

## Models

```bash
npm run model                        # show coach / chat / thinking / jev
npm run model -- list [filter]       # the relay's live catalog (relay/<id>)
npm run model -- coach relay/gemini-3-flash
npm run model -- reset
```

The coach needs a vision-capable model when `AI_COACH_VISION=1` (gemini / gpt / claude on the relay all
are). Jev's model id is `TYPESAFE_MODEL` (default `jev-latest`).

## Adding a game

Create `games/<id>/game.json` (see `games/contra/game.json`): ROM file name, screen size, which
controller is the human's / the AI's, the RAM addresses for player positions, lives, state and the
enemy table, how phases (title / playing / game over) are recognised, the 2-player start procedure,
reflex distances, and a short brief for the coach. Drop the ROM into `roms/`. The doctor and the
play page pick it up on restart. For RAM maps, disassemblies such as
[nes-contra-us](https://github.com/vermiceli/nes-contra-us) or the Data Crystal wiki are the source.

## Layout

```
src/index.ts           CLI: serve · code · setup · model · doctor · jobs · pi
src/server/http.ts     play page, REST (/api/redeem, /api/sessions, /api/games/:id/rom), WebSocket, /admin
src/ai/observe.ts      RAM bytes → game-agnostic observation (via the game profile)
src/ai/policy.ts       reflex policy: intent → held buttons
src/ai/jev.ts          TypeSafe Jev: typed Choice / Noul questions over the observation
src/ai/coach.ts        pi session: plan + commentary
src/ai/player.ts       the brain: reflex ⟷ Jev ⟷ coach, ops stream
src/coins/store.ts     coin codes (data/coins.json)
src/termix/, src/hosting/, src/jobs/   marketplace: hosting loop, orders → codes → delivery, buyer chat
games/<id>/game.json   game profiles          web/   play page (vanilla JS + jsnes)
skills/                termix-agent-skills, typesafe-ai (vendored)
```

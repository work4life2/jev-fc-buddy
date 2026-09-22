# jev-fc-buddy

An AI teammate ("buddy") that plays classic NES co-op games with a human in the browser, sold as
coin codes on the Termix agent marketplace.

- `skills/termix-agent-skills` — marketplace operations (link account, host agent, listings, orders,
  delivery). Run its scripts from `data/termix/` (credentials are cached there):
  `cd data/termix && node ../../skills/termix-agent-skills/scripts/<script>`.
- `skills/typesafe-ai` — how to use TypeSafe's Jev (System One) model: typed Choice / Noul / Score
  questions over structured state. `src/ai/jev.ts` is the integration; read the live docs at
  https://docs.typesafe.ai/llms.txt before changing the questions.
- `games/<id>/game.json` — one profile per game: ROM name, RAM addresses, phases, 2-player start
  procedure, reflex parameters, game brief. Nothing outside `games/` may mention a specific title.
  `games/<id>/learned.json` is written by `node dist/index.js train run --rounds N` (self-play in a
  headless jsnes, see README → Self-play training): pits, kill zones, platforms, failed jumps. It is
  committed and deploys with the code; rerun training after changing `src/ai/policy.ts` and check the
  deaths-per-1000px number did not go up. Reports go to `data/train/` (git-ignored).
- `roms/` — ROM files (git-ignored). `web/` — the play page (vanilla JS + jsnes). `src/` — server.
- Never write into `skills/`; test data goes under `data/`.

## Production (deployed 2026-09-22)

The backend runs on the same Linode box as 3dcardagent (`~/code/3dcardagent`, memory file
`holo-card-deployment`): Ubuntu 24.04, 2 vCPU / 3.8 GB, Singapore, `172.104.55.67`.

- SSH: `ssh -i pass/termix-jack-dev.pem root@172.104.55.67` (key only; password login is off). `pass/` is git-ignored and holds
  `admin-token.txt` (`ADMIN_TOKEN`, bearer for the operator page and `/api/admin/*`) and `admin-path.txt`
  (`ADMIN_PATH`: the operator page lives at that random path, `/admin` is gone). nginx throttles the
  operator page, `/api/admin/*` and `/api/redeem` to 5 req/s per IP; fail2ban bans repeat 401/429 offenders.
- Layout: repo at `/opt/jev-fc-buddy`, runs as user `jevbuddy` under systemd `jev-fc-buddy`
  (`journalctl -fu jev-fc-buddy`). `.env.local` there is the only env file (relay key, `HTTP_HOST=127.0.0.1`,
  `PUBLIC_BASE_URL`, `ADMIN_TOKEN`, `ALLOWED_ORIGINS`). ROMs are in `/opt/jev-fc-buddy/roms` (git-ignored, copied by scp).
- **Auto-deploy is pull-based**: `jev-fc-buddy-autodeploy.timer` runs `deploy/deploy.sh` every minute; when
  origin/main moves it resets the checkout, `npm ci`, builds, re-installs the units + nginx site and restarts.
  Pushing to main is deploying. No webhooks or GitHub secrets.
- Public URL: `https://fc.172.104.55.67.sslip.io` (sslip.io resolves the embedded IP; Let's Encrypt cert via
  certbot webroot, renewed by `certbot.timer`). nginx terminates TLS and proxies to `127.0.0.1:8790`
  (`deploy/nginx.conf` = :80 ACME + redirect, `deploy/nginx-tls.conf` = :443, no buffering on `/ws`).
  To move to a real domain: change `PUBLIC_BASE_URL` in `.env.local`, run `certbot certonly --webroot -w /var/www/certbot -d <host>`,
  then `deploy/deploy.sh --force`.
- Play page: hosted on Vercel at `https://jev-fc-buddy.vercel.app` (project `jev-fc-buddy` in the `zk1s-projects`
  scope, Git-connected to `work4life2/jev-fc-buddy`, so a push to main deploys it too; `vercel.json` in the repo is the
  build config, `web/config.js` is generated at build with the API host). The server has `PLAY_BASE_URL` set to the
  Vercel URL and `ALLOWED_ORIGINS` containing it: it redirects `/` there and serves only `/api/*`, `/ws` and the operator page.
  Old play links to the sslip host keep working through the redirect (the `?code=` query is preserved).
- Operator dashboard: `https://fc.172.104.55.67.sslip.io` + `pass/admin-path.txt`; paste `pass/admin-token.txt` into the
  sign-in box once (stored in that browser). Shows OpenRouter key spend (today / week / month / all-time, credits left),
  revenue from Termix orders, coins, live sessions, and lets you change minutes per coin (runtime override in
  `data/runtime-config.json`, new coins only) and mint codes.
- Shares the box with holo-card-agent (`:8787`, nginx default server on :80). Its Blender renders saturate both cores
  for minutes; this unit has `CPUWeight=300` so game ticks win that contest. Disk: holo prunes old orders itself;
  this service writes only small JSON + logs under `data/`.
- Termix hosting is **enabled** (2026-09-22): `.env.local` on the server has `WALLET_KEY` (hot wallet
  `0xf8a14ce6…61a7a`, chain bsc) and `A2A_AGENT_ID=cmuc7o7r0jcryzw01qxthkyw5` (GameBuddy.agent, token #355860), so
  `serve` runs the play server + hosting loop and every funded order becomes a code. Only one host per agent id: do
  not run `npm start` with the same agent id elsewhere. The listing `cmuc8ugk83vhptq01lauay26h` (1 USDC per coin, instant-buyable, category
  "Automation & Ops": Termix has no games category) was published with `npm run setup -- listing data/listing/cover.png`
  (cover generated with gpt-image-2 on cun.ai, kept git-ignored in `data/listing/`); edit it with `--update cmuc8ugk83vhptq01lauay26h`.
- No commentary model: the in-game AI is Jev + reflexes only (the LLM coach was removed 2026-09-22 to cut spend); the
  only LLM call is buyer chat, which is restricted to explaining this service.
- Language: everything buyer-facing (page, delivery text, chat replies, listing) is English only.

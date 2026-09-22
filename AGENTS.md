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
  procedure, reflex parameters, coach brief. Nothing outside `games/` may mention a specific title.
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
- Play page: the server serves `web/` itself, so `https://fc.172.104.55.67.sslip.io/?code=…` works as-is. If the
  page is hosted on Vercel instead, deploy `web/` there with `config.js` setting `window.JEV_API_BASE` to the
  server URL and add the Vercel origin to `ALLOWED_ORIGINS` on the server (CORS for `/api/*`; `/ws` has no origin check).
- Shares the box with holo-card-agent (`:8787`, nginx default server on :80). Its Blender renders saturate both cores
  for minutes; this unit has `CPUWeight=300` so game ticks win that contest. Disk: holo prunes old orders itself;
  this service writes only small JSON + logs under `data/`.
- Termix hosting is **not enabled yet**: `.env.local` has no `WALLET_KEY` / `A2A_AGENT_ID`, so `serve` runs the play
  server only (codes minted with `npm run code -- mint N` as `jevbuddy`). To sell: put a hot-wallet key in
  `.env.local`, `npm run setup -- mint …` / `agents` / `listing`, set `A2A_AGENT_ID`, restart. Only one host per agent id.

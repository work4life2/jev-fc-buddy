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

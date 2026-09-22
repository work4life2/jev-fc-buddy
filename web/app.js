/* Jev FC Buddy — play page. Vanilla JS: jsnes runs the game in the browser; the server runs the AI
   that holds controller 2 (each "act" names its controller: menu taps may go to controller 1). The browser reports RAM at a fixed rate and applies the AI's inputs. */
(() => {
  const $ = (id) => document.getElementById(id);
  const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };
  const state = { code: null, coins: 0, games: [], game: null, session: null, ws: null, nes: null, running: false, muted: false, padIndex: null, lang: "en", obsHz: 12 };

  // Where the API lives. Same origin when the server serves this page; when the page is hosted
  // elsewhere (Vercel), /config.js sets window.JEV_API_BASE to the server's https URL.
  const API_BASE = (window.JEV_API_BASE || "").replace(/\/+$/, "");
  const WS_BASE = API_BASE ? API_BASE.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

  // ───────────────────────── gate ─────────────────────────
  const params = new URLSearchParams(location.search);
  if (params.get("code")) $("codeInput").value = params.get("code");

  async function api(path, body) {
    const res = await fetch(API_BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadGames() {
    const { games, sessionMinutes, observeHz } = await api("/api/games");
    state.games = games;
    state.sessionMinutes = sessionMinutes;
    if (observeHz) state.obsHz = observeHz;
    const box = $("games");
    box.innerHTML = "";
    for (const g of games) {
      const el = document.createElement("div");
      el.className = "game";
      el.dataset.id = g.id;
      el.innerHTML = `<div class="t">${g.title}</div><div class="l">${g.system.toUpperCase()} · 2P co-op</div>`;
      el.onclick = () => {
        [...box.children].forEach((c) => c.classList.remove("sel"));
        el.classList.add("sel");
        state.game = g;
        $("btnStart").disabled = false;
      };
      box.appendChild(el);
    }
    const wanted = [...box.children].find((c) => c.dataset.id === params.get("game")); // testing aid: ?game=<id>
    if (wanted) wanted.click();
    else if (games.length === 1) box.firstChild.click();
  }

  $("redeemForm").onsubmit = async (e) => {
    e.preventDefault();
    $("gateError").hidden = true;
    try {
      const r = await api("/api/redeem", { code: $("codeInput").value.trim() });
      state.code = r.code;
      state.coins = r.remaining;
      $("redeemResult").hidden = false;
      const left = r.active ? Math.max(1, Math.round(r.active.secondsLeft / 60)) : 0;
      $("redeemResult").textContent = r.active
        ? `${r.code} · your clock is running: about ${left} min left on this coin · ${r.remaining} of ${r.coins} coin${r.coins > 1 ? "s" : ""} still unused`
        : `${r.code} · ${r.remaining} of ${r.coins} coin${r.coins > 1 ? "s" : ""} left · ${r.sessionMinutes} min of play per coin`;
      await loadGames();
      $("gamePick").hidden = false;
      $("btnStart").textContent = r.active ? "RESUME \u25B6" : "INSERT COIN \u25B6";
      if (r.active) {
        const el = [...$("games").children].find((c) => c.dataset.id === r.active.gameId);
        if (el) el.click();
      }
      if (r.remaining <= 0 && !r.active) $("btnStart").disabled = true;
      else if (params.get("auto") === "1" && state.game) startSession(); // testing aid: spends a coin on load
    } catch (err) {
      $("gateError").hidden = false;
      $("gateError").textContent = err.message;
    }
  };
  if (params.get("code")) $("redeemForm").requestSubmit();

  $("btnStart").onclick = () => startSession();
  $("btnAgain").onclick = () => startSession();
  $("btnBack").onclick = () => location.href = `${location.pathname}?code=${encodeURIComponent(state.code || "")}`;
  $("btnQuit").onclick = () => { if (state.ws) state.ws.send(JSON.stringify({ type: "quit" })); showOverlay("PAUSED", "Your clock keeps running until the coin's time is up. Come back with the same code to continue."); };
  $("btnMute").onclick = () => { state.muted = !state.muted; $("btnMute").textContent = state.muted ? "🔇" : "🔊"; };
  $("btnAgain").addEventListener("click", () => { for (const b of Object.values(padEls)) b.classList.remove("lit", "turbo"); });

  // Gamepad detection on the gate page too, so the mapping can be set before the first coin.
  window.addEventListener("gamepadconnected", (e) => { if (!state.nes) onPad(e.gamepad); });

  // ───────────────────────── session ─────────────────────────
  async function startSession() {
    $("gateError").hidden = true;
    try {
      const s = await api("/api/sessions", { code: state.code, gameId: state.game.id, lang: state.lang });
      state.session = s;
      state.coins = s.remaining;
      $("overlay").hidden = true;
      $("gate").hidden = true;
      $("play").hidden = false;
      $("hud").hidden = false;
      $("hudGame").textContent = s.game.title;
      $("hudCoins").textContent = `🪙 ${s.remaining} left`;
      if (s.resumed) pushOp("system", "resumed: your coin's clock was already running", "");
      state.obsRanges = s.game.ramRanges;
      if (!state.nes) await bootEmulator(s);
      connect(s);
    } catch (err) {
      $("gateError").hidden = false;
      $("gateError").textContent = err.message;
      if ($("play").hidden === false) showOverlay("NO COINS LEFT", err.message);
    }
  }

  function showOverlay(title, text) {
    $("overlayTitle").textContent = title;
    $("overlayText").textContent = text;
    $("overlay").hidden = false;
    $("btnAgain").disabled = state.coins <= 0 && !(state.expiresAt && state.expiresAt > Date.now());
  }

  function connect(s) {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    const ws = new WebSocket(`${WS_BASE}/ws?token=${s.token}`);
    state.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", lang: state.lang })); pushOp("system", "connected", ""); };
    ws.onmessage = (ev) => onServer(JSON.parse(ev.data));
    ws.onclose = () => pushOp("system", "disconnected", "");
  }

  const aiHeld = new Set();
  const aiTurbo = new Set();
  let aiController = 0; // controller the current act targets (menu taps may use a different one)
  let frameNo = 0;

  function onServer(m) {
    switch (m.type) {
      case "session":
        state.expiresAt = new Date(m.expiresAt).getTime();
        $("hudCoins").textContent = `🪙 ${m.remaining} left`;
        break;
      case "status":
        $("hudJev").textContent = m.jev ? "JEV ● ONLINE" : "JEV ○ OFFLINE";
        $("hudJev").className = m.jev ? "on" : "";
        $("hudJev").title = `phase: ${m.phase}`;
        break;
      case "act":
        if (m.controller && m.controller !== aiController) {
          // switching controllers: let go of everything on the old one first
          if (aiController && state.nes) for (let b = 0; b < 8; b++) state.nes.buttonUp(aiController, b);
          aiController = m.controller;
        }
        aiHeld.clear(); aiTurbo.clear();
        for (const b of m.hold) aiHeld.add(BTN[b]);
        for (const b of m.turbo) aiTurbo.add(BTN[b]);
        padShow(m);
        break;
      case "op":
        pushOp(m.src, m.text, m.detail ? Object.values(m.detail).filter((v) => typeof v === "string").join(" ") : "");
        break;
      case "expired":
        aiHeld.clear(); aiTurbo.clear();
        for (const b of Object.values(padEls)) b.classList.remove("lit", "turbo");
        if (m.reason === "time is up") { state.expiresAt = 0; showOverlay("TIME'S UP", "This coin is spent. Insert another coin to keep playing: the game stays exactly where it is."); }
        else if (m.reason === "resumed in another tab") showOverlay("TAKEN OVER", "This code was just used in another tab or browser. Only one session per coin can run at a time.");
        else showOverlay("PAUSED", m.reason);
        break;
    }
  }
  function ws_send(o) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); }

  // ───────────────────────── side panel: PAD (controller + rising moves) or LOG (text) ─────────────────────────
  const VIEW_KEY = "fcbuddy.view";
  function setView(v) {
    const pad = v !== "log";
    $("padView").hidden = !pad;
    $("logView").hidden = pad;
    $("viewPad").classList.toggle("on", pad);
    $("viewLog").classList.toggle("on", !pad);
    $("viewPad").setAttribute("aria-selected", String(pad));
    $("viewLog").setAttribute("aria-selected", String(!pad));
    localStorage.setItem(VIEW_KEY, pad ? "pad" : "log");
  }
  $("viewPad").onclick = () => setView("pad");
  $("viewLog").onclick = () => setView("log");
  setView(localStorage.getItem(VIEW_KEY) || "pad");

  // Only the AI's own controller and only UP/DOWN/LEFT/RIGHT/A/B are shown (menu taps on the other controller are not).
  const PAD_SHOWN = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B"];
  const ARROW = { UP: "▲", DOWN: "▼", LEFT: "◀", RIGHT: "▶" };
  const padEls = {};
  for (const el of document.querySelectorAll("#controller [data-b]")) padEls[el.dataset.b] = el;
  let lastNoteKey = "";
  let lastNoteAt = 0;
  function padShow(m) {
    const aiPad = state.session ? state.session.game.players.ai : 2;
    if (m.controller && m.controller !== aiPad) return;
    const hold = (m.hold || []).filter((b) => PAD_SHOWN.includes(b));
    const turbo = (m.turbo || []).filter((b) => PAD_SHOWN.includes(b));
    for (const b of PAD_SHOWN) {
      const el = padEls[b];
      if (!el) continue;
      el.classList.toggle("lit", hold.includes(b) || turbo.includes(b));
      el.classList.toggle("turbo", turbo.includes(b));
    }
    if (!hold.length && !turbo.length) return; // a release is not a move
    if ($("padView").hidden) return;
    const key = hold.join(",") + "|" + turbo.join(",");
    const now = performance.now();
    if (key === lastNoteKey && now - lastNoteAt < 250) return; // debounce jitter between identical acts
    lastNoteKey = key; lastNoteAt = now;
    const lane = $("lane");
    const parts = [];
    for (const b of ["UP", "DOWN", "LEFT", "RIGHT"]) if (hold.includes(b) || turbo.includes(b)) parts.push(`<span class="arrow">${ARROW[b]}</span>`);
    for (const b of ["B", "A"]) if (hold.includes(b) || turbo.includes(b)) parts.push(`<span class="btn${turbo.includes(b) ? " turbo" : ""}">${b}</span>`);
    const why = m.src === "jev" ? "JEV" : m.src === "reflex" ? "REFLEX" : (m.src || "").toUpperCase();
    const el = document.createElement("div");
    el.className = `note ${m.src || ""}`;
    el.innerHTML = parts.join('<span class="plus">+</span>') + (why ? `<span class="why">${why}</span>` : "");
    el.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 120)}px`);
    el.style.setProperty("--h", `${Math.max(120, lane.clientHeight - 20)}px`);
    lane.appendChild(el);
    while (lane.children.length > 24) lane.removeChild(lane.firstChild);
    setTimeout(() => el.remove(), 2700);
  }

  // ───────────────────────── log view ─────────────────────────
  let opCount = 0;
  function stamp() { const d = new Date(); return d.toTimeString().slice(3, 8) + "." + String(d.getMilliseconds()).padStart(3, "0").slice(0, 1); }
  function pushOp(src, text, extra) {
    const box = $("danmaku");
    const el = document.createElement("div");
    el.className = `d ${src}`;
    el.innerHTML = `<span class="tag ${src}">${src}</span><span class="k">${escapeHtml(text)}</span>${extra ? `<span class="r">${escapeHtml(extra)}</span>` : ""}<span class="t">${stamp()}</span>`;
    box.appendChild(el);
    while (box.children.length > 80) box.removeChild(box.firstChild);
    $("streamCount").textContent = `· ${++opCount}`;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }

  // ───────────────────────── emulator ─────────────────────────
  async function bootEmulator(s) {
    const canvas = $("screen");
    const ctx = canvas.getContext("2d");
    const image = ctx.getImageData(0, 0, 256, 240);
    const buf = new ArrayBuffer(image.data.length);
    const buf8 = new Uint8ClampedArray(buf);
    const buf32 = new Uint32Array(buf);
    for (let i = 0; i < buf32.length; i++) buf32[i] = 0xff000000;

    // audio ring buffer
    const AC = window.AudioContext || window.webkitAudioContext;
    const audio = AC ? new AC() : null;
    const ring = new Float32Array(8192 * 2);
    let rw = 0, rr = 0;
    if (audio) {
      const node = audio.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => {
        const l = e.outputBuffer.getChannelData(0), r = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < l.length; i++) {
          if (rr === rw || state.muted) { l[i] = 0; r[i] = 0; continue; }
          l[i] = ring[rr]; r[i] = ring[rr + 1]; rr = (rr + 2) % ring.length;
        }
      };
      node.connect(audio.destination);
      document.addEventListener("click", () => audio.resume(), { once: true });
    }

    const nes = new jsnes.NES({
      onFrame(fb) {
        for (let i = 0; i < 256 * 240; i++) buf32[i] = 0xff000000 | fb[i];
        image.data.set(buf8);
        ctx.putImageData(image, 0, 0);
      },
      onAudioSample(l, r) {
        const next = (rw + 2) % ring.length;
        if (next === rr) return; // full
        ring[rw] = l; ring[rw + 1] = r; rw = next;
      },
      sampleRate: audio ? audio.sampleRate : 44100,
    });
    state.nes = nes;
    const rom = await fetch(`${API_BASE}/api/games/${s.game.id}/rom?token=${s.token}`);
    if (!rom.ok) throw new Error("could not load the game");
    const bytes = new Uint8Array(await rom.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    nes.loadROM(bin);
    state.running = true;
    pushOp("system", `${s.game.title} loaded · you are P${s.game.players.human}, AI is P${s.game.players.ai}`, "");
    setupInput(s.game);
    loop();
    setInterval(report, 1000 / state.obsHz);
    setInterval(tickHud, 1000);
  }

  let last = performance.now();
  function loop() {
    requestAnimationFrame(loop);
    if (!state.running) return;
    const now = performance.now();
    let frames = Math.min(4, Math.floor((now - last) / (1000 / 60)));
    if (frames <= 0) return;
    last += frames * (1000 / 60);
    if (now - last > 200) last = now;
    while (frames-- > 0) {
      applyAi();
      pollGamepad();
      state.nes.frame();
      frameNo++;
    }
  }

  function applyAi() {
    const nes = state.nes, c = aiController || state.session.game.players.ai;
    for (let b = 0; b < 8; b++) {
      let down = aiHeld.has(b);
      if (aiTurbo.has(b)) down = (frameNo >> 2) & 1; // 7.5 presses per second
      if (down) nes.buttonDown(c, b); else nes.buttonUp(c, b);
    }
  }

  function report() {
    if (!state.running || !state.ws || state.ws.readyState !== 1) return;
    const mem = state.nes.cpu.mem;
    let total = 0;
    for (const [a, b] of state.obsRanges) total += b - a;
    const out = new Uint8Array(total);
    let o = 0;
    for (const [a, b] of state.obsRanges) { out.set(mem.slice(a, b) /* jsnes 1.x: plain Array, 2.x: Uint8Array */, o); o += b - a; }
    let bin = "";
    for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
    ws_send({ type: "obs", ram: btoa(bin) });
  }

  function tickHud() {
    if (!state.expiresAt) return;
    const left = Math.max(0, state.expiresAt - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $("hudTime").textContent = `⏱ ${m}:${String(s).padStart(2, "0")}`;
  }

  // ───────────────────────── human input ─────────────────────────
  // Keyboard: WASD move · J fire · K jump · Enter start · Shift select (arrows / Z / X also work).
  const KEYS = {
    KeyW: BTN.UP, KeyS: BTN.DOWN, KeyA: BTN.LEFT, KeyD: BTN.RIGHT, KeyJ: BTN.B, KeyK: BTN.A,
    ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT, KeyZ: BTN.B, KeyX: BTN.A,
    Enter: BTN.START, ShiftRight: BTN.SELECT, ShiftLeft: BTN.SELECT,
  };
  function setupInput(game) {
    const c = game.players.human;
    window.addEventListener("keydown", (e) => { if (e.code in KEYS && !mapping.capturing) { state.nes.buttonDown(c, KEYS[e.code]); e.preventDefault(); } });
    window.addEventListener("keyup", (e) => { if (e.code in KEYS) { state.nes.buttonUp(c, KEYS[e.code]); e.preventDefault(); } });
    window.addEventListener("gamepadconnected", (e) => onPad(e.gamepad));
    window.addEventListener("gamepaddisconnected", () => { state.padIndex = null; $("hudPad").textContent = "⌨ KEYBOARD"; });
    // Some browsers only surface an already-plugged pad once it is polled.
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gps) if (gp) onPad(gp);
  }
  function onPad(gp) {
    state.padIndex = gp.index;
    state.padId = gp.id;
    mapping.current = loadMapping(gp.id);
    $("hudPad").textContent = `🎮 ${gp.id.slice(0, 18).toUpperCase()}`;
    $("btnMap").hidden = false;
    pushOp("system", "gamepad connected", `${gp.id.slice(0, 40)}${mapping.current.custom ? " · custom mapping" : " · standard mapping"}`);
  }

  // ───────────────────────── gamepad mapping (per gamepad id, in localStorage) ─────────────────────────
  const NES_ORDER = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "START", "SELECT"];
  const NES_LABEL = { UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right", A: "A · jump", B: "B · fire", START: "Start", SELECT: "Select" };
  // A binding is {t:"b", i} (button) or {t:"a", i, d} (axis index, direction). Several bindings per NES button.
  const DEFAULT_MAP = {
    UP: [{ t: "b", i: 12 }, { t: "a", i: 1, d: -1 }], DOWN: [{ t: "b", i: 13 }, { t: "a", i: 1, d: 1 }],
    LEFT: [{ t: "b", i: 14 }, { t: "a", i: 0, d: -1 }], RIGHT: [{ t: "b", i: 15 }, { t: "a", i: 0, d: 1 }],
    A: [{ t: "b", i: 0 }, { t: "b", i: 3 }], B: [{ t: "b", i: 2 }, { t: "b", i: 1 }, { t: "b", i: 5 }, { t: "b", i: 7 }],
    START: [{ t: "b", i: 9 }], SELECT: [{ t: "b", i: 8 }],
  };
  const mapping = { current: { map: DEFAULT_MAP, custom: false }, capturing: null, snapshot: null };
  const mapKey = (id) => `fcbuddy.padmap.${id}`;
  function loadMapping(id) {
    try {
      const saved = JSON.parse(localStorage.getItem(mapKey(id)) || "null");
      if (saved && typeof saved === "object") return { map: { ...DEFAULT_MAP, ...saved }, custom: true };
    } catch (_) { /* ignore */ }
    return { map: DEFAULT_MAP, custom: false };
  }
  function saveMapping() {
    if (!state.padId) return;
    localStorage.setItem(mapKey(state.padId), JSON.stringify(mapping.current.map));
    mapping.current.custom = true;
  }
  function bindingLabel(list) {
    return (list || []).map((b) => (b.t === "b" ? `B${b.i}` : `axis${b.i}${b.d > 0 ? "+" : "−"}`)).join(", ") || "—";
  }
  function bindingActive(gp, b) {
    if (b.t === "b") return Boolean(gp.buttons[b.i] && gp.buttons[b.i].pressed);
    const v = gp.axes[b.i] || 0;
    return b.d > 0 ? v > 0.5 : v < -0.5;
  }
  function renderMapPanel() {
    const rows = $("mapRows");
    rows.innerHTML = "";
    for (const n of NES_ORDER) {
      const row = document.createElement("div");
      row.className = "mapRow";
      row.dataset.nes = n;
      row.innerHTML = `<span class="mapName">${NES_LABEL[n]}</span><span class="mapBind">${bindingLabel(mapping.current.map[n])}</span><button class="ghost mapSet" data-nes="${n}">${mapping.capturing === n ? "press a button…" : "Set"}</button>`;
      rows.appendChild(row);
    }
    $("mapPad").textContent = state.padId ? `${state.padId.slice(0, 48)}${mapping.current.custom ? " · saved custom mapping" : " · standard mapping"}` : "no gamepad connected — press any button on it";
  }
  const openMap = () => { $("mapPanel").hidden = false; renderMapPanel(); };
  $("btnMap").onclick = openMap;
  $("btnMapGate").onclick = openMap;
  // On the gate page there is no emulator loop yet, so poll the pad while the panel is open.
  setInterval(() => { if (!$("mapPanel").hidden && !state.nes) pollGamepad(); }, 50);
  $("btnMapClose").onclick = () => { $("mapPanel").hidden = true; mapping.capturing = null; };
  $("btnMapReset").onclick = () => { if (state.padId) localStorage.removeItem(mapKey(state.padId)); mapping.current = { map: DEFAULT_MAP, custom: false }; renderMapPanel(); };
  $("mapRows").addEventListener("click", (e) => {
    const n = e.target.dataset && e.target.dataset.nes;
    if (!n) return;
    const gp = state.padIndex !== null && navigator.getGamepads()[state.padIndex];
    if (!gp) return;
    mapping.capturing = n;
    mapping.snapshot = { buttons: gp.buttons.map((b) => b.pressed), axes: [...gp.axes] };
    renderMapPanel();
  });
  /** While capturing: the first button press / axis push that was not already active becomes the binding. */
  function captureFrom(gp) {
    const snap = mapping.snapshot;
    for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i].pressed && !snap.buttons[i]) return { t: "b", i };
    for (let i = 0; i < gp.axes.length; i++) {
      const v = gp.axes[i], was = snap.axes[i] || 0;
      if (v > 0.6 && was <= 0.6) return { t: "a", i, d: 1 };
      if (v < -0.6 && was >= -0.6) return { t: "a", i, d: -1 };
    }
    return null;
  }

  const padPrev = new Array(8).fill(false);
  function pollGamepad() {
    if (state.padIndex === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[state.padIndex];
    if (!gp) return;
    if (mapping.capturing) {
      const b = captureFrom(gp);
      if (b) {
        const nes = mapping.capturing;
        mapping.current.map = { ...mapping.current.map, [nes]: [b] };
        mapping.capturing = null;
        saveMapping();
        renderMapPanel();
        pushOp("system", `gamepad: ${NES_LABEL[nes]} → ${bindingLabel([b])}`, "");
      }
      return; // do not feed the game while assigning
    }
    if (!state.nes || !state.session) return;
    const c = state.session.game.players.human;
    const m = mapping.current.map;
    const now = [
      (m.A || []).some((b) => bindingActive(gp, b)),
      (m.B || []).some((b) => bindingActive(gp, b)),
      (m.SELECT || []).some((b) => bindingActive(gp, b)),
      (m.START || []).some((b) => bindingActive(gp, b)),
      (m.UP || []).some((b) => bindingActive(gp, b)),
      (m.DOWN || []).some((b) => bindingActive(gp, b)),
      (m.LEFT || []).some((b) => bindingActive(gp, b)),
      (m.RIGHT || []).some((b) => bindingActive(gp, b)),
    ];
    for (let i = 0; i < 8; i++) {
      if (now[i] === padPrev[i]) continue;
      padPrev[i] = now[i];
      if (now[i]) state.nes.buttonDown(c, i); else state.nes.buttonUp(c, i);
    }
  }
})();

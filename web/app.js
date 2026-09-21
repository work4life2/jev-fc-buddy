/* Jev FC Buddy — play page. Vanilla JS: jsnes runs the game in the browser; the server runs the AI
   that holds controller 2. The browser reports RAM at a fixed rate and applies the AI's inputs. */
(() => {
  const $ = (id) => document.getElementById(id);
  const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };
  const state = { code: null, coins: 0, games: [], game: null, session: null, ws: null, nes: null, running: false, muted: false, padIndex: null, lang: navigator.language || "en", obsHz: 12 };

  // ───────────────────────── gate ─────────────────────────
  const params = new URLSearchParams(location.search);
  if (params.get("code")) $("codeInput").value = params.get("code");

  async function api(path, body) {
    const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadGames() {
    const { games, sessionMinutes } = await api("/api/games");
    state.games = games;
    state.sessionMinutes = sessionMinutes;
    const box = $("games");
    box.innerHTML = "";
    for (const g of games) {
      const el = document.createElement("div");
      el.className = "game";
      el.innerHTML = `<div class="t">${g.title}</div><div class="l">${g.titleLocal || ""} · ${g.system.toUpperCase()} · 2P co-op</div>`;
      el.onclick = () => {
        [...box.children].forEach((c) => c.classList.remove("sel"));
        el.classList.add("sel");
        state.game = g;
        $("btnStart").disabled = false;
      };
      box.appendChild(el);
    }
    if (games.length === 1) box.firstChild.click();
  }

  $("redeemForm").onsubmit = async (e) => {
    e.preventDefault();
    $("gateError").hidden = true;
    try {
      const r = await api("/api/redeem", { code: $("codeInput").value.trim() });
      state.code = r.code;
      state.coins = r.remaining;
      $("redeemResult").hidden = false;
      $("redeemResult").textContent = `${r.code} · ${r.remaining} of ${r.coins} coin${r.coins > 1 ? "s" : ""} left · ${r.sessionMinutes} min per coin`;
      await loadGames();
      $("gamePick").hidden = false;
      if (r.remaining <= 0) $("btnStart").disabled = true;
      else if (params.get("auto") === "1" && state.game) startSession(); // testing aid: spends a coin on load
    } catch (err) {
      $("gateError").hidden = false;
      $("gateError").textContent = err.message;
    }
  };
  if (params.get("code")) $("redeemForm").requestSubmit();

  $("btnStart").onclick = () => startSession();
  $("btnAgain").onclick = () => startSession();
  $("btnBack").onclick = () => location.href = `/?code=${encodeURIComponent(state.code || "")}`;
  $("btnQuit").onclick = () => { if (state.ws) state.ws.send(JSON.stringify({ type: "quit" })); showOverlay("Session ended", "Thanks for playing. Insert another coin to continue where you left off."); };
  $("btnMute").onclick = () => { state.muted = !state.muted; $("btnMute").textContent = state.muted ? "🔇" : "🔊"; };

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
      $("hudGame").textContent = `${s.game.title}${s.game.titleLocal ? " · " + s.game.titleLocal : ""}`;
      $("hudCoins").textContent = `🪙 ${s.remaining} left`;
      state.obsRanges = s.game.ramRanges;
      if (!state.nes) await bootEmulator(s);
      connect(s);
    } catch (err) {
      $("gateError").hidden = false;
      $("gateError").textContent = err.message;
      if ($("play").hidden === false) showOverlay("No coins left", err.message);
    }
  }

  function showOverlay(title, text) {
    $("overlayTitle").textContent = title;
    $("overlayText").textContent = text;
    $("overlay").hidden = false;
    $("btnAgain").disabled = state.coins <= 0;
  }

  function connect(s) {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${s.token}`);
    state.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", lang: state.lang })); pushOp("system", "connected", ""); };
    ws.onmessage = (ev) => onServer(JSON.parse(ev.data));
    ws.onclose = () => pushOp("system", "disconnected", "");
  }

  const aiHeld = new Set();
  const aiTurbo = new Set();
  let frameNo = 0;

  function onServer(m) {
    switch (m.type) {
      case "session":
        state.expiresAt = new Date(m.expiresAt).getTime();
        $("hudCoins").textContent = `🪙 ${m.remaining} left`;
        break;
      case "status":
        $("hudJev").textContent = m.jev ? "Jev ● online" : "Jev ○ offline";
        $("hudJev").className = m.jev ? "on" : "";
        $("hudJev").title = `coach: ${m.coach} · phase: ${m.phase}`;
        break;
      case "act":
        aiHeld.clear(); aiTurbo.clear();
        for (const b of m.hold) aiHeld.add(BTN[b]);
        for (const b of m.turbo) aiTurbo.add(BTN[b]);
        break;
      case "op":
        pushOp(m.src, m.text, m.detail ? Object.values(m.detail).filter((v) => typeof v === "string").join(" ") : "");
        break;
      case "say":
        pushSay(m.text);
        fly(m.text);
        break;
      case "needShot":
        ws_send({ type: "shot", jpeg: $("screen").toDataURL("image/jpeg", 0.6).split(",")[1] });
        break;
      case "expired":
        aiHeld.clear(); aiTurbo.clear();
        showOverlay(m.reason === "time is up" ? "Time's up ⏱" : "Session ended", m.reason === "time is up" ? "This coin is spent. Insert another coin to keep playing — the game stays exactly where it is." : m.reason);
        break;
    }
  }
  function ws_send(o) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(o)); }

  // ───────────────────────── danmaku ─────────────────────────
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
  function pushSay(text) {
    const box = $("danmaku");
    const el = document.createElement("div");
    el.className = "d say";
    el.innerHTML = `💬 ${escapeHtml(text)}<span class="t">${stamp()}</span>`;
    box.appendChild(el);
    while (box.children.length > 80) box.removeChild(box.firstChild);
  }
  function fly(text) {
    const layer = $("flyLayer");
    const el = document.createElement("div");
    el.className = "f";
    el.textContent = text;
    el.style.top = `${8 + Math.random() * 60}%`;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 9500);
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
    const rom = await fetch(`/api/games/${s.game.id}/rom?token=${s.token}`);
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
    const nes = state.nes, c = state.session.game.players.ai;
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
    for (const [a, b] of state.obsRanges) { out.set(mem.subarray(a, b), o); o += b - a; }
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
  function setupInput(game) {
    const c = game.players.human;
    const keys = { ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT, KeyX: BTN.A, KeyZ: BTN.B, Enter: BTN.START, ShiftRight: BTN.SELECT, ShiftLeft: BTN.SELECT, KeyK: BTN.A, KeyJ: BTN.B };
    window.addEventListener("keydown", (e) => { if (e.code in keys) { state.nes.buttonDown(c, keys[e.code]); e.preventDefault(); } });
    window.addEventListener("keyup", (e) => { if (e.code in keys) { state.nes.buttonUp(c, keys[e.code]); e.preventDefault(); } });
    window.addEventListener("gamepadconnected", (e) => { state.padIndex = e.gamepad.index; $("hudPad").textContent = `🎮 ${e.gamepad.id.slice(0, 24)}`; pushOp("system", "gamepad connected", e.gamepad.id.slice(0, 40)); });
    window.addEventListener("gamepaddisconnected", () => { state.padIndex = null; $("hudPad").textContent = "⌨️ keyboard"; });
  }

  const padPrev = new Array(8).fill(false);
  function pollGamepad() {
    if (state.padIndex === null || !navigator.getGamepads) return;
    const gp = navigator.getGamepads()[state.padIndex];
    if (!gp) return;
    const c = state.session.game.players.human;
    const b = (i) => Boolean(gp.buttons[i] && gp.buttons[i].pressed);
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const now = [
      b(0) || b(3),                 // A (jump)
      b(1) || b(2) || b(5) || b(7), // B (fire)
      b(8),                         // select
      b(9),                         // start
      b(12) || ay < -0.5,           // up
      b(13) || ay > 0.5,            // down
      b(14) || ax < -0.5,           // left
      b(15) || ax > 0.5,            // right
    ];
    for (let i = 0; i < 8; i++) {
      if (now[i] === padPrev[i]) continue;
      padPrev[i] = now[i];
      if (now[i]) state.nes.buttonDown(c, i); else state.nes.buttonUp(c, i);
    }
  }
})();

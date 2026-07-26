/*
 * Chain Reaction — client.
 *
 * Two modes over one renderer:
 *   LOCAL   this tab owns the game; CPU seats think here.
 *   ONLINE  the server owns the game; this tab sends intended moves and
 *           animates the cascades the server broadcasts back.
 *
 * `logical` is the settled truth. `display` lags behind it, stepping through
 * the cascade one wave at a time so the chain is watchable.
 */
(() => {
  "use strict";

  const E = window.ChainEngine;
  const { PLAYERS, SIZES } = E;

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const STORE = {
    room: "cr.room", token: "cr.token", sound: "cr.sound",
    style: "cr.style", name: "cr.name", vibrate: "cr.vibrate", colours: "cr.colours",
    deaf: "cr.deafened"
  };

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} }
  };

  /* ── board look ───────────────────────────────────────────────────────
   *
   * "original" reproduces the Android game this clones. Every number in it was
   * measured off that game's own screenshots (480×800 images, 77.2px cells),
   * not eyeballed:
   *
   *   back      the lattice is drawn twice — once at full size, once shrunk
   *             toward the middle of the board — with a strut joining every
   *             pair of vertices. That makes each cell an open box, and it is
   *             why the depth appears to fan outward from the centre instead of
   *             leaning one fixed way.
   *   orbPlane  orbs sit half way into that box, so they drift off the flat
   *             cell centre by more the further out they are.
   *   gridDim   the whole lattice is the live player's colour at half strength.
   *             Nothing else in the original is coloured, so this is the only
   *             turn indicator it has.
   *   rim       orbs are flat colour through the middle falling to this at the
   *             edge. There is no white highlight — they read as lit from
   *             inside, not polished.
   *
   * "console" is the instrument-panel look this project had before; it runs
   * through the same code with the depth flattened out. It takes the same
   * player-coloured lattice — a fixed slate grid left it with no turn cue at
   * all, since that colour is the only one the original ever gives you.
   *
   * Both share one palette. They used to carry their own, so switching style
   * silently recoloured every player — a seat's colour is its identity and has
   * nothing to do with how the board is drawn.
   */
  const THEMES = {
    original: {
      back: 0.926, orbPlane: 0.963, gridDim: 0.51, line: null,
      orb: 0.233, cluster: 0.095, rim: 0.45, glow: 0, tintCell: false,
      colors: PLAYERS.map(p => p.color)
    },
    console: {
      back: 1, orbPlane: 1, gridDim: 0.51, line: null,
      orb: 0.115, cluster: 0.155, rim: 1, glow: 1.9, tintCell: true,
      colors: PLAYERS.map(p => p.color)
    }
  };

  let boardStyle = store.get(STORE.style) === "console" ? "console" : "original";
  const theme = () => THEMES[boardStyle];

  /* Per-player colour overrides, as the original's preferences screen offers.
     Display-only — the server deals in seat indices and never sees these. */
  function loadColours() {
    try {
      const v = JSON.parse(store.get(STORE.colours) || "[]");
      return Array.from({ length: E.MAX_PLAYERS }, (_, i) =>
        typeof v[i] === "string" && /^#[0-9a-f]{6}$/i.test(v[i]) ? v[i] : null);
    } catch (_) {
      return new Array(E.MAX_PLAYERS).fill(null);
    }
  }
  let colours = loadColours();
  // Who you've chosen not to hear survives a reload — it's a decision about a
  // person, not a per-session setting.
  const initialDeafened = (() => {
    try { return new Set(JSON.parse(store.get("cr.deafened") || "[]")); }
    catch (_) { return new Set(); }
  })();
  const colorOf = p => colours[p] || theme().colors[p];

  const cleanName = s => String(s == null ? "" : s).trim().slice(0, 14);
  let myName = cleanName(store.get(STORE.name));

  /* ── state ───────────────────────────────────────────────────────────── */

  let mode = "local";                       // "local" | "online"
  let logical = null;                       // settled game state
  let display = null;                       // what the canvas is showing
  let pendingWaves = [];                    // cascade waves left to animate
  let travelers = [], waveStart = 0, waveDur = 190, chainShown = 0;
  // The cascade is stepped by this timer, never by the render loop.
  // requestAnimationFrame stops entirely while the tab is hidden, so driving
  // game state from it froze a chain mid-flight until you looked at the page
  // again. setTimeout is throttled in the background but still fires, so a
  // cascade now finishes whether or not anyone is watching.
  let waveTimer = null;
  let animating = false;
  // Whose move is on screen. During a cascade `logical.cur` has already moved
  // on to the next player, but the chain belongs to whoever placed the orb.
  let shownPlayer = -1;
  // Moves can arrive faster than they animate (a CPU replies in 550ms, a long
  // chain takes longer). Queue them so no cascade is ever skipped, and speed up
  // to catch up rather than dropping frames of the chain.
  let moveQueue = [];

  // Seat 1 is you, every other seat defaults to the CPU.
  let localCPU = Array.from({ length: E.MAX_PLAYERS }, (_, i) => i !== 0);
  let localPlayers = 2, localSize = 1;
  let soundOn = store.get(STORE.sound) === "1";
  let vibrateOn = store.get(STORE.vibrate) === "1";

  let roomPlayers = 2, roomSize = 1;
  let net = null, netState = "idle";        // idle | connecting | open | lost
  let mySeat = -1, isHost = false, roomCode = null, seats = [], started = false;
  let retry = 0, retryTimer = null, pingTimer = null;
  // What we're trying to be part of. Replayed on every successful open, because
  // a handshake can fail outright and the intent must survive that.
  let intent = null;

  let cursor = 0, cursorShown = false;

  const CHAT_KEEP = 80;                     // messages held in this tab
  let chatLog = [], chatUnread = 0, chatOpen = false;

  /* ── canvas ──────────────────────────────────────────────────────────── */

  const stage = $("stage"), box = $("boardBox"), canvas = $("board");
  const ctx = canvas.getContext("2d");
  let cw = 0, ch = 0, cell = 0, ox = 0, oy = 0, bcx = 0, bcy = 0;

  const cols = () => display.cols;

  /** Project a board-plane point onto the plane at depth scale `s`. */
  const projX = (x, s) => bcx + (x - bcx) * s;
  const projY = (y, s) => bcy + (y - bcy) * s;

  /** Where cell `i`'s orbs sit: its centre, pushed to the mid-depth plane. */
  const siteX = i => projX(ox + ((i % cols()) + 0.5) * cell, theme().orbPlane);
  const siteY = i => projY(oy + (((i / cols()) | 0) + 0.5) * cell, theme().orbPlane);

  function resize() {
    if (!display) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const C = display.cols, R = display.rows;

    // Square cells, as large as the stage allows. The black margin left over is
    // exactly what the original shows on a screen that isn't its aspect.
    const pad = 10;
    cell = Math.min((rect.width - pad * 2) / C, (rect.height - pad * 2) / R);
    if (!(cell > 0)) return;

    // One spare pixel each side so the outermost lattice line isn't half cut.
    cw = Math.round(cell * C) + 2;
    ch = Math.round(cell * R) + 2;
    ox = 1; oy = 1;
    bcx = ox + (cell * C) / 2;
    bcy = oy + (cell * R) / 2;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    box.style.width = cw + "px";
    box.style.height = ch + "px";
    canvas.style.width = cw + "px";
    canvas.style.height = ch + "px";
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(stage);
  addEventListener("resize", resize);

  /* ── audio / haptics ─────────────────────────────────────────────────── */

  let actx = null;
  function blip(freq, dur, type, vol) {
    if (!soundOn) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const t = actx.currentTime;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.25), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (_) { /* audio unavailable */ }
  }

  function buzz(ms) {
    if (!vibrateOn || !navigator.vibrate) return;
    try { navigator.vibrate(ms); } catch (_) { /* not supported */ }
  }

  /* ── cascade animation ───────────────────────────────────────────────── */

  /** How long the current wave should take — shorter when moves are backing up. */
  function waveMs() {
    if (REDUCED) return 70;
    if (moveQueue.length >= 3) return 80;
    if (moveQueue.length >= 1) return 145;
    return 240;
  }

  function playNextMove() {
    const m = moveQueue.shift();
    if (m) animate(m.idx, m.player, m.waves, m.state);
  }

  /** Show a move: seat the orb, then walk `waves` one at a time. */
  function animate(idx, player, waves, settled) {
    display.count[idx]++;
    display.owner[idx] = player;
    logical = settled;
    pendingWaves = waves.slice();
    chainShown = 0;
    animating = true;
    shownPlayer = player;
    travelers = [];
    blip(660, 0.07, "square", 0.06);
    stepWave();
    syncUI();
  }

  function stopWaveTimer() {
    clearTimeout(waveTimer);
    waveTimer = null;
  }

  function stepWave() {
    stopWaveTimer();
    const wave = pendingWaves.shift();
    if (!wave) { finishAnimation(); return; }

    const { cap, nei } = E.topo(display.cols, display.rows);
    chainShown += wave.length;
    travelers = [];
    for (const i of wave) {
      const ow = display.owner[i];
      display.count[i] -= cap[i];
      if (display.count[i] === 0) display.owner[i] = -1;
      for (const nb of nei[i]) travelers.push({ from: i, to: nb, owner: ow });
    }
    blip(180 + Math.min(wave.length, 8) * 26, 0.16, "sine", 0.11);
    buzz(Math.min(60, 12 + wave.length * 6));
    waveStart = performance.now();
    waveDur = waveMs();
    waveTimer = setTimeout(landWave, waveDur);
    syncUI();
  }

  function landWave() {
    stopWaveTimer();
    for (const t of travelers) {
      display.count[t.to]++;
      display.owner[t.to] = t.owner;
    }
    travelers = [];
    stepWave();
  }

  function finishAnimation() {
    stopWaveTimer();
    animating = false;
    shownPlayer = -1;
    // Snap to the settled board — guards against any drift in a long cascade.
    display = E.cloneState(logical);
    syncUI();
    if (moveQueue.length) { playNextMove(); return; }
    if (logical.over) {
      announce(logical.winner >= 0 ? seatName(logical.winner) + " wins" : "Stalemate");
    } else {
      announce(seatName(logical.cur) + " to place");
      if (mode === "local") maybeLocalCPU();
    }
  }

  /* ── local mode ──────────────────────────────────────────────────────── */

  function newLocalGame() {
    const s = SIZES[localSize];
    logical = E.createState(s.cols, s.rows, localPlayers);
    display = E.cloneState(logical);
    stopWaveTimer();
    pendingWaves = []; travelers = []; animating = false; moveQueue = [];
    cursor = ((s.rows / 2) | 0) * s.cols + ((s.cols / 2) | 0);
    resize(); syncUI();
    announce(seatName(logical.cur) + " to place");
    maybeLocalCPU();
  }

  function maybeLocalCPU() {
    if (mode !== "local" || animating || logical.over || !localCPU[logical.cur]) return;
    const me = logical.cur;
    setTimeout(() => {
      if (mode !== "local" || animating || logical.over || logical.cur !== me || !localCPU[me]) return;
      const m = E.chooseMove(logical, me);
      if (m >= 0) playLocal(m, true);
    }, REDUCED ? 120 : 420);
  }

  function playLocal(idx, byCPU) {
    if (animating || logical.over || !E.isLegal(logical, idx, logical.cur)) return;
    // Tapping during the CPU's think delay would otherwise place its orb for it.
    if (!byCPU && localCPU[logical.cur]) return;
    const player = logical.cur;
    const settled = E.cloneState(logical);
    const res = E.applyMove(settled, idx, player);
    animate(idx, player, res.waves, settled);
  }

  /* ── online mode ─────────────────────────────────────────────────────── */

  function setNet(s) {
    netState = s;
    const el = $("barStatus");
    el.dataset.net = s;
    el.hidden = mode !== "online";
    $("barStatusText").textContent =
      s === "open" ? "connected" : s === "connecting" ? "connecting" : s === "lost" ? "reconnecting" : "offline";
  }

  function connect(want) {
    if (want) intent = want;
    if (net && net.readyState === 1) { sendNet(intent); return; }
    if (net && net.readyState === 0) return;      // handshake already in flight
    setNet("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    net = new WebSocket(proto + "://" + location.host);

    net.onopen = () => {
      retry = 0;
      setNet("open");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sendNet({ type: "ping" }), 25000);
      if (intent) sendNet(intent);
    };
    net.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      onServer(m);
    };
    net.onclose = () => {
      clearInterval(pingTimer);
      if (mode !== "online") { setNet("idle"); return; }
      setNet("lost");
      // Back off and retry. `intent` carries whatever we were doing — creating
      // a room, or reclaiming a seat with its token — so a handshake that never
      // opened is retried rather than silently dropped.
      if (!intent) {
        const code = store.get(STORE.room);
        if (code) intent = { type: "join", code, token: store.get(STORE.token), name: myName };
      }
      const wait = Math.min(8000, 600 * Math.pow(2, retry++));
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, wait);
    };
    net.onerror = () => { /* onclose handles recovery */ };
  }

  function sendNet(msg) {
    if (net && net.readyState === 1) net.send(JSON.stringify(msg));
  }

  function onServer(m) {
    switch (m.type) {
      case "joined": {
        mySeat = m.seat;
        isHost = m.host;
        roomCode = m.code;
        store.set(STORE.room, m.code);
        store.set(STORE.token, m.token);
        // From here on, any reconnect should reclaim this exact seat.
        intent = { type: "join", code: m.code, token: m.token, name: myName };
        location.hash = m.code;
        lobbyMsg("");
        break;
      }
      case "room": {
        seats = m.seats;
        started = m.started;
        // Drop voice links to anyone who has gone; a reconnect re-announces.
        for (const seat of [...peers.keys()]) {
          if (!seats[seat] || !seats[seat].connected) closePeer(seat);
        }
        adoptState(m.state, m.reset);
        break;
      }
      case "move": {
        moveQueue.push(m);
        if (!animating) playNextMove();
        break;
      }
      case "rtc": {
        onRtc(m);
        break;
      }
      case "chat": {
        addChat(m);
        break;
      }
      case "chatlog": {
        chatLog = Array.isArray(m.messages) ? m.messages.slice(-CHAT_KEEP) : [];
        renderChat();
        break;
      }
      case "error": {
        if (m.code === "chat_rate") { chatNote(m.message); break; }
        lobbyMsg(m.message, "bad");
        if (m.code === "no_room" || m.code === "full") {
          store.del(STORE.room); store.del(STORE.token);
          roomCode = null; mySeat = -1;
          syncUI();
        }
        break;
      }
    }
    syncLobby();
  }

  /** Take a server board wholesale (join, resync, restart). */
  function adoptState(st, reset) {
    if (!st) return;
    const shapeChanged = !display || display.cols !== st.cols || display.rows !== st.rows;
    logical = st;
    if (animating && !reset) return;          // let the current cascade land first
    display = E.cloneState(st);
    stopWaveTimer();
    pendingWaves = []; travelers = []; animating = false; moveQueue = [];
    if (shapeChanged) {
      cursor = ((st.rows / 2) | 0) * st.cols + ((st.cols / 2) | 0);
      resize();
    }
    syncUI();
  }

  const myTurn = () =>
    mode === "local"
      ? !localCPU[logical.cur]
      : started && mySeat === logical.cur && netState === "open";

  function play(idx) {
    if (!logical || animating || logical.over) return;
    if (mode === "local") { playLocal(idx); return; }
    if (!myTurn() || !E.isLegal(logical, idx, mySeat)) return;
    sendNet({ type: "move", idx });
  }

  /* ── rendering ───────────────────────────────────────────────────────── */

  /** Scale a #rrggbb toward black by factor f (1 = unchanged). */
  function shade(hex, f) {
    if (f >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    const c = v => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, "0");
    return "#" + c((n >> 16) & 255) + c((n >> 8) & 255) + c(n & 255);
  }

  /** Where each of a cell's orbs sits relative to its site. */
  function orbOffsets(n, cap, i, t) {
    if (n <= 0) return [];
    if (n === 1) return [[0, 0]];             // a lone orb is dead centre
    const R = cell * theme().cluster;
    // Rate is keyed to how many orbs the cell still needs, not to how full it
    // is: one short of critical always spins fastest, and every orb further off
    // halves it. Keying it to the fill fraction left a 2-orb and a 3-orb cell
    // only 1.4x apart, which reads as the same speed.
    const short = Math.max(1, cap - n);       // 1 == one orb from detonating
    // Every cell keeps its own phase, otherwise a board full of pairs rotates in
    // lockstep and reads as one moving object. The index seeds it so a cell's
    // orientation doesn't jump when the board repaints.
    const a0 = (REDUCED ? 0 : (t / 1000) * (6.5 / short))
             + (i % 7) * 0.8976;
    return Array.from({ length: n }, (_, k) => {
      const a = a0 + (k * 2 * Math.PI) / n;
      return [Math.cos(a) * R, Math.sin(a) * R];
    });
  }

  function drawOrb(x, y, r, color) {
    const T = theme();
    // The stops trace the brightness measured straight across a real orb: flat
    // through the middle, rolling off to about half at the rim. No white core —
    // the original's orbs look lit from inside rather than polished.
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(0.5, shade(color, 0.97));
    g.addColorStop(0.75, shade(color, 0.84));
    g.addColorStop(1, shade(color, T.rim));
    ctx.save();
    if (T.glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = r * T.glow; }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** The lattice is the live player's colour — the original's only turn cue. */
  function gridColour() {
    const T = theme();
    if (T.line) return T.line;
    const who = shownPlayer >= 0 ? shownPlayer
              : logical && logical.over ? logical.winner
              : logical ? logical.cur
              : 0;
    return shade(colorOf(who >= 0 ? who : 0), T.gridDim);
  }

  /**
   * Each cell as an open box: the lattice at full size, the same lattice shrunk
   * toward the board centre, and a strut joining every pair of vertices. One
   * flat colour throughout — all the depth comes from the projection.
   */
  function drawGrid(C, R) {
    const s = theme().back;
    const x0 = ox, x1 = ox + C * cell, y0 = oy, y1 = oy + R * cell;

    ctx.strokeStyle = gridColour();
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (const k of s === 1 ? [1] : [1, s]) {
      for (let c = 0; c <= C; c++) {
        const x = projX(ox + c * cell, k);
        ctx.moveTo(x, projY(y0, k));
        ctx.lineTo(x, projY(y1, k));
      }
      for (let r = 0; r <= R; r++) {
        const y = projY(oy + r * cell, k);
        ctx.moveTo(projX(x0, k), y);
        ctx.lineTo(projX(x1, k), y);
      }
    }

    if (s !== 1) {
      for (let c = 0; c <= C; c++) {
        for (let r = 0; r <= R; r++) {
          const x = ox + c * cell, y = oy + r * cell;
          ctx.moveTo(x, y);
          ctx.lineTo(projX(x, s), projY(y, s));
        }
      }
    }
    ctx.stroke();
  }

  /* Paints only — it must never advance the game, or the board stops whenever
     the tab is hidden and requestAnimationFrame goes quiet. */
  function draw(now) {
    requestAnimationFrame(draw);
    if (!display || !cell) return;

    const C = display.cols, R = display.rows;
    const T = theme();
    const { cap } = E.topo(C, R);

    ctx.clearRect(0, 0, cw, ch);
    drawGrid(C, R);

    const orbR = cell * T.orb;
    for (let i = 0; i < display.owner.length; i++) {
      const ow = display.owner[i];
      if (ow === -1) continue;
      const col = colorOf(ow);
      const x = siteX(i), y = siteY(i);

      if (T.tintCell) {
        const gx = ox + (i % C) * cell, gy = oy + (((i / C) | 0)) * cell;
        ctx.fillStyle = col + "14";
        ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        ctx.strokeStyle = col + "44";
        ctx.lineWidth = 1;
        ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
      }

      for (const [dx, dy] of orbOffsets(display.count[i], cap[i], i, now)) {
        drawOrb(x + dx, y + dy, orbR, col);
      }
    }

    if (travelers.length) {
      const k = Math.min(1, (now - waveStart) / waveDur);
      const ease = k * k * (3 - 2 * k);
      for (const t of travelers) {
        drawOrb(siteX(t.from) + (siteX(t.to) - siteX(t.from)) * ease,
                siteY(t.from) + (siteY(t.to) - siteY(t.from)) * ease,
                orbR, colorOf(t.owner));
      }
    }

    if (cursorShown && !animating && logical && !logical.over && myTurn()) {
      const col = colorOf(logical.cur);
      const x0 = ox + (cursor % C) * cell, y0 = oy + (((cursor / C) | 0)) * cell;
      const a = cell * 0.24;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [sx, sy, dx, dy] of [[0,0,1,1],[1,0,-1,1],[0,1,1,-1],[1,1,-1,-1]]) {
        const px = x0 + sx * cell, py = y0 + sy * cell;
        ctx.moveTo(px + dx * a, py); ctx.lineTo(px, py); ctx.lineTo(px, py + dy * a);
      }
      ctx.stroke();
    }
  }
  requestAnimationFrame(draw);

  /* ── input ───────────────────────────────────────────────────────────── */

  /* Placing on pointerdown fires the moment a finger lands, so every scroll
     gesture dropped an orb. Commit on release instead, and only when the
     pointer stayed put — a drag is a scroll, not a tap. */
  const TAP_SLOP = 12;                       // px of travel still counted as a tap
  let press = null;

  canvas.addEventListener("pointerdown", e => {
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });

  // The browser fires this when it takes the gesture over to scroll.
  canvas.addEventListener("pointercancel", () => { press = null; });
  canvas.addEventListener("pointerleave", () => { press = null; });

  canvas.addEventListener("pointerup", e => {
    const p = press;
    press = null;
    if (!p || p.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) return;
    if (!display || animating) return;

    const r = canvas.getBoundingClientRect();
    const c = Math.floor((e.clientX - r.left - ox) / cell);
    const row = Math.floor((e.clientY - r.top - oy) / cell);
    if (c < 0 || c >= display.cols || row < 0 || row >= display.rows) return;
    cursorShown = false;
    play(row * display.cols + c);
  });

  canvas.addEventListener("keydown", e => {
    if (!display) return;
    const C = display.cols, R = display.rows;
    const c = cursor % C, r = (cursor / C) | 0;
    let nc = c, nr = r, used = true;
    switch (e.key) {
      case "ArrowLeft":  nc = Math.max(0, c - 1); break;
      case "ArrowRight": nc = Math.min(C - 1, c + 1); break;
      case "ArrowUp":    nr = Math.max(0, r - 1); break;
      case "ArrowDown":  nr = Math.min(R - 1, r + 1); break;
      case "Enter": case " ": play(cursor); break;
      default: used = false;
    }
    if (used) { e.preventDefault(); cursorShown = true; cursor = nr * C + nc; }
  });
  canvas.addEventListener("blur", () => { cursorShown = false; });

  /* ── UI ──────────────────────────────────────────────────────────────── */

  const live = $("live");
  const announce = msg => { live.textContent = msg; };

  function lobbyMsg(text, tone) {
    const el = $("lobbyMsg");
    el.textContent = text || "";
    el.hidden = !text;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  }

  /** Display name for a seat: whatever that player chose, else the colour name. */
  function seatName(p) {
    const fallback = PLAYERS[p] ? PLAYERS[p].name : "Player " + (p + 1);
    if (mode === "online") {
      const s = seats[p];
      return (s && s.name) || fallback;
    }
    return p === 0 && myName ? myName : fallback;
  }

  function seatInfo(p) {
    if (mode === "local") return { cpu: localCPU[p], connected: true, mine: !localCPU[p] };
    const s = seats[p];
    return s
      ? { cpu: s.cpu, connected: s.connected, mine: p === mySeat }
      : { cpu: false, connected: false, mine: false };
  }

  /** One row per seat, used by both the local setup and the online lobby. */
  function seatRow(p, st) {
    const info = seatInfo(p);
    const row = document.createElement("div");
    row.className = "seat";
    row.style.setProperty("--sc", colorOf(p));
    row.dataset.out = st && !st.alive[p] ? "1" : "0";

    const pip = document.createElement("span"); pip.className = "pip";
    const who = document.createElement("span"); who.className = "who";
    who.textContent = seatName(p) + (mode === "online" && info.mine ? "  (you)" : "");

    let tag;
    if (mode === "local") {
      tag = document.createElement("button");
      tag.type = "button";
      tag.className = "st";
      tag.textContent = localCPU[p] ? "CPU" : "HUMAN";
      tag.setAttribute("aria-label", seatName(p) + ": " + (localCPU[p] ? "CPU" : "human") + ", click to swap");
      tag.onclick = () => { localCPU[p] = !localCPU[p]; syncUI(); maybeLocalCPU(); };
    } else if (isHost && !info.mine && !info.connected) {
      tag = document.createElement("button");
      tag.type = "button";
      tag.className = "st";
      tag.textContent = info.cpu ? "CPU" : "EMPTY";
      tag.title = info.cpu ? "Hand back to a human" : "Fill this seat with the CPU";
      tag.onclick = () => sendNet({ type: "cpu", seat: p, on: !info.cpu });
    } else {
      tag = document.createElement("span");
      tag.className = "st";
      tag.textContent = info.cpu ? "CPU" : info.connected ? "LIVE" : "EMPTY";
    }

    // In voice, every other seat gets its own listen switch.
    if (voiceOn && mode === "online" && p !== mySeat) {
      const ear = document.createElement("button");
      ear.type = "button";
      ear.className = "st ear";
      const hearing = !deafened.has(p);
      ear.dataset.on = hearing ? "1" : "0";
      ear.textContent = hearing ? "🔊" : "🔇";
      ear.title = hearing ? "Mute " + seatName(p) : "Unmute " + seatName(p);
      ear.setAttribute("aria-label", (hearing ? "Mute " : "Unmute ") + seatName(p));
      ear.onclick = () => { setListen(p, deafened.has(p)); syncUI(); };
      row.append(pip, who, ear, tag);
      return row;
    }

    row.append(pip, who, tag);
    return row;
  }

  function syncUI() {
    if (!logical || !display) return;
    const st = logical;

    // syncUI runs on every wave of a cascade. Rebuilding the seat rows that
    // often churns the DOM — and discards the button you may be clicking — for
    // a panel that is closed almost all of the time.
    if (!sheet.hidden) {
      $("localSeats").replaceChildren(
        ...Array.from({ length: st.numPlayers }, (_, p) => seatRow(p, st)));
      if (mode === "online" && roomCode) {
        $("roomSeats").replaceChildren(
          ...Array.from({ length: st.numPlayers }, (_, p) => seatRow(p, st)));
      }
    }

    // The board itself carries the turn; the veil is only for states the
    // original never has to show — no room, no connection, or a finished game.
    let title = "", note = "";
    if (mode === "online" && !roomCode) {
      title = "No room";
      note = "Open the menu to create or join one";
    } else if (mode === "online" && netState !== "open") {
      title = netState === "lost" ? "Reconnecting" : "Connecting";
      note = "Hold on";
    } else if (mode === "online" && !started) {
      const need = seats.filter(s => !s.cpu && !s.connected).length;
      title = "Room " + roomCode;
      note = "Waiting for " + need + " more player" + (need === 1 ? "" : "s");
    } else if (st.over && !animating) {
      // `logical` holds the settled board from the moment the move is made, so
      // without this the result appears over the top of the winning chain and
      // gives it away before it has finished playing.
      title = st.winner >= 0 ? seatName(st.winner) + " wins" : "Stalemate";
      note = mode === "local" ? "Tap to play again" : isHost ? "Restart from the menu" : "";
    }
    $("veil").dataset.on = title ? "1" : "0";
    $("veilTitle").textContent = title;
    $("veilTitle").style.color = st.over && st.winner >= 0 ? colorOf(st.winner) : "#FFFFFF";
    $("veilNote").textContent = note;
  }

  function syncLobby() {
    const on = mode === "online";
    $("onlinePane").hidden = !on;
    $("localPane").hidden = on;
    $("barStatus").hidden = !on;
    if (on) {
      const joined = !!roomCode;
      $("preJoin").hidden = joined;
      $("inRoom").hidden = !joined;
      $("btnRestart").hidden = !(joined && isHost);
      if (joined) $("roomCode").textContent = roomCode;
    }
    syncChat();
    syncVoice();
    syncUI();
  }

  function segment(host, items, isOn, pick) {
    host.replaceChildren(...items.map((label, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-pressed", String(isOn(i)));
      b.onclick = () => pick(i);
      return b;
    }));
  }

  const COUNTS = Array.from({ length: E.MAX_PLAYERS - 1 }, (_, i) => String(i + 2));

  function syncSegments() {
    segment($("segMode"), ["Local", "Online"], i => (i === 1) === (mode === "online"), i => setMode(i === 1 ? "online" : "local"));
    segment($("segPlayers"), COUNTS, i => localPlayers === i + 2, i => { localPlayers = i + 2; syncSegments(); newLocalGame(); });
    segment($("segSize"), SIZES.map(s => s.label), i => localSize === i, i => { localSize = i; syncSegments(); newLocalGame(); });
    segment($("segRoomPlayers"), COUNTS, i => roomPlayers === i + 2, i => { roomPlayers = i + 2; syncSegments(); });
    segment($("segRoomSize"), SIZES.map(s => s.label), i => roomSize === i, i => { roomSize = i; syncSegments(); });
    segment($("segStyle"), ["Original", "Console"], i => (i === 0) === (boardStyle === "original"), i => {
      boardStyle = i === 0 ? "original" : "console";
      store.set(STORE.style, boardStyle);
      syncSegments();
      syncColourRows();
      syncUI();
    });
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    if (next === "online") {
      const hash = (location.hash || "").replace("#", "").toUpperCase().trim();
      const remembered = store.get(STORE.room);
      const target = hash || remembered;
      if (target) connect({ type: "join", code: target, token: store.get(STORE.token), name: myName });
      if (!logical) newLocalGame();
    } else {
      leaveRoom(false);
      newLocalGame();
    }
    setNet(netState);
    syncSegments();
    syncLobby();
  }

  function leaveRoom(reconnectable) {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    stopWaveTimer();
    intent = null;
    moveQueue = [];
    if (net) { net.onclose = null; net.close(); net = null; }
    if (!reconnectable) {
      store.del(STORE.room); store.del(STORE.token);
      if (location.hash) history.replaceState(null, "", location.pathname);
    }
    voiceLeave();
    roomCode = null; mySeat = -1; isHost = false; seats = []; started = false;
    // The log belongs to the room you just left, not to the next one.
    chatLog = []; chatUnread = 0;
    renderChat();
    $("toasts").replaceChildren();
    setChat(false);
    setNet("idle");
  }

  /* ── chat ────────────────────────────────────────────────────────────────
   *
   * Messages are relayed and shown exactly as typed — nothing is filtered or
   * bleeped. They are still written with textContent rather than innerHTML,
   * which is not about the words: text from one player is rendered in everyone
   * else's browser, and building that markup by hand would let anyone in a room
   * run script in the others' tabs.
   */

  const chatPanel = $("chatPanel"), chatLogEl = $("chatLog"), chatInput = $("chatInput");

  /** One rendered line. `text` is null for local notices. */
  function chatLine(entry) {
    const line = document.createElement("div");
    if (entry.sys) {
      line.className = "line sys";
      line.textContent = entry.sys;
      return line;
    }
    line.className = "line";
    line.style.setProperty("--mc", colorOf(entry.seat));
    const who = document.createElement("b");
    who.textContent = entry.name + ": ";
    const what = document.createElement("span");
    what.textContent = entry.text;
    line.append(who, what);
    return line;
  }

  function renderChat() {
    const stuck = chatLogEl.scrollTop + chatLogEl.clientHeight >= chatLogEl.scrollHeight - 24;
    chatLogEl.replaceChildren(...chatLog.map(chatLine));
    if (stuck) chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  /** Float a message over the board so the panel doesn't have to stay open. */
  function toast(entry) {
    if (chatOpen || entry.sys) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.style.setProperty("--mc", colorOf(entry.seat));
    const who = document.createElement("b");
    who.textContent = entry.name + " ";
    const what = document.createElement("span");
    what.textContent = entry.text;
    el.append(who, what);
    const host = $("toasts");
    host.append(el);
    while (host.children.length > 4) host.firstChild.remove();
    setTimeout(() => el.remove(), 7000);
  }

  function addChat(entry) {
    chatLog.push(entry);
    if (chatLog.length > CHAT_KEEP) chatLog.shift();
    renderChat();
    toast(entry);
    if (!chatOpen && entry.seat !== mySeat) { chatUnread++; syncChat(); }
  }

  const chatNote = text => { chatLog.push({ sys: text }); renderChat(); };

  function syncChat() {
    const on = mode === "online" && !!roomCode;
    $("btnChat").hidden = !on;
    if (!on && chatOpen) setChat(false);
    const badge = $("chatBadge");
    badge.hidden = chatUnread === 0;
    badge.textContent = chatUnread > 9 ? "9+" : String(chatUnread);
  }

  function setChat(open) {
    chatOpen = open;
    chatPanel.hidden = !open;
    $("btnChat").setAttribute("aria-expanded", String(open));
    if (open) {
      setMenu(false);                        // they share the same corner
      chatUnread = 0;
      $("toasts").replaceChildren();
      renderChat();
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
      chatInput.focus();
    }
    syncChat();
  }

  $("btnChat").onclick = () => setChat(chatPanel.hidden);
  $("btnChatClose").onclick = () => setChat(false);

  $("chatForm").addEventListener("submit", e => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (netState !== "open" || !roomCode) { chatNote("Not connected to a room."); return; }
    sendNet({ type: "chat", text });
    chatInput.value = "";
  });

  /* ── voice ───────────────────────────────────────────────────────────────
   *
   * Audio is peer-to-peer over WebRTC. The room server only relays the
   * handshake; no audio passes through it and nothing is recorded anywhere.
   *
   * Both ends of a pair need one agreed offerer or they collide, so the rule is
   * simply that the lower seat number always offers. That removes the whole
   * glare problem without a negotiation state machine.
   *
   * Each connection is built with one sendrecv audio transceiver up front, even
   * before a microphone exists. Turning the mic on and off then just swaps a
   * track in and out of that sender, so it never has to renegotiate mid-call.
   *
   * Needs a secure context: HTTPS in production, localhost in development.
   */
  const ICE = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  /**
   * STUN only tells each side its public address; it cannot carry audio. When
   * both players are behind strict NAT there is no direct path and the call
   * fails no matter how long it retries — that pair needs a TURN relay, which
   * has a running cost and so isn't shipped with one.
   *
   * Add one without touching this file:
   *   localStorage["cr.turn"] = JSON.stringify(
   *     { urls: "turn:host:3478", username: "u", credential: "p" })
   *
   * Two peers on one machine behind one router hit exactly this, which is why
   * a same-machine test can't confirm voice works.
   */
  function iceServers() {
    const list = ICE.slice();
    try {
      const t = JSON.parse(store.get("cr.turn") || "null");
      if (t && t.urls) list.push(t);
    } catch (_) { /* malformed override */ }
    return list;
  }

  let voiceOn = false, micOn = false, micStream = null;
  const peers = new Map();                  // seat -> { pc, sender, audio }
  const deafened = initialDeafened;          // seats we've chosen not to hear

  const rtc = (to, kind, data) => sendNet({ type: "rtc", to, kind, data });
  const voiceNote = text => { chatNote(text); };
  const saveDeafened = () => store.set(STORE.deaf, JSON.stringify([...deafened]));

  function peerFor(seat) {
    let p = peers.get(seat);
    if (p) return p;

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.muted = deafened.has(seat);
    $("voiceSinks").append(audio);

    // One transceiver now means the mic can be added later without a new offer.
    const tx = pc.addTransceiver("audio", { direction: "sendrecv" });
    if (micStream) tx.sender.replaceTrack(micStream.getAudioTracks()[0]);

    pc.onicecandidate = e => { if (e.candidate) rtc(seat, "ice", e.candidate); };
    pc.ontrack = e => {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => voiceNote("Click anywhere to allow audio playback."));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        voiceNote("No voice route to " + seatName(seat) +
                  " — that pair needs a TURN relay. Chat still works.");
      }
      syncVoice();
    };

    p = { pc, sender: tx.sender, audio, pending: [] };
    peers.set(seat, p);
    syncVoice();
    return p;
  }

  /* Signalling is ordered on the wire, but onRtc is async — without a queue an
     ICE candidate can be applied while the offer ahead of it is still awaiting,
     and addIceCandidate then throws and the candidate is lost for good. */
  const rtcQueue = new Map();
  function queueRtc(seat, job) {
    const prev = rtcQueue.get(seat) || Promise.resolve();
    const next = prev.then(job, job);
    rtcQueue.set(seat, next.catch(() => {}));
  }

  /* Candidates that outran their description still have to be applied, so they
     wait here rather than being dropped. */
  async function flushCandidates(p) {
    while (p.pending.length) {
      try { await p.pc.addIceCandidate(p.pending.shift()); }
      catch (e) { rtcErr("flush", e); }
    }
  }

  const rtcErrors = [];
  function rtcErr(where, e) {
    rtcErrors.push(where + ": " + (e && e.message ? e.message : String(e)));
    if (rtcErrors.length > 20) rtcErrors.shift();
  }

  function closePeer(seat) {
    const p = peers.get(seat);
    if (!p) return;
    try { p.pc.close(); } catch (_) { /* already gone */ }
    p.audio.srcObject = null;
    p.audio.remove();
    peers.delete(seat);
    syncVoice();
  }

  async function makeOffer(seat) {
    const { pc } = peerFor(seat);
    try {
      await pc.setLocalDescription(await pc.createOffer());
      rtc(seat, "offer", pc.localDescription);
    } catch (e) { rtcErr("offer", e); }
  }

  async function onRtc(m) {
    const seat = m.from;
    if (!voiceOn || seat === mySeat) return;

    if (m.kind === "hello") {                 // someone joined voice
      if (mySeat < seat) makeOffer(seat); else rtc(seat, "here", null);
      return;
    }
    if (m.kind === "here") { if (mySeat < seat) makeOffer(seat); return; }
    if (m.kind === "bye")  { closePeer(seat); return; }

    queueRtc(seat, async () => {
      const p = peerFor(seat);
      const pc = p.pc;
      try {
        if (m.kind === "offer") {
          await pc.setRemoteDescription(m.data);
          await pc.setLocalDescription(await pc.createAnswer());
          rtc(seat, "answer", pc.localDescription);
          await flushCandidates(p);
        } else if (m.kind === "answer") {
          await pc.setRemoteDescription(m.data);
          await flushCandidates(p);
        } else if (m.kind === "ice") {
          // A candidate can legitimately arrive before its description.
          if (!pc.remoteDescription) { p.pending.push(m.data); return; }
          await pc.addIceCandidate(m.data);
        }
      } catch (e) { rtcErr(m.kind, e); }
    });
  }

  function voiceJoin() {
    if (!roomCode || netState !== "open") { voiceNote("Join a room first."); return; }
    if (!window.RTCPeerConnection) { voiceNote("This browser has no WebRTC support."); return; }
    voiceOn = true;
    rtc(null, "hello", null);                 // null = announce to the room
    voiceNote("You joined voice. Your mic is off.");
    syncVoice();
  }

  function voiceLeave() {
    if (!voiceOn) return;
    setMic(false);
    voiceOn = false;
    rtc(null, "bye", null);
    for (const seat of [...peers.keys()]) closePeer(seat);
    voiceNote("You left voice.");
    syncVoice();
  }

  /** Your own microphone. Off until you say otherwise, every time. */
  async function setMic(on) {
    if (on) {
      if (!voiceOn) voiceJoin();
      if (!micStream) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          });
        } catch (_) {
          voiceNote("Microphone unavailable — check the browser's permission for this site.");
          micOn = false; syncVoice();
          return;
        }
      }
      micOn = true;
      const track = micStream.getAudioTracks()[0];
      for (const p of peers.values()) p.sender.replaceTrack(track).catch(() => {});
    } else {
      micOn = false;
      for (const p of peers.values()) p.sender.replaceTrack(null).catch(() => {});
      // Actually release the device, so the browser's recording indicator goes
      // out rather than merely muting a still-open microphone.
      if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    }
    syncVoice();
  }

  /** Whether we hear a given seat. */
  function setListen(seat, on) {
    if (on) deafened.delete(seat); else deafened.add(seat);
    saveDeafened();
    const p = peers.get(seat);
    if (p) p.audio.muted = !on;
    syncVoice();
  }

  function syncVoice() {
    const inRoom = mode === "online" && !!roomCode;
    $("btnMic").hidden = !(inRoom && voiceOn);
    $("btnMic").dataset.live = micOn ? "1" : "0";
    $("btnMic").setAttribute("aria-label", micOn ? "Microphone on" : "Microphone off");
    $("voiceGroup").hidden = !inRoom;
    $("btnVoice").textContent = voiceOn ? "Leave voice" : "Join voice";
    const mic = $("btnMicToggle");
    mic.hidden = !voiceOn;
    mic.textContent = micOn ? "Microphone: on" : "Microphone: off";
    mic.dataset.live = micOn ? "1" : "0";
    const n = [...peers.values()].filter(p => p.pc.connectionState === "connected").length;
    $("voiceState").textContent = voiceOn
      ? (n ? n + " connected" : "waiting for others") : "";
  }

  $("btnVoice").onclick = () => { voiceOn ? voiceLeave() : voiceJoin(); };
  $("btnMicToggle").onclick = () => setMic(!micOn);
  $("btnMic").onclick = () => setMic(!micOn);

  /* ── menu and preferences ────────────────────────────────────────────── */

  const sheet = $("sheet"), scrim = $("scrim"), prefs = $("prefs");

  function setMenu(open) {
    sheet.hidden = !open;
    scrim.hidden = !open;
    $("btnMenu").setAttribute("aria-expanded", String(open));
    if (open) {
      setChat(false);            // they share the same corner
      syncUI();                  // the seat rows are only kept fresh while open
    }
  }
  $("btnMenu").onclick = () => setMenu(sheet.hidden);
  scrim.onclick = () => setMenu(false);
  addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!prefs.hidden) { prefs.hidden = true; return; }
    if (!chatPanel.hidden) { setChat(false); return; }
    setMenu(false);
  });

  $("miNew").onclick = () => {
    setMenu(false);
    if (mode === "local") { newLocalGame(); canvas.focus(); }
    else if (isHost) sendNet({ type: "restart" });
    else lobbyMsg("Only the host can restart the room.", "bad");
  };

  $("miPrefs").onclick = () => { setMenu(false); prefs.hidden = false; };
  $("miRules").onclick = () => {
    setMenu(false);
    prefs.hidden = false;
    prefs.querySelector(".prefBody").scrollTop = prefs.querySelector(".prefBody").scrollHeight;
  };
  $("btnPrefBack").onclick = () => { prefs.hidden = true; };

  /* Per-player colour pickers, mirroring the original's preferences screen. */
  function syncColourRows() {
    $("colourRows").replaceChildren(...Array.from({ length: E.MAX_PLAYERS }, (_, p) => {
      const row = document.createElement("div");
      row.className = "prefRow";
      const txt = document.createElement("span");
      txt.className = "txt";
      const b = document.createElement("b");
      b.textContent = "Player " + (p + 1);
      const s = document.createElement("small");
      s.textContent = colours[p] ? "Custom" : PLAYERS[p].name.toLowerCase();
      txt.append(b, s);

      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = colorOf(p);
      inp.setAttribute("aria-label", "Colour for player " + (p + 1));
      inp.oninput = () => {
        colours[p] = inp.value;
        store.set(STORE.colours, JSON.stringify(colours));
        s.textContent = "Custom";
        syncUI();
      };
      row.append(txt, inp);
      return row;
    }));
  }

  $("btnResetColours").onclick = () => {
    colours = new Array(E.MAX_PLAYERS).fill(null);
    store.del(STORE.colours);
    syncColourRows();
    syncUI();
  };

  const cbSound = $("cbSound"), cbVibrate = $("cbVibrate");
  cbSound.checked = soundOn;
  cbVibrate.checked = vibrateOn;
  cbSound.onchange = () => {
    soundOn = cbSound.checked;
    store.set(STORE.sound, soundOn ? "1" : "0");
    if (soundOn) blip(520, 0.06, "square", 0.05);
  };
  cbVibrate.onchange = () => {
    vibrateOn = cbVibrate.checked;
    store.set(STORE.vibrate, vibrateOn ? "1" : "0");
    if (vibrateOn) buzz(30);
  };

  /* ── wiring ──────────────────────────────────────────────────────────── */

  /* The same name is editable from the lobby and from preferences; whichever
     one you type into, the other has to follow. */
  const nameFields = [$("playerName"), $("playerNameLobby")];
  const showName = () => nameFields.forEach(f => { if (f.value !== myName) f.value = myName; });
  showName();

  function commitName(src) {
    const v = cleanName(src.value);
    if (v === myName) { showName(); return; }
    myName = v;
    store.set(STORE.name, myName);
    // Tell the room, and keep the reconnect intent carrying the new name.
    if (mode === "online" && roomCode) sendNet({ type: "name", name: myName });
    if (intent) intent.name = myName;
    showName();
    syncUI();
  }

  for (const f of nameFields) {
    f.addEventListener("change", () => commitName(f));
    f.addEventListener("blur", () => commitName(f));
    f.addEventListener("keydown", e => {
      if (e.key === "Enter") { commitName(f); f.blur(); }
    });
  }

  // A finished local game restarts straight from the board, no menu trip.
  $("veil").addEventListener("click", () => {
    if (mode === "local" && logical && logical.over) { newLocalGame(); canvas.focus(); }
  });

  $("btnCreate").onclick = () => {
    lobbyMsg("");
    connect({ type: "create", sizeIdx: roomSize, numPlayers: roomPlayers, name: myName });
  };

  $("btnJoin").onclick = () => {
    const code = $("joinCode").value.toUpperCase().trim();
    if (code.length !== 4) { lobbyMsg("Room codes are 4 characters.", "bad"); return; }
    lobbyMsg("");
    connect({ type: "join", code, name: myName });
  };

  $("joinCode").addEventListener("keydown", e => { if (e.key === "Enter") $("btnJoin").click(); });

  $("btnCopy").onclick = async () => {
    const link = location.origin + "/#" + roomCode;
    try {
      await navigator.clipboard.writeText(link);
      $("btnCopy").textContent = "Copied";
    } catch (_) {
      $("btnCopy").textContent = "Copy failed";
    }
    setTimeout(() => { $("btnCopy").textContent = "Copy link"; }, 1600);
  };

  $("btnRestart").onclick = () => sendNet({ type: "restart" });

  $("btnLeave").onclick = () => { leaveRoom(false); syncLobby(); };

  // Opening a shared link drops you straight into online mode.
  addEventListener("hashchange", () => {
    const code = (location.hash || "").replace("#", "").toUpperCase().trim();
    if (code.length === 4 && code !== roomCode) {
      mode = "online";
      syncSegments();
      connect({ type: "join", code, name: myName });
    }
  });

  /* Read-only peek at the animation state. Everything in here is closed over by
     the IIFE, which made a stalled cascade impossible to diagnose from the
     console — this is what finally pinned one down. Cheap; keep it. */
  window.__crDebug = () => ({
    animating, shownPlayer, travelers: travelers.length,
    pendingWaves: pendingWaves.length, moveQueue: moveQueue.length,
    cur: logical && logical.cur, over: logical && logical.over,
    cpu: localCPU.slice(0, logical ? logical.numPlayers : 0),
    waveStart, waveDur, now: performance.now(), cell,
    // Lets the spin rate be measured without waiting on the render loop, which
    // is paused whenever the tab is hidden.
    offsets: orbOffsets,
    voice: {
      voiceOn, micOn, mySeat,
      deafened: [...deafened],
      errors: rtcErrors.slice(),
      handles: [...peers.entries()],        // raw pcs, for getStats() when debugging
      peers: [...peers.entries()].map(([seat, p]) => ({
        seat,
        connection: p.pc.connectionState,
        ice: p.pc.iceConnectionState,
        signaling: p.pc.signalingState,
        hasRemoteAudio: !!p.audio.srcObject,
        muted: p.audio.muted
      }))
    }
  });

  syncSegments();
  syncColourRows();
  newLocalGame();
  syncLobby();

  if ((location.hash || "").replace("#", "").trim().length === 4) setMode("online");
})();

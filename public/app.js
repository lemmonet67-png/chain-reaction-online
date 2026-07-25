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
  const STORE = { room: "cr.room", token: "cr.token", sound: "cr.sound", style: "cr.style" };

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} }
  };

  /* Two board looks. "console" is the instrument-panel treatment; "classic" is
     the arcade one — black ground, extruded green wireframe, glossy orbs.
     Colours are display-only; the server never sees them. */
  const THEMES = {
    console: {
      ground: "linear-gradient(180deg,#0D141B,#0A1016)",
      border: "#1B2733", inset: "inset 0 0 70px rgba(0,0,0,.65)",
      line: "#1B2733", line2: null, depth: 0, lineGlow: 0,
      tint: true, glow: 1.9, shade: 1,
      orb: 0.115, spread: 0.155, gloss: 0.35,
      colors: E.PLAYERS.map(p => p.color)
    },
    classic: {
      ground: "#000000",
      border: "#0B3D0B", inset: "none",
      line: "#1CE81C", line2: "#0A7A0A", depth: 0.11, lineGlow: 5,
      tint: false, glow: 0.45, shade: 0.5,
      orb: 0.155, spread: 0.14, gloss: 0.2,
      colors: ["#FF2020", "#22DD22", "#2B6BFF", "#FFDD00",
               "#FF3BD4", "#22DDDD", "#FF8800", "#A64BFF"]
    }
  };

  const STORE_NAME = "cr.name";
  const cleanName = s => String(s == null ? "" : s).trim().slice(0, 14);
  let myName = cleanName(store.get(STORE_NAME));

  let boardStyle = store.get(STORE.style) === "console" ? "console" : "classic";
  const theme = () => THEMES[boardStyle];
  const colorOf = p => theme().colors[p];

  /* ── state ───────────────────────────────────────────────────────────── */

  let mode = "local";                       // "local" | "online"
  let logical = null;                       // settled game state
  let display = null;                       // what the canvas is showing
  let pendingWaves = [];                    // cascade waves left to animate
  let travelers = [], waveStart = 0, waveDur = 190, shake = 0, chainShown = 0;
  let animating = false;
  // Moves can arrive faster than they animate (a CPU replies in 550ms, a long
  // chain takes longer). Queue them so no cascade is ever skipped, and speed up
  // to catch up rather than dropping frames of the chain.
  let moveQueue = [];

  // Seat 1 is you, every other seat defaults to the CPU.
  let localCPU = Array.from({ length: E.MAX_PLAYERS }, (_, i) => i !== 0);
  let localPlayers = 2, localSize = 1;
  let soundOn = store.get(STORE.sound) === "1";

  let roomPlayers = 2, roomSize = 1;
  let net = null, netState = "idle";        // idle | connecting | open | lost
  let mySeat = -1, isHost = false, roomCode = null, seats = [], started = false;
  let retry = 0, retryTimer = null, pingTimer = null;
  // What we're trying to be part of. Replayed on every successful open, because
  // a handshake can fail outright and the intent must survive that.
  let intent = null;

  let cursor = 0, cursorShown = false;

  /* ── canvas ──────────────────────────────────────────────────────────── */

  const wrap = $("wrap"), canvas = $("board"), ctx = canvas.getContext("2d");
  let cw = 0, ch = 0, cell = 0, ox = 0, oy = 0;

  const cols = () => display.cols, rows = () => display.rows;
  const cx = i => ox + ((i % cols()) + 0.5) * cell;
  const cy = i => oy + (((i / cols()) | 0) + 0.5) * cell;

  function resize() {
    if (!display) return;
    const rect = wrap.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = rect.width; ch = rect.height;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cell = Math.min(cw / cols(), ch / rows());
    ox = (cw - cell * cols()) / 2;
    oy = (ch - cell * rows()) / 2;
  }
  new ResizeObserver(resize).observe(wrap);
  addEventListener("resize", resize);

  /* ── audio ───────────────────────────────────────────────────────────── */

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

  /* ── cascade animation ───────────────────────────────────────────────── */

  /** How long the current wave should take — shorter when moves are backing up. */
  function waveMs() {
    if (REDUCED) return 70;
    if (moveQueue.length >= 3) return 55;
    if (moveQueue.length >= 1) return 110;
    return 190;
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
    travelers = [];
    blip(660, 0.07, "square", 0.06);
    stepWave();
    syncUI();
  }

  function stepWave() {
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
    shake = REDUCED ? 0 : Math.min(5, 1 + wave.length * 0.5);
    blip(180 + Math.min(wave.length, 8) * 26, 0.16, "sine", 0.11);
    waveStart = performance.now();
    waveDur = waveMs();
    syncUI();
  }

  function landWave() {
    for (const t of travelers) {
      display.count[t.to]++;
      display.owner[t.to] = t.owner;
    }
    travelers = [];
    stepWave();
  }

  function finishAnimation() {
    animating = false;
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
    pendingWaves = []; travelers = []; animating = false; moveQueue = [];
    cursor = ((s.rows / 2) | 0) * s.cols + ((s.cols / 2) | 0);
    wrap.style.aspectRatio = s.cols + " / " + s.rows;
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
      if (m >= 0) playLocal(m);
    }, REDUCED ? 120 : 420);
  }

  function playLocal(idx) {
    if (animating || logical.over || !E.isLegal(logical, idx, logical.cur)) return;
    const player = logical.cur;
    const settled = E.cloneState(logical);
    const res = E.applyMove(settled, idx, player);
    animate(idx, player, res.waves, settled);
  }

  /* ── online mode ─────────────────────────────────────────────────────── */

  function setNet(s) {
    netState = s;
    const el = $("netState");
    el.dataset.net = s;
    $("netText").textContent =
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
        adoptState(m.state, m.reset);
        break;
      }
      case "move": {
        moveQueue.push(m);
        if (!animating) playNextMove();
        break;
      }
      case "error": {
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
    pendingWaves = []; travelers = []; animating = false; moveQueue = [];
    if (shapeChanged) {
      wrap.style.aspectRatio = st.cols + " / " + st.rows;
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

  function orbOffsets(n, cap, t) {
    if (n <= 0) return [];
    const R = cell * theme().spread;
    if (n === 1) return [[0, REDUCED ? 0 : Math.sin(t / 620) * cell * 0.012]];
    // Spin faster the closer the cell is to going critical.
    const tension = Math.min(1, (n - 1) / Math.max(1, cap - 1));
    const spin = REDUCED ? 0 : (t / 1000) * (0.7 + tension * 4.2);
    return Array.from({ length: n }, (_, k) => {
      const a = spin + (k * 2 * Math.PI) / n;
      return [Math.cos(a) * R, Math.sin(a) * R];
    });
  }

  /** Darken a #rrggbb toward black by factor f (1 = unchanged). */
  function shade(hex, f) {
    if (f >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    const c = v => Math.round(v * f).toString(16).padStart(2, "0");
    return "#" + c((n >> 16) & 255) + c((n >> 8) & 255) + c(n & 255);
  }

  function drawOrb(x, y, r, color) {
    const T = theme();
    // Highlight offset up-left, colour through the middle, darker at the rim —
    // the rim shading is what reads as a sphere rather than a flat disc.
    const g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.08, x, y, r);
    g.addColorStop(0, "#FFFFFF");
    g.addColorStop(T.gloss, color);
    g.addColorStop(1, shade(color, T.shade));
    ctx.save();
    if (T.glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = r * T.glow; }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Flat lattice, or an extruded wireframe when the theme asks for depth. */
  function drawGrid(C, R) {
    const T = theme();
    const d = T.depth * cell;

    const plane = (dx, dy, color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (let c = 0; c <= C; c++) {
        ctx.moveTo(ox + c * cell + dx, oy + dy);
        ctx.lineTo(ox + c * cell + dx, oy + R * cell + dy);
      }
      for (let r = 0; r <= R; r++) {
        ctx.moveTo(ox + dx, oy + r * cell + dy);
        ctx.lineTo(ox + C * cell + dx, oy + r * cell + dy);
      }
      ctx.stroke();
    };

    if (d > 0) {
      plane(d, -d, T.line2, 1);                 // back plane, pushed up-right
      ctx.strokeStyle = T.line2;                // struts joining the planes
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= C; c++) {
        for (let r = 0; r <= R; r++) {
          const x = ox + c * cell, y = oy + r * cell;
          ctx.moveTo(x, y);
          ctx.lineTo(x + d, y - d);
        }
      }
      ctx.stroke();
    }

    ctx.save();
    if (T.lineGlow) { ctx.shadowColor = T.line; ctx.shadowBlur = T.lineGlow; }
    plane(0, 0, T.line, d > 0 ? 1.3 : 1);
    ctx.restore();
  }

  function draw(now) {
    requestAnimationFrame(draw);
    if (!display || !cell) return;
    if (animating && travelers.length && now - waveStart >= waveDur) landWave();

    const C = display.cols, R = display.rows;
    const { cap } = E.topo(C, R);

    ctx.save();
    ctx.clearRect(0, 0, cw, ch);
    if (shake > 0.05) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.86;
    }

    drawGrid(C, R);

    const T = theme();
    const orbR = cell * T.orb;
    for (let i = 0; i < display.owner.length; i++) {
      const ow = display.owner[i];
      if (ow === -1) continue;
      const col = colorOf(ow);
      const x = cx(i), y = cy(i);
      const gx = ox + (i % C) * cell, gy = oy + (((i / C) | 0)) * cell;

      if (T.tint) {
        ctx.fillStyle = col + "14";
        ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        ctx.strokeStyle = col + "44";
        ctx.lineWidth = 1;
        ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);
      }

      if (display.count[i] === cap[i] - 1) {          // one orb from detonating
        ctx.save();
        ctx.strokeStyle = col + (Math.sin(now / 260) > 0 ? "88" : "44");
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.34, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      for (const [dx, dy] of orbOffsets(display.count[i], cap[i], now)) {
        drawOrb(x + dx, y + dy, orbR, col);
      }
    }

    if (travelers.length) {
      const k = Math.min(1, (now - waveStart) / waveDur);
      const ease = k * k * (3 - 2 * k);
      const rung = new Set();
      for (const t of travelers) {
        const col = colorOf(t.owner);
        if (!rung.has(t.from)) {
          rung.add(t.from);
          ctx.save();
          ctx.strokeStyle = col;
          ctx.globalAlpha = (1 - k) * 0.7;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx(t.from), cy(t.from), cell * (0.12 + ease * 0.6), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        drawOrb(cx(t.from) + (cx(t.to) - cx(t.from)) * ease,
                cy(t.from) + (cy(t.to) - cy(t.from)) * ease, orbR, col);
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
    ctx.restore();
  }
  requestAnimationFrame(draw);

  /* ── input ───────────────────────────────────────────────────────────── */

  canvas.addEventListener("pointerdown", e => {
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

  const banner = $("banner"), bannerText = $("bannerText"), live = $("live");
  const announce = msg => { live.textContent = msg; };

  function lobbyMsg(text, tone) {
    const el = $("lobbyMsg");
    el.textContent = text || "";
    el.hidden = !text;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  }

  /** Display name for a seat: whatever that player chose, else the element name. */
  function seatName(p) {
    if (mode === "online") {
      const s = seats[p];
      return (s && s.name) || PLAYERS[p].name;
    }
    return p === 0 && myName ? myName : PLAYERS[p].name;
  }

  function seatInfo(p) {
    if (mode === "local") return { cpu: localCPU[p], connected: true, mine: !localCPU[p] };
    const s = seats[p];
    return s
      ? { cpu: s.cpu, connected: s.connected, mine: p === mySeat }
      : { cpu: false, connected: false, mine: false };
  }

  function syncUI() {
    if (!logical || !display) return;
    const st = logical;
    document.documentElement.style.setProperty("--turn", colorOf(st.cur));

    const orbs = E.orbTotals(display);
    $("roster").replaceChildren(...Array.from({ length: st.numPlayers }, (_, p) => {
      const info = seatInfo(p);
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.style.setProperty("--pc", colorOf(p));
      chip.dataset.active = !st.over && p === st.cur ? "1" : "0";
      chip.dataset.out = st.alive[p] ? "0" : "1";

      const sw = document.createElement("span"); sw.className = "swatch";
      const nm = document.createElement("span"); nm.className = "nm";
      nm.textContent = seatName(p);
      if (mode === "online" && info.mine) {
        const you = document.createElement("i");
        you.textContent = "  ← you";
        nm.appendChild(you);
      }
      const ob = document.createElement("span"); ob.className = "orbs";
      ob.textContent = orbs[p] || 0;

      let tag;
      if (mode === "local") {
        tag = document.createElement("button");
        tag.type = "button";
        tag.className = "tag";
        tag.textContent = localCPU[p] ? "CPU" : "YOU";
        tag.setAttribute("aria-label", seatName(p) + ": " + (localCPU[p] ? "CPU" : "human") + ", click to swap");
        tag.onclick = () => { localCPU[p] = !localCPU[p]; syncUI(); maybeLocalCPU(); };
      } else if (isHost && !info.mine && !info.connected) {
        tag = document.createElement("button");
        tag.type = "button";
        tag.className = "tag";
        tag.textContent = info.cpu ? "CPU" : "EMPTY";
        tag.dataset.state = info.cpu ? "" : "gone";
        tag.title = info.cpu ? "Hand back to a human" : "Fill this seat with the CPU";
        tag.onclick = () => sendNet({ type: "cpu", seat: p, on: !info.cpu });
      } else {
        tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = info.cpu ? "CPU" : info.connected ? "LIVE" : "EMPTY";
        tag.dataset.state = info.cpu ? "" : info.connected ? "live" : "gone";
      }

      chip.append(sw, nm, ob, tag);
      return chip;
    }));

    $("statTurn").textContent = Math.max(1, st.turnCount + (st.over ? 0 : 1));
    $("statOrbs").textContent = orbs.reduce((a, b) => a + b, 0);
    $("statChain").textContent = st.largestChain;

    // Banner + board veil
    let veil = "";
    if (mode === "online" && !roomCode) {
      bannerText.textContent = "Offline preview";
      banner.classList.remove("live");
      veil = "Create or join a room to play";
    } else if (mode === "online" && netState !== "open") {
      bannerText.textContent = netState === "lost" ? "Reconnecting" : "Connecting";
      banner.classList.add("live");
      veil = netState === "lost" ? "Connection lost — reconnecting" : "Connecting to room";
    } else if (mode === "online" && !started) {
      const need = seats.filter(s => !s.cpu && !s.connected).length;
      bannerText.textContent = "Waiting for players";
      banner.classList.add("live");
      veil = "Room " + roomCode + " — waiting for " + need + " more player" + (need === 1 ? "" : "s");
    } else if (st.over) {
      bannerText.textContent = st.winner >= 0 ? seatName(st.winner) + " wins" : "Stalemate";
      banner.classList.remove("live");
    } else if (animating && chainShown > 1) {
      bannerText.textContent = "Chain reaction ×" + chainShown;
      banner.classList.add("live");
    } else if (mode === "online") {
      bannerText.textContent = mySeat === st.cur ? "Your move" : seatName(st.cur) + " thinking";
      banner.classList.add("live");
    } else {
      bannerText.textContent = seatName(st.cur) + (localCPU[st.cur] ? " computing" : " to place");
      banner.classList.add("live");
    }
    $("veil").dataset.on = veil ? "1" : "0";
    $("veilText").textContent = veil;
  }

  function syncLobby() {
    const on = mode === "online";
    $("lobbyCard").hidden = !on;
    $("localCard").hidden = on;
    if (!on) return;
    const joined = !!roomCode;
    $("preJoin").hidden = joined;
    $("inRoom").hidden = !joined;
    $("btnRestart").hidden = !(joined && isHost);
    if (joined) {
      $("roomCode").textContent = roomCode;
      $("roomLink").textContent = location.origin + "/#" + roomCode;
    }
    syncUI();
  }

  /** Push the board look onto the container the canvas sits in. */
  function applyTheme() {
    const T = theme();
    wrap.style.background = T.ground;
    wrap.style.borderColor = T.border;
    wrap.style.boxShadow = T.inset;
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
    segment($("segStyle"), ["Classic", "Console"], i => (i === 0) === (boardStyle === "classic"), i => {
      boardStyle = i === 0 ? "classic" : "console";
      store.set(STORE.style, boardStyle);
      syncSegments();
      applyTheme();
    });
    segment($("segSound"), ["Off", "On"], i => soundOn === !!i, i => {
      soundOn = !!i;
      store.set(STORE.sound, soundOn ? "1" : "0");
      syncSegments();
      if (soundOn) blip(520, 0.06, "square", 0.05);
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
    syncSegments();
    syncLobby();
  }

  function leaveRoom(reconnectable) {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    intent = null;
    moveQueue = [];
    if (net) { net.onclose = null; net.close(); net = null; }
    if (!reconnectable) {
      store.del(STORE.room); store.del(STORE.token);
      if (location.hash) history.replaceState(null, "", location.pathname);
    }
    roomCode = null; mySeat = -1; isHost = false; seats = []; started = false;
    setNet("idle");
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  const nameField = $("playerName");
  nameField.value = myName;

  function commitName() {
    const v = cleanName(nameField.value);
    if (v === myName) return;
    myName = v;
    store.set(STORE_NAME, myName);
    // Tell the room, and keep the reconnect intent carrying the new name.
    if (mode === "online" && roomCode) sendNet({ type: "name", name: myName });
    if (intent) intent.name = myName;
    syncUI();
  }
  nameField.addEventListener("change", commitName);
  nameField.addEventListener("blur", commitName);
  nameField.addEventListener("keydown", e => {
    if (e.key === "Enter") { commitName(); nameField.blur(); }
  });

  $("newGame").onclick = () => { newLocalGame(); canvas.focus(); };

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

  syncSegments();
  newLocalGame();
  applyTheme();
  syncLobby();

  if ((location.hash || "").replace("#", "").trim().length === 4) setMode("online");
})();

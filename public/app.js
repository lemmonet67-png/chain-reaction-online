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
  const WAVE_MS = REDUCED ? 70 : 190;
  const STORE = { room: "cr.room", token: "cr.token", sound: "cr.sound" };

  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} }
  };

  /* ── state ───────────────────────────────────────────────────────────── */

  let mode = "local";                       // "local" | "online"
  let logical = null;                       // settled game state
  let display = null;                       // what the canvas is showing
  let pendingWaves = [];                    // cascade waves left to animate
  let travelers = [], waveStart = 0, shake = 0, chainShown = 0;
  let animating = false;

  let localCPU = [false, true, true, true];
  let localPlayers = 2, localSize = 1;
  let soundOn = store.get(STORE.sound) === "1";

  let roomPlayers = 2, roomSize = 1;
  let net = null, netState = "idle";        // idle | connecting | open | lost
  let mySeat = -1, isHost = false, roomCode = null, seats = [], started = false;
  let retry = 0, retryTimer = null, pingTimer = null;

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
    if (logical.over) {
      announce(logical.winner >= 0 ? PLAYERS[logical.winner].name + " wins" : "Stalemate");
    } else {
      announce(PLAYERS[logical.cur].name + " to place");
      if (mode === "local") maybeLocalCPU();
    }
  }

  /* ── local mode ──────────────────────────────────────────────────────── */

  function newLocalGame() {
    const s = SIZES[localSize];
    logical = E.createState(s.cols, s.rows, localPlayers);
    display = E.cloneState(logical);
    pendingWaves = []; travelers = []; animating = false;
    cursor = ((s.rows / 2) | 0) * s.cols + ((s.cols / 2) | 0);
    wrap.style.aspectRatio = s.cols + " / " + s.rows;
    resize(); syncUI();
    announce(PLAYERS[logical.cur].name + " to place");
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

  function connect(then) {
    if (net && (net.readyState === 0 || net.readyState === 1)) { then && then(); return; }
    setNet("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    net = new WebSocket(proto + "://" + location.host);

    net.onopen = () => {
      retry = 0;
      setNet("open");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sendNet({ type: "ping" }), 25000);
      then && then();
    };
    net.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      onServer(m);
    };
    net.onclose = () => {
      clearInterval(pingTimer);
      if (mode !== "online") { setNet("idle"); return; }
      setNet("lost");
      // Back off, then try to reclaim the seat with the stored token.
      const wait = Math.min(8000, 600 * Math.pow(2, retry++));
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        connect(() => {
          const code = store.get(STORE.room);
          if (code) sendNet({ type: "join", code, token: store.get(STORE.token) });
        });
      }, wait);
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
        seats = seats.length ? seats : [];
        if (animating) {                      // a burst arrived mid-cascade
          logical = m.state;
          display = E.cloneState(m.state);
          pendingWaves = []; travelers = []; animating = false;
          syncUI();
        } else {
          animate(m.idx, m.player, m.waves, m.state);
        }
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
    pendingWaves = []; travelers = []; animating = false;
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
    const R = cell * 0.155;
    if (n === 1) return [[0, REDUCED ? 0 : Math.sin(t / 620) * cell * 0.012]];
    // Spin faster the closer the cell is to going critical.
    const tension = Math.min(1, (n - 1) / Math.max(1, cap - 1));
    const spin = REDUCED ? 0 : (t / 1000) * (0.7 + tension * 4.2);
    return Array.from({ length: n }, (_, k) => {
      const a = spin + (k * 2 * Math.PI) / n;
      return [Math.cos(a) * R, Math.sin(a) * R];
    });
  }

  function drawOrb(x, y, r, color) {
    const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, r * 0.1, x, y, r);
    g.addColorStop(0, "#FFFFFF");
    g.addColorStop(0.35, color);
    g.addColorStop(1, color);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = r * 1.9;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw(now) {
    requestAnimationFrame(draw);
    if (!display || !cell) return;
    if (animating && travelers.length && now - waveStart >= WAVE_MS) landWave();

    const C = display.cols, R = display.rows;
    const { cap } = E.topo(C, R);

    ctx.save();
    ctx.clearRect(0, 0, cw, ch);
    if (shake > 0.05) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.86;
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = "#1B2733";
    ctx.beginPath();
    for (let c = 0; c <= C; c++) { ctx.moveTo(ox + c * cell, oy); ctx.lineTo(ox + c * cell, oy + R * cell); }
    for (let r = 0; r <= R; r++) { ctx.moveTo(ox, oy + r * cell); ctx.lineTo(ox + C * cell, oy + r * cell); }
    ctx.stroke();

    const orbR = cell * 0.115;
    for (let i = 0; i < display.owner.length; i++) {
      const ow = display.owner[i];
      if (ow === -1) continue;
      const col = PLAYERS[ow].color;
      const x = cx(i), y = cy(i);
      const gx = ox + (i % C) * cell, gy = oy + (((i / C) | 0)) * cell;

      ctx.fillStyle = col + "14";
      ctx.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
      ctx.strokeStyle = col + "44";
      ctx.lineWidth = 1;
      ctx.strokeRect(gx + 1.5, gy + 1.5, cell - 3, cell - 3);

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
      const k = Math.min(1, (now - waveStart) / WAVE_MS);
      const ease = k * k * (3 - 2 * k);
      const rung = new Set();
      for (const t of travelers) {
        const col = PLAYERS[t.owner].color;
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
      const col = PLAYERS[logical.cur].color;
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
    document.documentElement.style.setProperty("--turn", PLAYERS[st.cur].color);

    const orbs = E.orbTotals(display);
    $("roster").replaceChildren(...Array.from({ length: st.numPlayers }, (_, p) => {
      const info = seatInfo(p);
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.style.setProperty("--pc", PLAYERS[p].color);
      chip.dataset.active = !st.over && p === st.cur ? "1" : "0";
      chip.dataset.out = st.alive[p] ? "0" : "1";

      const sw = document.createElement("span"); sw.className = "swatch";
      const nm = document.createElement("span"); nm.className = "nm";
      nm.textContent = PLAYERS[p].name;
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
        tag.setAttribute("aria-label", PLAYERS[p].name + ": " + (localCPU[p] ? "CPU" : "human") + ", click to swap");
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
      bannerText.textContent = st.winner >= 0 ? PLAYERS[st.winner].name + " wins" : "Stalemate";
      banner.classList.remove("live");
    } else if (animating && chainShown > 1) {
      bannerText.textContent = "Chain reaction ×" + chainShown;
      banner.classList.add("live");
    } else if (mode === "online") {
      bannerText.textContent = mySeat === st.cur ? "Your move" : PLAYERS[st.cur].name + " thinking";
      banner.classList.add("live");
    } else {
      bannerText.textContent = PLAYERS[st.cur].name + (localCPU[st.cur] ? " computing" : " to place");
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

  function syncSegments() {
    segment($("segMode"), ["Local", "Online"], i => (i === 1) === (mode === "online"), i => setMode(i === 1 ? "online" : "local"));
    segment($("segPlayers"), ["2", "3", "4"], i => localPlayers === i + 2, i => { localPlayers = i + 2; syncSegments(); newLocalGame(); });
    segment($("segSize"), SIZES.map(s => s.label), i => localSize === i, i => { localSize = i; syncSegments(); newLocalGame(); });
    segment($("segRoomPlayers"), ["2", "3", "4"], i => roomPlayers === i + 2, i => { roomPlayers = i + 2; syncSegments(); });
    segment($("segRoomSize"), SIZES.map(s => s.label), i => roomSize === i, i => { roomSize = i; syncSegments(); });
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
      connect(() => { if (target) sendNet({ type: "join", code: target, token: store.get(STORE.token) }); });
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
    if (net) { net.onclose = null; net.close(); net = null; }
    if (!reconnectable) {
      store.del(STORE.room); store.del(STORE.token);
      if (location.hash) history.replaceState(null, "", location.pathname);
    }
    roomCode = null; mySeat = -1; isHost = false; seats = []; started = false;
    setNet("idle");
  }

  /* ── wiring ──────────────────────────────────────────────────────────── */

  $("newGame").onclick = () => { newLocalGame(); canvas.focus(); };

  $("btnCreate").onclick = () => {
    lobbyMsg("");
    connect(() => sendNet({ type: "create", sizeIdx: roomSize, numPlayers: roomPlayers }));
  };

  $("btnJoin").onclick = () => {
    const code = $("joinCode").value.toUpperCase().trim();
    if (code.length !== 4) { lobbyMsg("Room codes are 4 characters.", "bad"); return; }
    lobbyMsg("");
    connect(() => sendNet({ type: "join", code }));
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
      connect(() => sendNet({ type: "join", code }));
    }
  });

  syncSegments();
  newLocalGame();
  syncLobby();

  if ((location.hash || "").replace("#", "").trim().length === 4) setMode("online");
})();

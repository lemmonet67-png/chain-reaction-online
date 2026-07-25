/*
 * Chain Reaction — room server.
 *
 * Serves the client out of public/ and runs authoritative game rooms over
 * WebSocket on the same port. The server owns every board: clients send an
 * intended move, the server validates it against the shared engine and
 * broadcasts the result. Clients only animate.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const Engine = require("./public/engine.js");

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, "public");

const ROOM_TTL_MS   = 45 * 60 * 1000;  // drop rooms untouched for 45 min
const SWEEP_MS      = 60 * 1000;
const HEARTBEAT_MS  = 25 * 1000;       // hosts kill idle sockets; stay chatty
const CPU_DELAY_MS  = 550;

/* ── static files ───────────────────────────────────────────────────────── */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";

  // Resolve inside PUBLIC and reject anything that escapes it.
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(buf);
  });
});

/* ── rooms ──────────────────────────────────────────────────────────────── */

/** No I/O/0/1 — these get read aloud and typed in by hand. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0]).join("");
  } while (rooms.has(code));
  return code;
}

const token = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function createRoom(sizeIdx, numPlayers) {
  const size = Engine.SIZES[sizeIdx] || Engine.SIZES[1];
  const code = makeCode();
  const room = {
    code,
    sizeIdx,
    numPlayers,
    state: Engine.createState(size.cols, size.rows, numPlayers),
    seats: Array.from({ length: numPlayers }, () => ({ token: null, sock: null, cpu: false })),
    hostToken: null,
    touched: Date.now(),
    cpuTimer: null
  };
  rooms.set(code, room);
  return room;
}

const seatReady = s => s.cpu || !!s.sock;
const allSeated = room => room.seats.every(seatReady);

function seatView(room) {
  return room.seats.map((s, i) => ({
    seat: i,
    name: Engine.PLAYERS[i].name,
    cpu: s.cpu,
    connected: !!s.sock,
    claimed: !!s.token
  }));
}

function send(sock, msg) {
  if (sock && sock.readyState === 1) {
    try { sock.send(JSON.stringify(msg)); } catch (_) { /* socket closing */ }
  }
}

function broadcast(room, msg, except) {
  for (const s of room.seats) {
    if (s.sock && s.sock !== except) send(s.sock, msg);
  }
}

function pushRoom(room, extra) {
  broadcast(room, Object.assign({
    type: "room",
    code: room.code,
    seats: seatView(room),
    started: allSeated(room),
    state: room.state
  }, extra || {}));
}

/* ── move handling ──────────────────────────────────────────────────────── */

function commitMove(room, idx, player) {
  const result = Engine.applyMove(room.state, idx, player);
  room.touched = Date.now();
  broadcast(room, {
    type: "move",
    idx,
    player,
    waves: result.waves,
    eliminated: result.eliminated,
    state: room.state
  });
  scheduleCPU(room);
}

/** If the seat now to move is a CPU (or an abandoned seat filled by one), play it. */
function scheduleCPU(room) {
  clearTimeout(room.cpuTimer);
  room.cpuTimer = null;
  const st = room.state;
  if (st.over || !allSeated(room)) return;

  const seat = room.seats[st.cur];
  if (!seat || !seat.cpu) return;

  room.cpuTimer = setTimeout(() => {
    room.cpuTimer = null;
    // Conditions can change during the think delay — re-check everything.
    if (!rooms.has(room.code) || room.state.over || !allSeated(room)) return;
    const now = room.state.cur;
    if (!room.seats[now] || !room.seats[now].cpu) return;
    const move = Engine.chooseMove(room.state, now);
    if (move >= 0) commitMove(room, move, now);
  }, CPU_DELAY_MS);
}

function resetRoom(room) {
  const size = Engine.SIZES[room.sizeIdx] || Engine.SIZES[1];
  clearTimeout(room.cpuTimer);
  room.cpuTimer = null;
  room.state = Engine.createState(size.cols, size.rows, room.numPlayers);
  room.touched = Date.now();
  pushRoom(room, { reset: true });
  scheduleCPU(room);
}

/* ── websocket ──────────────────────────────────────────────────────────── */

const wss = new WebSocketServer({ server });

wss.on("connection", sock => {
  sock.isAlive = true;
  sock.room = null;
  sock.seat = -1;
  sock.on("pong", () => { sock.isAlive = true; });

  sock.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.type !== "string") return;
    handle(sock, msg);
  });

  sock.on("close", () => {
    const room = rooms.get(sock.room);
    if (!room) return;
    const seat = room.seats[sock.seat];
    if (seat && seat.sock === sock) {
      seat.sock = null;                 // keep seat.token so they can reclaim it
      pushRoom(room);
      scheduleCPU(room);                // a CPU seat can keep playing regardless
    }
  });
});

function fail(sock, code, message) {
  send(sock, { type: "error", code, message });
}

function leaveCurrent(sock) {
  const room = rooms.get(sock.room);
  if (!room) return;
  const seat = room.seats[sock.seat];
  if (seat && seat.sock === sock) seat.sock = null;
  sock.room = null;
  sock.seat = -1;
}

function attach(sock, room, seatIdx, seatToken) {
  const seat = room.seats[seatIdx];
  seat.token = seatToken;
  seat.sock = sock;
  seat.cpu = false;
  sock.room = room.code;
  sock.seat = seatIdx;
  room.touched = Date.now();
  if (!room.hostToken) room.hostToken = seatToken;

  send(sock, {
    type: "joined",
    code: room.code,
    seat: seatIdx,
    token: seatToken,
    host: room.hostToken === seatToken,
    sizeIdx: room.sizeIdx,
    numPlayers: room.numPlayers
  });
  pushRoom(room);
  scheduleCPU(room);
}

function handle(sock, msg) {
  switch (msg.type) {

    case "create": {
      leaveCurrent(sock);
      const sizeIdx = Number.isInteger(msg.sizeIdx)
        ? Math.min(Engine.SIZES.length - 1, Math.max(0, msg.sizeIdx)) : 1;
      const numPlayers = Number.isInteger(msg.numPlayers)
        ? Math.min(Engine.MAX_PLAYERS, Math.max(2, msg.numPlayers)) : 2;
      const room = createRoom(sizeIdx, numPlayers);
      attach(sock, room, 0, token());
      return;
    }

    case "join": {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(sock, "no_room", "No room with code " + code + ".");
      leaveCurrent(sock);

      // Reclaim a seat first — this is how reconnects get their game back.
      if (msg.token) {
        const idx = room.seats.findIndex(s => s.token === msg.token);
        if (idx !== -1) return attach(sock, room, idx, msg.token);
      }
      const free = room.seats.findIndex(s => !s.sock && (!s.token || s.cpu));
      if (free === -1) return fail(sock, "full", "That room is full.");
      return attach(sock, room, free, token());
    }

    case "move": {
      const room = rooms.get(sock.room);
      if (!room) return fail(sock, "no_room", "You are not in a room.");
      if (!allSeated(room)) return fail(sock, "waiting", "Still waiting for players.");
      if (room.state.over) return fail(sock, "over", "That game is finished.");
      if (sock.seat !== room.state.cur) return fail(sock, "not_turn", "Not your turn.");
      if (!Engine.isLegal(room.state, msg.idx, sock.seat)) {
        // Client and server disagreed — resync rather than argue.
        send(sock, { type: "room", code: room.code, seats: seatView(room),
                     started: allSeated(room), state: room.state, resync: true });
        return;
      }
      return commitMove(room, msg.idx, sock.seat);
    }

    case "cpu": {
      const room = rooms.get(sock.room);
      if (!room) return;
      const seat = room.seats[sock.seat];
      if (!seat || room.hostToken !== seat.token) return fail(sock, "not_host", "Only the host can do that.");
      const idx = msg.seat;
      if (!Number.isInteger(idx) || idx < 0 || idx >= room.numPlayers) return;
      if (idx === sock.seat) return fail(sock, "self", "You cannot hand your own seat to the CPU.");
      const target = room.seats[idx];
      if (target.sock) return fail(sock, "occupied", "Someone is sitting there.");
      target.cpu = !!msg.on;
      if (target.cpu) target.token = null;   // free it up if a human comes back
      room.touched = Date.now();
      pushRoom(room);
      scheduleCPU(room);
      return;
    }

    case "restart": {
      const room = rooms.get(sock.room);
      if (!room) return;
      const seat = room.seats[sock.seat];
      if (!seat || room.hostToken !== seat.token) return fail(sock, "not_host", "Only the host can restart.");
      return resetRoom(room);
    }

    case "ping":
      return send(sock, { type: "pong" });
  }
}

/* ── upkeep ─────────────────────────────────────────────────────────────── */

setInterval(() => {
  for (const sock of wss.clients) {
    if (sock.isAlive === false) { sock.terminate(); continue; }
    sock.isAlive = false;
    try { sock.ping(); } catch (_) { /* already gone */ }
  }
}, HEARTBEAT_MS);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const live = room.seats.some(s => s.sock);
    if (!live && now - room.touched > ROOM_TTL_MS) {
      clearTimeout(room.cpuTimer);
      rooms.delete(code);
    }
  }
}, SWEEP_MS);

server.listen(PORT, () => {
  console.log("Chain Reaction listening on http://localhost:" + PORT);
});

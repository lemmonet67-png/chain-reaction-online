/*
 * Chain Reaction — shared rules engine.
 *
 * Loaded by BOTH the Node server (authority) and the browser (animation), so
 * the two can never disagree about what a move does. State is plain JSON so it
 * can be sent down the wire verbatim.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChainEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* The original game's eight orb colours, in its seat order — sampled straight
     off its screenshots, which is why they are flat channel extremes rather
     than anything tuned. The board's grid is drawn from these too, at half
     brightness, so changing one here retints that player's whole board. */
  const PLAYERS = [
    { name: "RED",     color: "#FF0000" },
    { name: "GREEN",   color: "#00FF00" },
    { name: "BLUE",    color: "#0000FF" },
    { name: "YELLOW",  color: "#FFFF00" },
    { name: "MAGENTA", color: "#FF00FF" },
    { name: "CYAN",    color: "#00FFFF" },
    { name: "ORANGE",  color: "#FF8000" },
    { name: "WHITE",   color: "#FFFFFF" }
  ];
  const MAX_PLAYERS = PLAYERS.length;

  const SIZES = [
    { label: "5×7",   cols: 5,  rows: 7  },
    { label: "6×9",   cols: 6,  rows: 9  },
    { label: "7×10",  cols: 7,  rows: 10 },
    { label: "8×11",  cols: 8,  rows: 11 },
    { label: "10×14", cols: 10, rows: 14 },
    { label: "12×16", cols: 12, rows: 16 }
  ];

  /* Neighbour lists and critical masses depend only on the grid shape, so
     compute each shape once and reuse. */
  const topoCache = new Map();
  function topo(cols, rows) {
    const key = cols + "x" + rows;
    let t = topoCache.get(key);
    if (t) return t;
    const n = cols * rows, cap = new Array(n), nei = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = i % cols, r = (i / cols) | 0, nb = [];
      if (r > 0)        nb.push(i - cols);
      if (r < rows - 1) nb.push(i + cols);
      if (c > 0)        nb.push(i - 1);
      if (c < cols - 1) nb.push(i + 1);
      nei[i] = nb;
      cap[i] = nb.length;          // critical mass == orthogonal neighbour count
    }
    t = { cap, nei };
    topoCache.set(key, t);
    return t;
  }

  function createState(cols, rows, numPlayers) {
    const n = cols * rows;
    return {
      cols, rows, numPlayers,
      count: new Array(n).fill(0),
      owner: new Array(n).fill(-1),
      cur: 0,
      alive: new Array(numPlayers).fill(true),
      turnCount: 0,
      largestChain: 0,
      over: false,
      winner: -1
    };
  }

  const cloneState = st => JSON.parse(JSON.stringify(st));

  /* The search clones a state per candidate move, which on a 12×16 board is
     ~200 clones per ply — far too hot for a JSON round trip. */
  const fastClone = st => ({
    cols: st.cols, rows: st.rows, numPlayers: st.numPlayers,
    count: st.count.slice(), owner: st.owner.slice(), alive: st.alive.slice(),
    cur: st.cur, turnCount: st.turnCount,
    largestChain: st.largestChain, over: st.over, winner: st.winner
  });

  function orbTotals(st) {
    const t = new Array(st.numPlayers).fill(0);
    for (let i = 0; i < st.owner.length; i++) {
      if (st.owner[i] !== -1) t[st.owner[i]] += st.count[i];
    }
    return t;
  }

  function cellTotals(st) {
    const t = new Array(st.numPlayers).fill(0);
    for (let i = 0; i < st.owner.length; i++) {
      if (st.owner[i] !== -1) t[st.owner[i]]++;
    }
    return t;
  }

  /** Owner index if every occupied cell belongs to one player, else -1. */
  function soleOwner(st) {
    let found = -1;
    for (let i = 0; i < st.owner.length; i++) {
      const o = st.owner[i];
      if (o === -1) continue;
      if (found === -1) found = o;
      else if (o !== found) return -1;
    }
    return found;
  }

  const isLegal = (st, idx, p) =>
    !st.over &&
    p === st.cur &&
    idx >= 0 && idx < st.owner.length &&
    (st.owner[idx] === -1 || st.owner[idx] === p);

  function legalMoves(st, p) {
    const out = [];
    for (let i = 0; i < st.owner.length; i++) {
      if (st.owner[i] === -1 || st.owner[i] === p) out.push(i);
    }
    return out;
  }

  function nextAlive(st, p) {
    for (let k = 1; k <= st.numPlayers; k++) {
      const q = (p + k) % st.numPlayers;
      if (st.alive[q]) return q;
    }
    return p;
  }

  /**
   * Place an orb and run the cascade to completion, mutating `st`.
   * Returns the wave-by-wave breakdown so a client can animate the same
   * cascade the server just resolved.
   */
  function applyMove(st, idx, p) {
    const { cap, nei } = topo(st.cols, st.rows);
    st.count[idx]++;
    st.owner[idx] = p;
    st.turnCount++;

    const waves = [];
    let guard = 0;
    for (;;) {
      // A board owned outright can cascade forever — stop as soon as it is.
      if (st.turnCount >= st.numPlayers && soleOwner(st) === p) break;

      const crit = [];
      for (let i = 0; i < st.count.length; i++) {
        if (st.count[i] >= cap[i]) crit.push(i);
      }
      if (!crit.length || guard++ > 400) break;
      waves.push(crit);

      // Every critical cell empties first, then all orbs land — so a wave
      // resolves simultaneously rather than in index order.
      const landing = [];
      for (const i of crit) {
        const ow = st.owner[i];
        st.count[i] -= cap[i];
        if (st.count[i] === 0) st.owner[i] = -1;
        for (const nb of nei[i]) landing.push([nb, ow]);
      }
      for (const [nb, ow] of landing) {
        st.count[nb]++;
        st.owner[nb] = ow;      // receiving a hit flips the cell, orbs and all
      }
    }

    const chain = waves.reduce((a, w) => a + w.length, 0);
    st.largestChain = Math.max(st.largestChain, chain);

    // Nobody is out until everyone has had a turn — otherwise player 2 would be
    // eliminated before ever placing an orb.
    const eliminated = [];
    if (st.turnCount >= st.numPlayers) {
      const orbs = orbTotals(st);
      for (let q = 0; q < st.numPlayers; q++) {
        if (st.alive[q] && orbs[q] === 0) { st.alive[q] = false; eliminated.push(q); }
      }
    }

    if (st.alive.filter(Boolean).length <= 1) {
      st.over = true;
      st.winner = st.alive.indexOf(true);
    } else {
      st.cur = nextAlive(st, st.cur);
    }

    return { waves, chain, eliminated, over: st.over, winner: st.winner };
  }

  /* ── CPU ──────────────────────────────────────────────────────────────── */

  function evaluate(st, me) {
    const { cap, nei } = topo(st.cols, st.rows);
    let score = 0;
    for (let i = 0; i < st.owner.length; i++) {
      const ow = st.owner[i];
      if (ow === -1) continue;
      // Low-capacity cells are cheap to detonate and hard to attack.
      let v = st.count[i] + (cap[i] === 2 ? 1.6 : cap[i] === 3 ? 0.8 : 0);
      // Sitting one orb from critical next to an enemy in the same state means
      // they detonate first and take the cell.
      if (st.count[i] === cap[i] - 1) {
        for (const nb of nei[i]) {
          if (st.owner[nb] !== -1 && st.owner[nb] !== ow && st.count[nb] === cap[nb] - 1) {
            v -= 2.2;
            break;
          }
        }
      }
      score += ow === me ? v : -v;
    }
    return score;
  }

  function tryMove(st, idx, p) {
    const next = fastClone(st);
    applyMove(next, idx, p);
    return next;
  }

  /** Greedy search: score every move, then check the best few one reply deep. */
  function chooseMove(st, me) {
    const moves = legalMoves(st, me);
    if (!moves.length) return -1;

    const scored = moves.map(m => {
      const after = tryMove(st, m, me);
      return { m, after, sc: after.over && after.winner === me ? 1e6 : evaluate(after, me) };
    });
    scored.sort((a, b) => b.sc - a.sc);
    if (scored[0].sc >= 1e6) return scored[0].m;

    // The reply ply costs candidates × opponent moves simulations, which grows
    // with the square of the board — narrow the shortlist as the grid gets big.
    const n = st.owner.length;
    const width = n > 150 ? 3 : n > 100 ? 5 : 8;
    const top = scored.slice(0, Math.min(width, scored.length));
    for (const e of top) {
      if (e.after.over) continue;
      const foe = e.after.cur;
      if (foe === me) continue;
      let worst = Infinity;
      for (const om of legalMoves(e.after, foe)) {
        const after2 = tryMove(e.after, om, foe);
        const v = after2.over && after2.winner === foe ? -1e6 : evaluate(after2, me);
        if (v < worst) worst = v;
      }
      if (worst !== Infinity) e.sc = worst;
    }
    top.sort((a, b) => b.sc - a.sc);

    const best = top[0].sc;
    const ties = top.filter(e => e.sc >= best - 0.001);
    return ties[(Math.random() * ties.length) | 0].m;
  }

  return {
    PLAYERS, SIZES, MAX_PLAYERS,
    topo, createState, cloneState, fastClone,
    orbTotals, cellTotals, soleOwner,
    isLegal, legalMoves, nextAlive,
    applyMove, chooseMove
  };
});

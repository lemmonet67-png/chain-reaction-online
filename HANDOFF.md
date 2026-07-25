# Handoff — Chain Reaction online

Written 2026-07-25. Context for whoever picks this up next.

## What this is

A real-time multiplayer clone of Chain Reaction, built from scratch this
session and deployed. Working and in use — not a prototype.

| | |
|---|---|
| Local | `C:\Users\gerrapselrashina\chain-reaction-online` |
| Repo | https://github.com/lemmonet67-png/chain-reaction-online |
| Live | https://chain-reaction-online.onrender.com |
| Host | Render, **free tier**, Singapore region |

There is also an earlier **offline-only** version published as a Claude artifact
(single self-contained HTML). It has since diverged and lacks everything below.
Ignore it unless asked — the artifact CSP blocks WebSockets, which is the whole
reason this became a standalone project.

## Architecture — the one thing to understand

**The rules engine is shared verbatim between server and browser.**
`public/engine.js` is UMD: the Node server `require`s it, the browser loads it
via `<script>`. The server owns every board and validates each move; clients
only animate the wave list it broadcasts back. Two browsers therefore cannot
drift out of sync. Don't fork this logic — change it in one place.

```
server.js          room server + static host (Node http + ws). Only dep: ws.
public/engine.js   rules, critical mass, cascade, elimination, CPU search
public/app.js      canvas renderer, local play, network layer
public/index.html  markup + styles
```

Game state is plain JSON so it goes down the wire unchanged. `logical` is the
settled truth; `display` lags behind it, stepping through the cascade one wave
at a time so chains are watchable.

## Features

2–8 players, six grids (5×7 → 12×16), CPU opponents, room codes + shareable
links, seat reclaim on reconnect, host can fill abandoned seats with CPU,
custom player names, per-player colour overrides, sound, vibrate, two board
styles (original / instrument console).

## Matching the original

The point of the app is to be the Android original (App Holdings,
`com.BuddyMattEnt.ChainReaction`), not a reinterpretation of it. The board
constants in `THEMES.original` (`public/app.js`) were **measured off that game's
store screenshots**, not chosen — back-plane scale 0.926, orb plane 0.963, grid
at 0.51 × the player's colour, orb radius 0.233 × cell, cluster radius 0.095,
rim 0.45, and the flat-channel palette. The README has the table and the
method.

**Do not "improve" these by eye.** If a change makes the board look better but
moves a measured number, it has moved away from the thing being cloned. Re-measure
against a screenshot instead; the technique that produced them is: load a store
image into a canvas on its own origin, read pixels, find grid-line runs along a
scanline, and fit the back-plane scale as a ratio of distances from the board
centre.

Rules were already correct before this and are unchanged: critical mass = number
of orthogonal neighbours, receiving cells flip owner, nobody is eliminated until
everyone has had a turn.

## Running and testing

```bash
npm install && npm start     # http://localhost:8080
```

Two players on one machine: a normal window plus a private window. Two normal
tabs share `localStorage` and the second will try to reclaim the first's seat.

> **⚠ The test suite is not in the repo.** 44 tests were written this session
> and all passed, but they live in a session scratchpad under
> `%TEMP%\claude\...\scratchpad\` which will be cleaned up. **Recommended first
> action: ask whether to rewrite them into `test/` and commit them.** They
> covered: engine rules, client/server wave-replay agreement, the full room
> protocol, 8-player play through the real server, input clamping, and name
> sanitising. Losing them is the biggest risk to this codebase.

There is no test runner configured; they were plain Node scripts run directly.

## Deploying

Push to `main` — Render auto-deploys. Build `npm install`, start `npm start`,
`PORT` comes from the environment. Takes 2–3 minutes.

Geraldine pushes, or asks explicitly. She has said "push it" several times but
confirm rather than assuming.

## Known issues — read before promising anything

**1. Render intermittently 404s the WebSocket upgrade.** Measured between ~15%
and ~60% of handshake attempts, varying run to run, with no pattern found. HTTP
is unaffected. Not our code, not the free-tier sleep, not a connection limit —
all three were tested and ruled out. The client retries with backoff and
replays its pending create/join, which is what makes the app usable. That retry
logic is load-bearing; don't simplify it away.

**2. Blank page, root cause never found.** Early on the deployed page rendered
static HTML with no JS applied. Files served were byte-identical to local and
complete. It resolved on its own after a hard refresh. **No diagnosis was ever
reached** — if it recurs, the browser console error is what's needed. Note two
*separate* self-inflicted load-time errors were found and fixed later (a `const`
redeclaration and an infinite recursion in `seatName`), so that class of bug is
plausible but was never confirmed as the original cause.

**3. Free tier sleeps** after ~15 min idle; ~1 min cold start. Open the link a
few minutes before playing, or upgrade ($7/mo) which also removes it.

**4. Rooms are in memory.** Redeploy or restart wipes active games.

## Verification status

Browser tools now work, so the previous handoff's visual unknowns were checked
directly in Chrome against a local server.

**Confirmed by looking:**

- The board matches the original side by side (structure, depth, orb size and
  shading, palette). Two numbers were re-measured off the clone's own canvas and
  agree: grid `rgb(130,0,0)` vs the original's `132,0,0`, orb radius ratio
  `0.233`.
- Grid tinting to the active player.
- A cascade resolves and repaints correctly (corner detonation, both neighbours
  claimed, turn passes).
- 12×16 does **not** read as noise. The old worry assumed a fixed diagonal
  extrusion; with the correct centre projection, depth is proportional to
  distance from the middle, so central cells are nearly flat and it stays legible.
- Menu, Preferences, colour pickers, mode switch, room create, stale-room
  rejection and recovery, seat list, veil states.

- **Long cascades and game over**, via CPU-vs-CPU self-play on 5×7: 37 turns in
  25 seconds, cascades up to 11 waves deep resolving correctly, ending in a
  proper `GREEN wins` veil tinted to the winner. See the bug below — this is
  what turned it up.

**Still not verified:**

- Two live browsers in one room. Only one client was ever connected; the
  network layer was carried over unchanged, but that is an argument, not a test.
- Mobile. Needs a phone. If tapping is twitchy, raise `TAP_SLOP` in `app.js`.

## Fixed this session: cascades froze in a hidden tab

Worth knowing about because it was invisible for two sessions and it is the
likely answer to the old handoff's "whether long cascades now play out fully".

`draw()` is driven by `requestAnimationFrame`, and it used to also *advance the
game*:

```js
if (animating && travelers.length && now - waveStart >= waveDur) landWave();
```

The browser stops firing rAF entirely while a tab is hidden. Measured directly:
`document.hidden === true`, **0 rAF callbacks in 1200ms**, and a cascade sitting
at `animating: true, travelers: 3` with `now - waveStart` of 14977ms against a
`waveDur` of 190 — the landing condition was long since true and nothing was
running to act on it. Switch tabs mid-chain and the game stopped until you
looked back.

The fix is that the cascade is now stepped by `setTimeout` (`waveTimer`), and
`draw()` paints and nothing else. Background tabs throttle `setTimeout` but
still fire it, so a chain finishes whether or not anyone is watching.

**The rule to keep:** game state advances on timers; `draw()` may only read
state and paint. If you ever move a state mutation back into the render loop,
this returns.

`window.__crDebug()` in `app.js` is what pinned it down — the animation vars are
closed over by the IIFE and were otherwise unreachable from the console.

> **⚠ The test suite is still not in the repo.** See the warning further up —
> nothing about it changed, and the renderer rewrite means the client/server
> wave-replay agreement test is now more valuable, not less.

**A stub-DOM harness caught two real load-time crashes** that syntax checking
missed — it's worth recreating. It loaded `engine.js` then `app.js` in a `vm`
context against permissive Proxy stubs and reported throws. It cannot catch
layout or visual problems. (Loading the page in Chrome and reading the console
does the same job and also catches layout, but only when a browser is available.)

**Watch for stale servers.** A `node server.js` from an earlier session was
still holding port 8080 and serving seat names from the *old* palette, because
it had `require`d `engine.js` at its own startup. It looked exactly like a bug
in the new code. Check `Get-NetTCPConnection -LocalPort 8080` and the process
start time before believing anything odd about server-supplied data.

## Conventions

- Commit messages explain *why*, with the mechanism when it isn't obvious.
  Co-authored-by trailer on every commit.
- Code matches surrounding style: comments explain reasoning, not what the line
  does. Existing comment density is deliberate.
- Colours are display-only; the server deals in seat indices. Player names are
  sanitised **server-side** (trim, 14 chars, control chars stripped) because
  they come from players and are shown to everyone.

Two editing hazards hit this session, both worth avoiding:
- A regex with escape sequences written through the edit tool put a literal NUL
  byte into `server.js`. Build such patterns with `new RegExp("...")` instead.
- A bulk find-and-replace of `PLAYERS[p].name` → `seatName(p)` also rewrote the
  fallback *inside* `seatName`, causing infinite recursion. Check the definition
  after any bulk rename.

## Working with Geraldine

See her memory files for general preferences. Project-specific: she wants
honest status over reassurance. Several hypotheses were stated confidently and
disproved this session — saying "I don't have a root cause" landed better than
guessing. Flag what is verified versus merely reasoned about, every time.

## Suggested next steps

1. Get the tests back into the repo (see warning above).
2. Play one game to completion and one long cascade — the two gaps left in
   *Verification status*. Both need a human or a scripted client, not a look.
3. Two browsers in one room, to actually exercise the network layer again.
4. Only then consider polish.

Two things deliberately left out, both Geraldine's call:

- **UNDO.** The original has it; she chose to skip it. If it comes back, local
  only is the cheap version — an online undo needs a per-room move history on
  the server and a rule for who may call it.
- **Auto board size.** The original picks its grid from the screen, which is why
  its screenshots show 6×9, 6×10 and larger. This keeps a fixed size list
  instead, because a room's two clients have to agree on the shape and the
  server owns it. Adding an "Auto" that resolves to concrete dimensions at room
  creation would be closer to the original.

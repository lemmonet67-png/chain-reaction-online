# Chain Reaction — online

Real-time multiplayer Chain Reaction. Orbs detonate at critical mass and cascade
across the grid; last player standing wins.

It is built to look like the Android original (App Holdings, package
`com.BuddyMattEnt.ChainReaction`) rather than to reinterpret it — see
[Matching the original](#matching-the-original).

The server is authoritative — it owns every board, validates each move against
the shared rules engine, and broadcasts the result. Clients only animate what
they're told, so two browsers can't drift apart.

```
server.js          room server + static host (Node http + ws)
public/engine.js   the rules, shared verbatim by server and browser
public/app.js      canvas renderer, local play, network layer
public/index.html  markup and styles
```

## Run it locally

```bash
npm install
npm start
```

Open <http://localhost:8080>. To test two players on one machine, open a second
tab (an ordinary window and a private window works best — they get separate
`localStorage`, so the second tab won't try to reclaim the first tab's seat).

## Playing

2 to 8 players, on grids from 5×7 up to 12×16. The original's standard board is
6×9, which is the default here too.

Everything lives behind the **⋮** menu in the action bar, the way the original
keeps it — the board itself gets the whole screen, and the only thing that tells
you whose turn it is is the colour of the lattice.

**Preferences** (⋮ → Preferences) holds your name, sound, vibrate, the board
style, and a colour picker per player, mirroring the original's own preferences
screen. Colours are display-only; the server deals in seat indices, so changing
one only affects your browser.

**Local** — everything runs in the tab. Toggle any seat between `HUMAN` and
`CPU`; set them all to CPU and it plays itself.

**Online** — *Create room* gives you a 4-letter code and a shareable link.
Anyone who opens the link drops straight into the room. Play starts once every
seat is filled.

- Refreshing or losing your connection is safe. Your seat is held and reclaimed
  automatically via a token in `localStorage`.
- **Chat** lives behind the speech-bubble button, which only appears once you're
  in a room. Messages also float over the board for a few seconds so you don't
  have to keep the panel open while you play, and the button carries an unread
  count. The last 60 messages are kept server-side, so reconnecting catches you
  up on what you missed.
- If someone doesn't show up or leaves for good, the host can click their
  `EMPTY` tag to hand the seat to the CPU and keep the game moving.
- Only the host can restart the game.
- Rooms are in memory only. They vanish on restart, and 45 minutes after the
  last player disconnects.

## Matching the original

The board is not styled by eye. Every number below was measured off the
original's own store screenshots (480×800 images, 77.2px cells) and lives in
`THEMES.original` in `public/app.js`:

| | Measured | Where it shows |
|---|---|---|
| Back lattice scale | `0.926` about the board centre | each cell is an open box, fanning out from the middle |
| Orb plane | `0.963` | orbs sit half way into that box, so they drift off the flat cell centre |
| Grid colour | player colour × `0.51` | `rgb(132,0,0)` on a red turn, `rgb(0,130,0)` on green |
| Orb radius | `0.233` × cell | |
| Cluster radius | `0.095` × cell | 2 and 3 orbs overlap heavily and rotate |
| Rim | `0.45` × colour | no specular highlight — the orbs read as lit from inside |
| Palette | `#FF0000 #00FF00 #0000FF #FFFF00 #FF00FF #00FFFF #FF8000 #FFFFFF` | |

The clone's own render measures back as `rgb(130,0,0)` and a `0.233` radius
ratio, so those two are confirmed rather than merely intended.

**Deliberate differences.** The original has an UNDO button; this doesn't. The
original has no network, so the room lobby, seat list and connection indicator
have no counterpart there and live in the menu. `Console` under Preferences →
Board is this project's own earlier look, kept as an option; it runs through the
same renderer with the depth flattened to zero.

### Voice

Behind **Join voice** in the room menu. Audio is peer-to-peer over WebRTC — the
server only relays the handshake and never carries or stores a sample.

- Your **microphone is off** until you switch it on, every session. Turning it
  off releases the device, so the browser's recording indicator goes out rather
  than leaving an open mic muted in software.
- A live mic turns the toolbar button **red**, so it is never a mystery whether
  you are transmitting.
- Each other player's row gets a **speaker button** — mute anyone individually.
  Your choices persist across reloads.
- Needs HTTPS (or localhost) — browsers won't grant a microphone otherwise.

**Some pairs will not connect without a relay.** STUN only tells each side its
public address; it cannot carry audio. When a player is behind strict NAT —
common on mobile carriers, university and office networks — there is no direct
path, and that pair fails no matter how long it retries. Everyone else in the
room is unaffected and chat keeps working.

This is not something the affected player can fix. It's set once on the server
and then works for everyone — the credentials are handed to each client as it
joins, so nobody configures a browser. On Render: **Environment** →

**Shared secret** (coturn's REST scheme, and Metered's static-auth endpoint).
Preferred: the server mints a credential that expires in 12 hours, so no
permanent password is ever sent to a browser.

| Variable | Example |
|---|---|
| `TURN_URLS` | `turn:relay.example.com:3478` (comma-separate for several) |
| `TURN_SECRET` | the relay's shared secret |

**Static credentials**, if that's all your provider gives you:

| Variable | Example |
|---|---|
| `TURN_URLS` | `turn:relay.example.com:3478` |
| `TURN_USERNAME` | username |
| `TURN_CREDENTIAL` | password |

`TURN_SECRET` wins if both are set. Where to get a relay:

- **[Cloudflare TURN](https://www.cloudflare.com/products/turn-sfu/)** — much the
  largest free allowance. Issues short-lived credentials through its own API
  rather than either scheme above, so it needs a little more code than these two
  env vars.
- **[Metered Open Relay](https://www.metered.ca/tools/openrelay/)** — 20 GB/month
  free, needs a free account.
- **Self-host [coturn](https://github.com/coturn/coturn)** on any small VPS, with
  `static-auth-secret` matching `TURN_SECRET`.

Relayed audio flows through that server, so it costs bandwidth — only the pairs
that need it use it; everyone else still connects directly.

For a one-off test without touching the server, a single browser can override:

```js
localStorage["cr.turn"] = JSON.stringify(
  { urls: "turn:your.host:3478", username: "u", credential: "p" })
```

**Voice check** (in the Voice section) reports whether a relay is configured,
along with the negotiated direction and packet counters for each peer.

Voice was confirmed working across two devices. Note that it cannot be tested on
a single machine: two peers there sit behind one NAT with the same reflexive
address, so ICE never completes and nothing past the connection — playback,
direction negotiation, transceiver association — is ever exercised. Every bug
this feature had lived in exactly that untestable half. Test it with two people.

### Chat is not filtered

Messages are relayed and displayed exactly as typed. There is no word list,
nothing is bleeped, and nothing is rewritten. This is a room you share by
sending someone a four-letter code — moderate it by choosing who you send it to.

Three limits exist, none of which look at what a message says:

- **Control characters are stripped** and messages are capped at 300 characters,
  so one message can't corrupt or blow up everyone else's view.
- **Six messages per four seconds per connection**, so one client can't flood
  the room or push the backlog out. It counts messages; it never reads them.
- **Text is rendered with `textContent`, never `innerHTML`.** This is a security
  boundary, not a content one: your text is drawn in every other player's
  browser, and building that markup by hand would let anyone in a room run
  script in everyone else's tab. Removing it would not make chat freer, it would
  make it an attack.

## Deploying

Any host that supports WebSockets works. Render is the least fiddly free option.

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com): **New → Web Service**, connect the repo.
3. Runtime **Node**, build `npm install`, start `npm start`.
4. Leave the instance type on **Free** and deploy.

Render sets `PORT` itself, and the server reads it — nothing to configure. The
WebSocket runs on the same origin and port as the page, so there's no URL to
hardcode; it works on `localhost` and behind HTTPS without changes.

**The one free-tier catch:** Render spins a free service down after ~15 minutes
of inactivity, and the next request takes roughly a minute to wake it. Send your
friend the link *before* you both sit down to play, or pay for the always-on
tier. Fly.io and Railway have the same trade-off in slightly different shapes.

## Notes

- `ws` is the only dependency.
- No build step, no bundler, no framework. Edit a file, restart, reload.
- Node 18+.

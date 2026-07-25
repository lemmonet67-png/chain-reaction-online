# Chain Reaction — online

Real-time multiplayer Chain Reaction. Orbs detonate at critical mass and cascade
across the grid; last reactor standing wins.

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

2 to 8 players, on grids from 5×7 up to 12×16.

Set **Your name** in the panel and it shows up on your seat for everyone in the
room; leave it blank and you get the element name for that seat. The **Board**
toggle switches between the classic arcade look (black, green wireframe) and the
instrument-console one. Both are remembered per browser.

**Local** — everything runs in the tab. Toggle any seat between `YOU` and `CPU`;
set them all to CPU and it plays itself.

**Online** — *Create room* gives you a 4-letter code and a shareable link.
Anyone who opens the link drops straight into the room. Play starts once every
seat is filled.

- Refreshing or losing your connection is safe. Your seat is held and reclaimed
  automatically via a token in `localStorage`.
- If someone doesn't show up or leaves for good, the host can click their
  `EMPTY` tag to hand the seat to the CPU and keep the game moving.
- Only the host can restart the run.
- Rooms are in memory only. They vanish on restart, and 45 minutes after the
  last player disconnects.

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

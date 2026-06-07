# WatchMovieTogether

Watch any movie together, in sync, while you see and hear each other. One shared
link → same room → synchronized playback + webcam/mic.

This repo is a **single Node app** that provides everything:

- the front-end (static, in `public/`)
- your **own WebRTC signaling** (self-hosted PeerJS at `/peerjs`)
- a **realtime control plane** at `/rt` (room roster, play/pause sync, "who is
  talking", and **chat**)
- an **admin dashboard** at `/admin` (live people-count + **chat monitoring**)
- **short-lived TURN credentials** at `/turn-credentials`

## Privacy model — read this first

- **Video and audio are peer-to-peer and end-to-end encrypted** (WebRTC,
  DTLS-SRTP). They never touch the server. Even you, the operator, cannot watch
  or listen.
- **Chat is different.** So that you can moderate it (e.g. spot illegal use),
  chat messages are **relayed and stored on the server** and shown in the admin
  dashboard. Chat is therefore **not** end-to-end encrypted. You become the
  controller of that chat data — see `SECURITY.md` and disclose it in your
  privacy policy. The app already shows users an in-room notice that messages
  may be reviewed.

## Architecture at a glance

```
Browser  ──(audio/video, P2P, E2E encrypted)──  Browser     ← never hits the server
   │                                               │
   └────────────── /rt (chat, sync, talking) ──────┘
                         │
                    Node server  ── /peerjs (signaling)   ── /admin (monitor)
                         │         ── /turn-credentials
                         │
                    coturn (TURN relay, your VPS or managed)  ← media only when P2P fails
```

Multi-party uses a **mesh** (everyone connects to everyone). This is good for
small groups (roughly up to 6–8 people). Beyond that you'd move to an **SFU**
(e.g. mediasoup / LiveKit / Janus) — that's the scaling path, not a quick toggle.

Only **one** remote camera is shown at a time. It rotates every 2 minutes and
switches immediately to whoever starts talking (with onset/hangover detection so
brief noises don't cause false switches). You still **hear** everyone.

## Deploy (the realtime server needs a host that keeps a process alive)

> ⚠️ **Vercel / GitHub Pages won't run this server.** They are serverless/static
> and don't keep a WebSocket process alive. Use Render, Railway, or Fly — all
> deploy straight from GitHub. (You *may* still host the static `public/` folder
> on Vercel and point it at your server with `SERVER_BASE` — see below.)

### Option A — Render (easiest, one Blueprint)

1. Push this repo to GitHub.
2. On Render: **New → Blueprint**, pick the repo. `render.yaml` is detected.
3. Set environment variables when prompted:
   - `ADMIN_PASSWORD` — a long random string (admin dashboard login)
   - `TURN_SECRET` — shared secret with your coturn (see below)
   - `TURN_URLS` — e.g. `turn:turn.watchmovietogether.com:3478,turns:turn.watchmovietogether.com:5349`
4. Deploy. Your app is at `https://<name>.onrender.com`, admin at `/admin`.
5. Add your domain (`www.watchmovietogether.com`) under the service's **Custom
   Domains** and point DNS as Render instructs.

Free tier sleeps when idle (cold start on first visit). Use a paid instance to
avoid that.

### Option B — Railway / Fly

Same idea: connect the GitHub repo, set the same env vars, `npm start` is the
start command. Fly: `fly launch` then `fly deploy` (it reads `package.json`).

### Local development

```bash
npm install
ADMIN_PASSWORD=secret123 npm start
# open http://localhost:8080  (admin at http://localhost:8080/admin)
```

Camera/mic need **https** (or `localhost`). On a deployed host you're on https
already.

## Your own TURN (temporary credentials)

The server hands out short-lived TURN credentials (coturn's `use-auth-secret`
HMAC scheme) at `/turn-credentials`. You just need a TURN server that shares the
same secret.

### Self-hosted coturn (full control)

1. Get a small VPS with a public, ideally static IP (Hetzner, DigitalOcean,
   Vultr, Lightsail). TURN needs open ports and a stable IP — it cannot run on
   Vercel/Render.
2. `sudo apt-get install coturn`, set `TURNSERVER_ENABLED=1` in
   `/etc/default/coturn`.
3. Copy `coturn/turnserver.conf` to `/etc/turnserver.conf` and edit the marked
   lines (`external-ip`, `realm`, TLS cert paths).
4. Set `static-auth-secret` in that file to the **same value** as `TURN_SECRET`
   on your Node server.
5. Open UDP/TCP `3478`, `5349`, and UDP `49152–65535` in the firewall.
6. `sudo systemctl enable --now coturn`.
7. On the Node server set `TURN_URLS` to your coturn URLs.

### Managed TURN (no VPS)

Use **Cloudflare Realtime (Calls)**, **Metered**, or **Twilio**. These give you
TURN endpoints and credentials via their API. Easiest integration: if the
provider supports the standard REST/HMAC scheme, set `TURN_URLS` + `TURN_SECRET`
to their values. Otherwise replace `makeTurnCredentials()` in `server/server.js`
with a call to the provider's credential API (a few lines).

Without any TURN configured, the app falls back to public STUN only — most
connections still work, but some strict/corporate/mobile networks will fail to
connect. TURN is the reliability backstop.

## Optional: YouTube search inside a room

The "▶ YouTube" button (only available **inside** a room) can search YouTube if
you provide a **YouTube Data API v3** key.

1. Create the key in Google Cloud Console.
2. **Restrict it**: Application restriction → HTTP referrers →
   `https://www.watchmovietogether.com/*` (and your Render URL). API restriction
   → YouTube Data API v3 only. Set a quota cap.
3. Put it in `public/index.html`: `var YT_API_KEY = "...";`

Browser-side keys are always visible in page source — restriction (not secrecy)
is the protection. Without a key, the button just opens youtube.com so people can
copy a link.

## Split hosting (static front-end elsewhere)

If you host `public/` on Vercel/Netlify and the Node server on Render, open
`public/index.html` and set:

```js
var SERVER_BASE = "https://<your-name>.onrender.com";
```

`/config`, `/turn-credentials`, `/rt` and `/peerjs` will then target the server.
(Same change in `public/admin.html`.) CORS for the GET endpoints is already
enabled.

## Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `PORT` | provided by the host | `8080` |
| `ADMIN_PASSWORD` | admin dashboard login | *(none — admin disabled)* |
| `TURN_SECRET` | shared secret with coturn | *(none — STUN only)* |
| `TURN_URLS` | comma-separated TURN URLs | *(none)* |
| `TURN_TTL` | credential lifetime (seconds) | `3600` |
| `MAX_ROOM` | max people per room | `8` |
| `CHAT_KEEP` | chat messages kept in memory per room | `300` |

## What still needs you / honest limitations

- **Real-device testing.** The HTTP/realtime/admin paths are tested. The actual
  peer-to-peer media (camera/mic) can only be verified with two real
  devices/browsers — test on phone + laptop on different networks before launch.
- **Chat is stored in memory only** (capped per room, lost on restart). For
  audit/retention you'd add a database — and then a retention policy.
- **Mesh limit ~6–8.** Larger rooms need an SFU.
- **Moderation at scale** (see `SECURITY.md`): manual reading doesn't scale;
  you'll want keyword flagging, a review queue, and a legal-reporting process.

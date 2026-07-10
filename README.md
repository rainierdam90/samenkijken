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
- **Chat and selected subtitle text are different.** Chat is relayed and stored
  temporarily so that you can moderate it (e.g. spot illegal use). Subtitle
  text for a direct video URL is relayed and held in the active room's memory
  so late joiners receive it, but is not shown in the admin dashboard.
  Neither chat nor subtitle text is end-to-end encrypted. You become the
  controller of that data — see `SECURITY.md` and disclose it in your privacy
  policy. The app already shows users an in-room notice that chat messages may
  be reviewed.

## Architecture at a glance

```
Browser  ──(audio/video, P2P, E2E encrypted)──  Browser     ← never hits the server
   │                                               │
   └───────── /rt (chat, subtitles, sync, talking) ───────┘
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
5. Add both `samecouch.com` **and** `www.samecouch.com` under the service's
   **Custom Domains** and point DNS as Render instructs. Do not rely on an HTTP
   redirect alone: the hosting platform must first issue a valid TLS certificate
   for `www.samecouch.com`, otherwise browsers fail before the redirect can run.
   The included Vercel configuration redirects `www` to the apex after TLS is valid.

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

# regression checks (includes a two-user realtime room test)
npm test
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

## Sharing photos & videos from your device (peer-to-peer)

Inside a room, tap **📷 Share** to pick photos/videos from your phone or computer.
Nothing is uploaded to any server — the picker just reads local files. You become
the **presenter**: pick an item with the ‹ › buttons (or tap a thumbnail) and
everyone in the room sees it. For videos, the existing play/pause/seek stays in
sync.

**How it works (so you understand the limits):** the bytes travel peer-to-peer.
Photos are sent whole. A video becomes playable after a **4 MB start buffer**;
the receiver sees live speed, remaining time and controls to pause/resume or
retry the transfer. Files up to 256 MB continue into a smooth local copy in the
background. Larger movies use a Service Worker (`public/sw.js`) and pull the
ranges currently being watched, so multi-gigabyte files do not have to fit in
memory and seeking still works. The server never sees these files.

On supported mobile browsers, SameCouch requests a screen wake lock while a
film is playing or a transfer is active. The lock is released when playback and
transfers stop, and reacquired after returning to the tab. This is best effort:
older iOS/browser versions without the Screen Wake Lock API can still sleep.

**Deployment requirement:** `sw.js` must be served from the **root of the
front-end origin** (same site as the page), as JavaScript. If you host the
front-end on Render it's already there. If you host it elsewhere (e.g. the static
site on `watchmovietogether.com`), make sure `sw.js` is deployed at
`https://watchmovietogether.com/sw.js`.

**Honest limits — please read before relying on it:**
- **Codecs.** A video only plays if the viewer's browser can decode it. **H.264
  MP4 plays almost everywhere.** iPhone-native **HEVC/H.265** often will *not*
  play on other devices, and there is no in-browser transcoding. For reliable
  sharing, use H.264 MP4.
- **The presenter does the uploading.** Each viewer pulls the bytes they watch
  from the presenter (mesh). A long film to several viewers is heavy on the
  presenter's connection — **put the presenter on Wi-Fi**, not mobile data, for
  big videos. This does not scale to large audiences (that needs an SFU/CDN).
- **iOS as a viewer of streamed video is the least reliable** (Safari + Service
  Worker media quirks). Photos are fine on iOS; desktop/Android are the most
  reliable for streamed video. Test your exact devices.
- **The presenter must stay in the room while a large movie is streaming.** A
  smaller file that finished transferring can keep playing after they leave.
- **Not moderatable.** Like the webcams, these files are pure peer-to-peer and
  never reach your server, so the admin dashboard cannot see them (see
  `SECURITY.md`).

## Subtitles for a pasted video URL

Paste a direct HTTPS video link ending in `.mp4`, `.webm`, `.ogg`, `.m4v` or
`.mov` and load it. The in-room controls then show **CC+**. Pick an `.srt` (or
`.vtt`) file of up to 512 KB; the browser converts SRT to WebVTT and enables it
in the native video player. Subtitle text is relayed to the room and remembered
for late joiners, but the video itself still comes directly from its URL.

The remote host must allow browser playback and byte-range requests. H.264 MP4
is the most compatible choice. Subtitle support here intentionally applies to
direct video URLs, not YouTube/Vimeo embeds or the photo/video gallery.

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
| `TURN_USERNAME` / `TURN_CREDENTIAL` | static creds for a managed TURN (instead of `TURN_SECRET`) | *(none)* |
| `TURN2_URLS` + (`TURN2_USERNAME`/`TURN2_CREDENTIAL` or `TURN2_SECRET`) | reserve TURN on a **different IP** so two relay-only peers (both on VPN/symmetric NAT) can still connect | *(none — reserve disabled)* |
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

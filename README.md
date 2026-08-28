# SameCouch

Watch any movie together, in sync, while you see and hear each other. One shared
link → same room → synchronized playback + webcam/mic.

This repo is a **single Node app** that provides everything:

- the generated front-end (static output in `public/`, editable source in `src/index.source.html`)
- your **own WebRTC signaling** (self-hosted PeerJS at `/peerjs`)
- a **realtime control plane** at `/rt` (room roster, play/pause sync, "who is
  talking", and **chat**)
- an **admin dashboard** at `/admin` (live people-count + **chat monitoring**)
- **short-lived TURN credentials** at `/turn-credentials`
- a protected, low-CPU **MKV/opaque-link remuxer** at `/mkv-stream` (FFmpeg stream-copy → fragmented MP4)
- an opt-in **connection check** (server latency, TURN reachability and bounded speed test)
- a room-synced **watchlist with voting**, exact-time reactions/bookmarks and an automatic evening recap

## Privacy model — read this first

- **Camera/microphone calls and files shared from a device are peer-to-peer and
  end-to-end encrypted** (WebRTC, DTLS-SRTP). The operator cannot watch or
  listen to calls or inspect device-shared files.
- **Chat and selected subtitle text are different.** Chat is relayed and stored
  temporarily so that you can moderate it (e.g. spot illegal use). Subtitle
  text for a direct video URL is relayed and held in the active room's memory
  so late joiners receive it, but is not shown in the admin dashboard.
  Neither chat nor subtitle text is end-to-end encrypted. You become the
  controller of that data — see `SECURITY.md` and disclose it in your privacy
  policy. The app already shows users an in-room notice that chat messages may
  be reviewed.
- **Remote MKV links use the low-CPU Node remuxer; opaque direct-video links may
  first try the browser when it reports full support.** The Node fallback copies
  the original video packets into fragmented MP4 without re-encoding them. Film
  bytes then temporarily pass
  through FFmpeg, are not stored, and are not end-to-end encrypted from source
  host to viewer. Disclose this too.

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

The diagram's P2P media path refers to calls and files shared from a device.
A pasted MKV source follows `source → Node/FFmpeg stream-copy → viewer`. An
opaque direct-video source can follow `source → viewer` only when the browser
reports full support, as described below.

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
avoid that. MKV video is stream-copied instead of encoded, so CPU use is low;
bandwidth still runs through the app whenever direct browser playback is not
available.

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

# after editing src/index.source.html
npm run build:frontend
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
3. Set the server environment variable `YT_API_KEY` to the restricted key.

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

## Streaming MKV and opaque direct-video links

Paste a public URL containing `.mkv` and SameCouch sends it through the low-CPU
remux route. This is deliberate: Chromium can sometimes show an MKV video track
while silently dropping an unsupported AC-3/DTS audio track. Opaque links without
an extension are only tried directly when the browser reports full support.
Otherwise, the Node server remuxes the existing video packets unchanged into
browser-compatible fragmented MP4.
This avoids video decoding, video encoding, quality loss and the associated CPU
load. Audio is converted to AAC by default because many MKVs use an audio codec
that browsers cannot decode; this is much lighter than video encoding.
For signed download endpoints or links without a visible extension, open the
content picker, choose **Video URL**, and paste the link there. FFmpeg inspects
the actual bytes, so the source does not need a perfect content type or filename.

Source compatibility is deliberately broad:

- every public `http://` or `https://` host is allowed by default;
- signed query strings, up to three redirects, generic content types and opaque
  download paths are accepted;
- CORS support at the source is not required because the Node server fetches it;
- login cookies, embedded credentials, DRM and extraction from a normal webpage
  are not supported or bypassed;
- private/local network addresses remain blocked to prevent SSRF. HTTPS sources
  still need a valid certificate.

`npm install` installs `ffmpeg-static`; alternatively set `FFMPEG_PATH` to a
system FFmpeg binary. Each viewer currently uses one lightweight remux process,
so two people watching means two FFmpeg processes and two source streams. Set
`MKV_MAX_STREAMS` to match available bandwidth. Remuxed streams support
play/pause synchronization, but arbitrary seeking and late-join catch-up are
less reliable than with a normal range-enabled MP4. Fragmented MP4 lets playback
begin before the entire source is received.

Stream-copy preserves the source video codec. H.264 in MKV is the most broadly
compatible case. HEVC/H.265 depends on the viewer's OS and browser, while AV1
requires a sufficiently new device. SameCouch intentionally does not fall back
to CPU-heavy video encoding; for an incompatible codec, create an H.264 version
once at the source instead. Set `MKV_COPY_AUDIO=1` only when you know the MKV's
audio codec is already accepted in MP4; this removes the small remaining audio
encode cost but reduces compatibility.

`ffmpeg-static` is distributed under GPL-3.0-or-later. Anyone operating or
redistributing this build is responsible for complying with that licence.

## IPTV: browse and watch together

The in-room **IPTV** button supports two provider types:

- an Xtream-compatible server login (server URL, username and password); and
- an M3U playlist URL, including a provider URL whose query contains credentials.

After one room member connects a source, everybody in that room receives only an
opaque, temporary source token. Library tab, category, search and series navigation
are relayed to the other participants, so an open IPTV library follows along while
the room browses. Choosing a live channel, film or episode loads one opaque playback
URL for everybody and uses the existing room play/pause/seek clock. HLS is handled
by native Safari playback where available and the local, pinned `hls.js` build in
other modern browsers.

Provider credentials are never put in room messages, generated media URLs,
browser storage or application logs. They remain in the Node process memory for
`IPTV_SOURCE_TTL` seconds after the last use. The gateway rewrites HLS manifests,
including variants, media segments, encryption-key URLs and subtitle renditions,
so original credential-bearing provider URLs do not reach browsers.

Embedded HLS subtitle tracks appear under **CC**. SameCouch also detects common
provider-supplied external SRT/VTT fields. When somebody selects an external file,
it is converted to WebVTT and shared through the existing room subtitle path;
subtitle language choices and timing adjustments remain available per viewer.

Operational limits:

- IPTV video, audio, manifest, artwork and provider-subtitle bytes pass through
  the SameCouch Node/VPS gateway. Budget outbound VPS bandwidth for every viewer;
  unlike files shared from a device, IPTV is not peer-to-peer.
- The source provider must permit concurrent streams for the number of viewers.
- DRM-protected services are not bypassed. A provider-specific browser DRM licence
  integration would be required and is intentionally outside this gateway.
- Private/reserved destinations, URL user-info and unapproved ports are blocked.
  Restrict public providers further with `IPTV_ALLOWED_HOSTS` if desired.
- Users must have permission from their provider and the rights to watch/share the
  selected content. SameCouch does not supply channels or subscriptions.

## Subtitles for a pasted video URL

Paste a direct video link ending in `.mp4`, `.webm`, `.ogg`, `.m4v`, `.mov` or
`.mkv` and load it. The in-room controls then show **CC+**. Pick an `.srt` (or
`.vtt`) file of up to 512 KB; the browser converts SRT to WebVTT and enables it
in the native video player. UTF-8, UTF-16 and common Windows-1252 SRT files are
accepted. Subtitle text is relayed to the room and remembered for late joiners.
For regular files the video comes directly from its URL; remuxed MKV streams
pass temporarily through the Node server as described above.

After a subtitle file is loaded, click **CC** again to turn subtitles off for
your own screen; click once more to turn them back on. The compact timing control
next to CC moves every cue **0.5 seconds earlier or later**. The displayed offset
resets to `0.0s` when clicked, and **SRT** lets you replace the subtitle file.
Enable/disable and timing offsets are local per viewer, which is useful when two
devices buffer a remuxed stream slightly differently.

In stage fullscreen, the SameCouch option strip remains available but fades out
after 2.5 seconds without mouse, touch or keyboard activity. It returns on the
next interaction and stays visible while hovered or keyboard-focused, keeping it
out of the subtitle area without making the room controls unreachable.

The remote host must allow browser playback and byte-range requests. H.264 MP4
is the most compatible choice. Subtitle support here intentionally applies to
direct/MKV video URLs, not YouTube/Vimeo embeds or the photo/video gallery.

## Front-end source and split hosting

`src/index.source.html` is the single editable room/landing-page source. Running
`npm run build:frontend` generates the small HTML shell plus
`public/samecouch-v3.css`, `public/samecouch-app-v3.js` and
`public/prepaint-v2.js`, and keeps the root/Vercel entrypoint synchronized.
`npm test` refuses to run when generated files are stale.

If you host `public/` on Vercel/Netlify and the Node server on Render, change
`REMOTE_BACKEND` in `src/index.source.html`, then rebuild:

```js
var REMOTE_BACKEND = "https://<your-name>.onrender.com";
```

`/config`, `/turn-credentials`, `/rt` and `/peerjs` will then target the server.
CORS for the public endpoints is already enabled. PeerJS, QR generation and
subtitle helpers are version-pinned/local and load only when their feature is
used; do not replace them with unpinned CDN scripts.

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
| `YT_API_KEY` | server-side YouTube Data API v3 key | *(search disabled)* |
| `DATABASE_URL` | Postgres persistence for rooms, wall, reminders and room subscriptions | *(SQLite fallback)* |
| `DB_PATH` | SQLite path when Postgres is not configured | `data/wmt.db` |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | Web Push keys for scheduled and room-live notifications | *(push disabled)* |
| `VAPID_SUBJECT` | Web Push contact URI | `mailto:admin@samecouch.com` |
| `FFMPEG_PATH` | optional path to a system FFmpeg binary; otherwise `ffmpeg-static` is used | bundled binary |
| `MKV_TOKEN_SECRET` | shared secret for short-lived stream tickets; set the same value on every app instance | random per process |
| `MKV_TOKEN_TTL` | stream-ticket lifetime in seconds | `300` |
| `MKV_MAX_STREAMS` | maximum simultaneous lightweight FFmpeg remux streams per app instance | `4` |
| `MKV_MAX_STREAMS_PER_IP` | simultaneous remux streams per viewer IP | `2` |
| `MKV_COPY_AUDIO` | copy audio too (lowest CPU, but only browser-compatible audio works) | `0` |
| `MKV_ALLOWED_HOSTS` | optional comma-separated exact/`*.suffix` allowlist; empty deliberately permits all public hosts | *(all public hosts)* |
| `MKV_TRUSTED_PRIVATE_HOSTS` | exact source hosts you own that may resolve privately, without restricting other public hosts | *(none)* |
| `MKV_ALLOWED_PORTS` | source ports allowed by the fetcher | `80,443,8080,8443` |
| `MKV_ALLOW_PRIVATE` | test/private-infrastructure escape hatch; also requires an explicit host allowlist | `0` |
| `IPTV_SOURCE_TTL` / `IPTV_STREAM_TTL` | idle lifetime for in-memory provider sessions and opaque playback tickets (seconds) | `21600` |
| `IPTV_MAX_SESSIONS` | maximum short-lived provider sessions per app instance | `250` |
| `IPTV_MAX_CATALOG_BYTES` / `IPTV_MAX_PLAYLIST_BYTES` | bounded provider API and M3U response sizes | `33554432` / `12582912` |
| `IPTV_MAX_STREAMS` / `IPTV_MAX_STREAMS_PER_IP` | simultaneous proxied IPTV resources globally/per viewer IP | `80` / `24` |
| `IPTV_ALLOWED_HOSTS` | optional comma-separated exact/`*.suffix` provider allowlist | *(all public hosts)* |
| `IPTV_TRUSTED_PRIVATE_HOSTS` | exact provider hosts you operate that may resolve to a private address | *(none)* |
| `IPTV_ALLOWED_PORTS` | provider ports accepted by the gateway | `80,443,8000,8080,8443,8880,25461` |
| `IPTV_PUBLIC_BASE` | optional explicit public Node origin for generated proxy URLs | forwarded request origin |

## What still needs you / honest limitations

- **Real-device testing.** The HTTP/realtime/admin paths are tested. The actual
  peer-to-peer media (camera/mic) can only be verified with two real
  devices/browsers — test on phone + laptop on different networks before launch.
- **Chat is stored in memory only** (capped per room, lost on restart). For
  audit/retention you'd add a database — and then a retention policy.
- **Mesh limit ~6–8.** Larger rooms need an SFU.
- **Moderation at scale** (see `SECURITY.md`): manual reading doesn't scale;
  you'll want keyword flagging, a review queue, and a legal-reporting process.

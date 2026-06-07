# Security & privacy

## The core trade-off you chose: chat is monitorable

To let you detect misuse (e.g. illegal coordination), this app routes chat
**through your server**, stores it (in memory, capped per room), and exposes it
in the admin dashboard.

**Consequence:** chat is **not end-to-end encrypted**. Anyone with server access
or the admin password can read room chat.

What is and isn't visible to you/the server:

| Data | Path | Server can see it? |
|------|------|--------------------|
| Webcam video | peer-to-peer (WebRTC) | **No** — end-to-end encrypted |
| Microphone audio | peer-to-peer (WebRTC) | **No** — end-to-end encrypted |
| Chat messages | relayed via `/rt` | **Yes** — stored + shown in `/admin` |
| Room code | sent to `/rt` to group people | Yes |
| Which video is loaded | relayed via `/rt` | Yes |

Video/audio are still private even from you. That's a feature — it limits your
liability for the most sensitive content — but it also means you **cannot**
monitor calls, only chat.

## Your obligations as the operator (you have a compliance background — this is the short version)

Because you can read and store chat, you are a **data controller** for it.
Before launch:

1. **Disclose it.** Your privacy policy must state that chat is relayed, stored,
   and may be reviewed for safety. The app already shows an in-room notice, but a
   notice is not a substitute for a policy.
2. **Lawful basis + minimization.** Decide your basis (legitimate interest for
   safety is the usual fit) and keep only what you need.
3. **Retention.** Chat is currently in-memory and capped (`CHAT_KEEP`, lost on
   restart). If you add a database, define and enforce a retention period and a
   deletion path. Don't keep chat forever by accident.
4. **Access control.** `ADMIN_PASSWORD` is the only thing protecting the
   dashboard. Use a long random value, store it only as an env var, never in the
   repo, rotate it periodically, and give it to as few people as possible. The
   admin page is `noindex`, but that is not access control.
5. **Breach exposure.** Stored chat is now something that can leak. Treat the
   server and any future chat database as sensitive.
6. **Jurisdiction.** GDPR (EU users), UK GDPR, UAE PDPL, and others may all
   apply depending on where your users are. A watch-together app will have users
   across borders.

## Moderation at scale (the "drug dealing etc." scenario)

Reading chat by hand works for a handful of rooms; it does not work at a million
users. Before you grow:

- **Automated flagging** (keyword/classifier) feeding a **review queue**, so
  humans look at flagged content rather than everything.
- **A reporting + enforcement path**: user reports, room bans, a way to respond
  to law-enforcement requests, and a documented process.
- **Mandatory reporting.** Child sexual abuse material and grooming are not
  "moderation" issues — in most jurisdictions they carry **legal reporting
  duties** (e.g. NCMEC in the US). Build a path to detect, preserve, and report
  before you have users, not after.
- **Age & abuse.** Decide minimum age, terms of service, and how you handle
  abusive users and repeat offenders.

## TURN credentials

- The server issues **short-lived** TURN credentials (coturn `use-auth-secret`
  HMAC, default 1-hour TTL). Clients fetch fresh ones; nothing long-lived ships
  to the browser.
- `TURN_SECRET` lives only in server env and must match coturn's
  `static-auth-secret`. If it leaks, rotate it on both sides.
- coturn is hardened in the provided config (denies relaying into private IP
  ranges, TLS, restricted port range). Keep it patched.

## Transport & general

- Serve everything over **https/wss** (camera/mic require a secure context
  anyway). Render/Railway/Fly give you TLS automatically; coturn needs its own
  cert (`turns:`).
- The YouTube Data API key (if used) is browser-side and therefore visible.
  Protect it by **HTTP-referrer restriction** + **API restriction** +
  **quota cap**, not by trying to hide it.

## Secret-scanning lesson (applies to any key you ever commit)

If a secret is ever committed (it happened with a YouTube key earlier):

1. **Rotate/revoke it** in the provider console. Deleting the line does **not**
   help — it stays in git history and, if the repo was ever public, was likely
   scraped within minutes.
2. Create a fresh, **restricted** replacement.
3. Only then is rewriting git history optional/cosmetic.
4. Mark the scanning alert **Revoked** (not "false positive").

Keep real secrets in environment variables (`ADMIN_PASSWORD`, `TURN_SECRET`),
never in the repo. `.env` is git-ignored; `.env.example` documents the names
only.

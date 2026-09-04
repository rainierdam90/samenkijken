#!/usr/bin/env bash
set -euo pipefail

umask 077
envfile="$(mktemp)"
trap 'rm -f "$envfile"' EXIT

turn_secret="$(sed -n 's/^[[:space:]]*static-auth-secret[[:space:]]*=[[:space:]]*//p' /etc/turnserver.conf | head -n 1)"
if [[ -z "$turn_secret" ]]; then
  echo "coturn static-auth-secret is missing" >&2
  exit 1
fi

admin_password="$(openssl rand -hex 32)"
mkv_secret="$(openssl rand -hex 32)"
visit_salt="$(openssl rand -hex 32)"

printf '%s\n' \
  'PORT=8090' \
  'DB_PATH=/var/lib/samecouch/wmt.db' \
  "ADMIN_PASSWORD=$admin_password" \
  "VISIT_SALT=$visit_salt" \
  "TURN_SECRET=$turn_secret" \
  'TURN_URLS=turn:turn.watchmovietogether.com:3478?transport=udp,turn:turn.watchmovietogether.com:3478?transport=tcp,turns:turn.watchmovietogether.com:443?transport=tcp' \
  'TURN_TTL=3600' \
  'MAX_ROOM=8' \
  'CHAT_KEEP=300' \
  "MKV_TOKEN_SECRET=$mkv_secret" \
  'MKV_TOKEN_TTL=300' \
  'MKV_MAX_STREAMS=8' \
  'MKV_MAX_STREAMS_PER_IP=4' \
  'MKV_MAX_TRANSCODES=1' \
  'MKV_MAX_TRANSCODES_PER_IP=1' \
  'MKV_TRANSCODE_THREADS=1' \
  'MKV_SHARED_BACKLOG=8388608' \
  'MKV_COPY_AUDIO=0' \
  'MKV_TRUSTED_PRIVATE_HOSTS=turn.watchmovietogether.com' \
  'MKV_ALLOWED_PORTS=80,443,8080,8443' \
  'IPTV_SOURCE_TTL=7200' \
  'IPTV_SOURCE_MAX_TTL=43200' \
  'IPTV_STREAM_TTL=1800' \
  'IPTV_STREAM_MAX_TTL=28800' \
  'IPTV_MAX_SESSIONS=25' \
  'IPTV_MAX_TICKETS=2000' \
  'IPTV_MAX_CATALOG_BYTES=16777216' \
  'IPTV_MAX_PLAYLIST_BYTES=12582912' \
  'IPTV_MAX_STREAMS=48' \
  'IPTV_MAX_STREAMS_PER_IP=16' \
  'IPTV_MAX_ART=24' \
  'IPTV_MAX_ART_PER_IP=12' \
  'IPTV_ALLOWED_PORTS=80,443,8000,8080,8443,8880,25461' \
  'IPTV_MEDIA_USER_AGENT=VLC/3.0.21 LibVLC/3.0.21' \
  'IPTV_PUBLIC_BASE=https://turn.watchmovietogether.com:8445' \
  'VAPID_SUBJECT=mailto:admin@samecouch.com' \
  > "$envfile"

export SAMECOUCH_ENV_FILE="$envfile"
cd /opt/samecouch
/usr/local/bin/node <<'NODE'
const fs = require("node:fs");
const webpush = require("web-push");
const keys = webpush.generateVAPIDKeys();
fs.appendFileSync(
  process.env.SAMECOUCH_ENV_FILE,
  `VAPID_PUBLIC=${keys.publicKey}\nVAPID_PRIVATE=${keys.privateKey}\n`,
  { encoding: "utf8", mode: 0o600 }
);
NODE

install -o root -g samecouch -m 0640 "$envfile" /etc/samecouch.env
printf '%s\n' "$admin_password" | install -o root -g root -m 0600 /dev/stdin /root/samecouch-admin-password

echo "Created /etc/samecouch.env with these settings:"
cut -d= -f1 /etc/samecouch.env | paste -sd, -

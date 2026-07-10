"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
const subtitles = require(path.join(ROOT, "public", "subtitles.js"));

test("inline application script parses", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.ok(scripts.length > 0);
  scripts.forEach((source, index) => new vm.Script(source, { filename: `inline-${index + 1}.js` }));
});

test("a participant name is required and has an inline accessible error", () => {
  assert.match(html, /id="ld_name"[^>]*\brequired\b[^>]*aria-describedby="ld_name_error"/);
  assert.match(html, /id="ld_name_error"[^>]*role="alert"[^>]*aria-live="polite"/);
  assert.match(html, /if\(!nm\)\{ myName=""; setNameError\(tr\("name_required"\)\)/);
});

test("YouTube activation cannot permanently cover the native player", () => {
  assert.match(html, /gateDismissed=true/);
  assert.match(html, /playgate\.hidden=true;\s*\/\/ never trap the native player/);
  assert.match(html, /yt_manual_play/);
  assert.match(html, /enablejsapi:1, origin:location\.origin/);
});

test("peer-to-peer file requests use a bounded reconnecting queue", () => {
  assert.match(html, /_wmtQueue\.length<100/);
  assert.match(html, /rejectDataPending\(pid,"data-stale"\)/);
  assert.match(html, /serialization:"binary"/);
  assert.match(html, /type:"gallery-fail"/);
});

test("large shared videos use a progressive start buffer with transfer controls", () => {
  assert.match(html, /START_BUFFER=4\*1024\*1024/);
  assert.match(html, /function galleryPlayable\(fileId\)/);
  assert.match(html, /type:"gallery-ready",fileId:fid/);
  assert.match(html, /id="xferMeta"/);
  assert.match(html, /id="xferPause"/);
  assert.match(html, /id="xferRetry"/);
  assert.match(html, /fmtRate\(speed\)/);
  assert.match(html, /fmtEta\(eta\)/);
});

test("mobile playback acquires and restores a screen wake lock", () => {
  assert.match(html, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(html, /mediaIsPlaying\(\)\|\|!!\(galleryXfer&&galleryXfer\.active&&!galleryXfer\.paused\)/);
  assert.match(html, /visibilitychange[^\n]+updateWakeLock\(\)/);
});

test("direct video URLs accept room-synced SRT or VTT subtitles", () => {
  assert.match(html, /id="subtitleInput"[^>]*accept="\.srt,\.vtt/);
  assert.match(html, /id="subtitleEarlier"/);
  assert.match(html, /id="subtitleOffset"/);
  assert.match(html, /id="subtitleLater"/);
  assert.match(html, /id="subtitleReplace"/);
  assert.match(html, /function srtToVtt\(text\)/);
  assert.match(html, /new Blob\(\[rendered\],\{type:"text\/vtt"\}\)/);
  assert.match(html, /rtSend\(\{type:"subtitle"/);
  assert.match(html, /case "subtitle"/);
  assert.match(html, /if\(currentSubtitle\) setSubtitleEnabled\(!subtitleEnabled\)/);
  assert.match(html, /setSubtitleOffset\(subtitleOffset-0\.5\)/);
  assert.match(html, /setSubtitleOffset\(subtitleOffset\+0\.5\)/);
});

test("SRT conversion handles real files, legacy encoding, and invalid input", () => {
  const srt = "\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nHallo café\r\n";
  const vtt = subtitles.toWebVtt(srt);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.250 --> 00:00:03\.500/);
  assert.match(vtt, /Hallo café/);
  const cp1252 = Uint8Array.from(Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nCaf\u00e9\n", "latin1"));
  assert.match(subtitles.toWebVtt(cp1252), /Café/);
  assert.match(subtitles.toWebVtt("webvtt\n\n00:00:00.000 --> 00:00:01.000\nHi"), /^WEBVTT/);
  assert.equal(subtitles.toWebVtt("not a subtitle"), "");
  assert.equal(subtitles.inferLanguage("movie.nl.srt"), "nl");

  const delayed = subtitles.shiftWebVtt(vtt, 1.5);
  assert.match(delayed, /00:00:02\.750 --> 00:00:05\.000/);
  const earlier = subtitles.shiftWebVtt(vtt, -2);
  assert.match(earlier, /00:00:00\.000 --> 00:00:01\.500/);
});

test("MKV and opaque direct links prefer native playback and use low-CPU remuxing", () => {
  assert.match(html, /\.mkv/);
  assert.match(html, /return \{ mode:"mkv", url:url, opaque:true \}/);
  assert.match(html, /\/mkv-prepare\?url=/);
  assert.match(html, /function browserCanPlayMkv\(url\)/);
  assert.match(html, /mediaNames\(url\)\)\) return false/);
  assert.match(html, /mkvDirectTrying/);
  assert.match(html, /function nativeMode\(\)/);
  assert.match(html, /pickKind==="url"/);
  assert.match(serverSource, /app\.get\("\/mkv-prepare"/);
  assert.match(serverSource, /app\.get\("\/mkv-stream"/);
  assert.match(serverSource, /frag_keyframe\+empty_moov\+default_base_moof/);
  assert.match(serverSource, /"-c:v", "copy"/);
  assert.doesNotMatch(serverSource, /"-c:v", "libx264"/);
  assert.match(serverSource, /maxPayload: 2 \* 1024 \* 1024/);
  assert.match(serverSource, /MKV_ALLOWED_PORTS \|\| "80,443,8080,8443"/);
  assert.match(serverSource, /MKV_TRUSTED_PRIVATE_HOSTS/);
});

test("SRT conversion handles real files, legacy encoding, and invalid input", () => {
  const srt = "\uFEFF1\r\n00:00:01,250 --> 00:00:03,500\r\nHallo café\r\n";
  const vtt = subtitles.toWebVtt(srt);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:01\.250 --> 00:00:03\.500/);
  assert.match(vtt, /Hallo café/);
  const cp1252 = Uint8Array.from(Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nCaf\u00e9\n", "latin1"));
  assert.match(subtitles.toWebVtt(cp1252), /Café/);
  assert.match(subtitles.toWebVtt("webvtt\n\n00:00:00.000 --> 00:00:01.000\nHi"), /^WEBVTT/);
  assert.equal(subtitles.toWebVtt("not a subtitle"), "");
  assert.equal(subtitles.inferLanguage("movie.nl.srt"), "nl");
});

test("MKV and opaque direct links use native controls and a remux fallback", () => {
  assert.match(html, /\.mkv/);
  assert.match(html, /return \{ mode:"mkv", url:url, opaque:true \}/);
  assert.match(html, /\/mkv-prepare\?url=/);
  assert.match(html, /function nativeMode\(\)/);
  assert.match(html, /pickKind==="url"/);
  assert.match(serverSource, /app\.get\("\/mkv-prepare"/);
  assert.match(serverSource, /app\.get\("\/mkv-stream"/);
  assert.match(serverSource, /frag_keyframe\+empty_moov\+default_base_moof/);
  assert.match(serverSource, /"-c:v", "copy"/);
  assert.doesNotMatch(serverSource, /"-c:v", "libx264"/);
  assert.match(serverSource, /maxPayload: 2 \* 1024 \* 1024/);
});

test("shared-media and YouTube results remain usable without a mouse or thumbnail", () => {
  assert.match(html, /document\.createElement\("button"\); d\.type="button"; d\.className="gthumb"/);
  assert.match(html, /className="yt-thumb-fallback"/);
  assert.match(html, /\.fbtn\{width:44px; height:44px; flex:0 0 auto\}/);
});

test("both Vercel entry points redirect www after TLS termination", () => {
  for (const file of ["vercel.json", path.join("public", "vercel.json")]) {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
    assert.ok(config.redirects.some(rule =>
      rule.has && rule.has.some(condition => condition.value === "www.samecouch.com") &&
      rule.destination === "https://samecouch.com/:path*"
    ), `${file} misses the www.samecouch.com redirect`);
  }
});

test("deployment policy allows HTTPS video and same-origin wake lock", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const headers = config.headers.flatMap(rule => rule.headers || []);
  const csp = headers.find(header => header.key === "Content-Security-Policy");
  const permissions = headers.find(header => header.key === "Permissions-Policy");
  assert.match(csp.value, /media-src[^;]*https:/);
  assert.match(permissions.value, /screen-wake-lock=\(self\)/);
});

test("fullscreen controls return on activity and auto-hide above subtitles", () => {
  assert.match(html, /\.stage:fullscreen \.floatctrls/);
  assert.match(html, /\.stage\.fs-controls-idle:fullscreen \.floatctrls/);
  assert.match(html, /stage\.classList\.add\("fs-controls-idle"\)/);
  assert.match(html, /setTimeout\(hideFullscreenControls,2500\)/);
  assert.match(html, /"mousemove","pointerdown","touchstart"/);
  assert.match(html, /document\.addEventListener\("fullscreenchange",fullscreenStateChanged\)/);
});

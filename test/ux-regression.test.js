"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

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
  assert.match(html, /function srtToVtt\(text\)/);
  assert.match(html, /new Blob\(\[vtt\],\{type:"text\/vtt"\}\)/);
  assert.match(html, /rtSend\(\{type:"subtitle"/);
  assert.match(html, /case "subtitle"/);
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

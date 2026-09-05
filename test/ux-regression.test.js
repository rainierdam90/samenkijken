"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const publicMarkup = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const rootMarkup = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "public", "samecouch-app-v3.js"), "utf8");
const iptvJs = fs.readFileSync(path.join(ROOT, "public", "iptv-client-v2.js"), "utf8");
const appCss = fs.readFileSync(path.join(ROOT, "public", "samecouch-v3.css"), "utf8");
// Most historical assertions intentionally scan the complete frontend bundle.
// Markup-specific checks continue to use publicMarkup/rootMarkup below.
const html = `${publicMarkup}\n${appCss}\n${appJs}`;
const rootHtml = `${rootMarkup}\n${appCss}\n${appJs}`;
const serverSource = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
const iptvServerSource = fs.readFileSync(path.join(ROOT, "server", "iptv.js"), "utf8");
const subtitles = require(path.join(ROOT, "public", "subtitles.js"));

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("generated frontend is split, synchronized, and parses", () => {
  assert.equal(publicMarkup, rootMarkup);
  assert.match(publicMarkup, /<link rel="stylesheet" href="\/samecouch-v3\.css"\s*\/>/);
  assert.match(publicMarkup, /<script src="\/prepaint-v2\.js"><\/script>/);
  assert.match(publicMarkup, /<script src="\/samecouch-app-v3\.js"><\/script>/);
  assert.match(publicMarkup, /<script src="\/iptv-client-v2\.js"><\/script>/);
  const inlineScripts = [...publicMarkup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.equal(inlineScripts.length, 0);
  new vm.Script(appJs, { filename: "samecouch-app-v3.js" });
  new vm.Script(iptvJs, { filename: "iptv-client-v1.js" });
  for (const legacy of ["prepaint-v1.js", "samecouch-v2.css", "samecouch-app-v2.js"])
    assert.equal(fs.existsSync(path.join(ROOT, "public", legacy)), false, `${legacy} must not survive a release build`);
});

test("critical landing assets are responsive, compressed, and local", () => {
  assert.match(publicMarkup, /<picture><source type="image\/avif"[^>]*samecouch-hero-480\.avif/);
  assert.match(publicMarkup, /<source type="image\/webp"[^>]*samecouch-hero-1024\.webp/);
  assert.doesNotMatch(publicMarkup, /samecouch-hero\.png/);
  assert.equal(fs.existsSync(path.join(ROOT, "public", "samecouch-hero.png")), false);
  for (const file of [
    "samecouch-hero-480.avif", "samecouch-hero-480.webp",
    "samecouch-hero-768.avif", "samecouch-hero-768.webp",
    "samecouch-hero-1024.avif", "samecouch-hero-1024.webp"
  ]) {
    assert.ok(fs.statSync(path.join(ROOT, "public", file)).size < 100 * 1024, `${file} is unexpectedly large`);
  }
});

test("heavy room helpers load locally and only when needed", () => {
  assert.doesNotMatch(publicMarkup, /cdnjs\.cloudflare\.com/);
  assert.doesNotMatch(publicMarkup, /<script[^>]+(?:peerjs|qrcodejs|subtitles)/i);
  assert.match(appJs, /function ensurePeerLibrary\(\).*\/vendor\/peerjs-1\.5\.5\.min\.js/);
  assert.match(appJs, /function ensureQrLibrary\(\).*\/vendor\/qrcodejs-1\.0\.0\.min\.js/);
  assert.match(appJs, /function ensureSubtitleHelpers\(\).*\/subtitles\.js/);
  assert.match(appJs, /function ensureHlsLibrary\(\).*\/vendor\/hls-1\.6\.16\.min\.js/);
  assert.ok(fs.statSync(path.join(ROOT, "public", "vendor", "hls-1.6.16.min.js")).size > 100 * 1024);
});

test("IPTV supports secure provider login, shared browsing, HLS and host subtitles", () => {
  assert.match(publicMarkup, /id="iptvBtn"/);
  assert.match(publicMarkup, /id="iptvServer"[^>]*type="url"/);
  assert.match(publicMarkup, /id="iptvUser"/);
  assert.match(publicMarkup, /id="iptvPass"[^>]*type="password"/);
  assert.match(publicMarkup, /id="iptvRemember"[^>]*type="checkbox"/);
  assert.match(publicMarkup, /id="iptvPlaylist"[^>]*type="url"/);
  assert.match(publicMarkup, /id="iptvSubModal"/);
  assert.doesNotMatch(publicMarkup, /id="iptvSeekRange"/);   // exactly one timeline: the video element's native, auto-hiding controls
  assert.match(appJs, /return \{ mode:"hls", url:url \}/);
  assert.match(appJs, /mode==="file"\|\|mode==="mkv"\|\|mode==="hls"/);
  assert.match(appJs, /new window\.Hls\(/);
  /* canPlayType("application/vnd.apple.mpegurl") answers "maybe" in Chrome — truthy, but Chrome
     cannot play HLS. Trusting it sent the raw playlist to the <video> element, which failed with
     DEMUXER_ERROR_COULD_NOT_PARSE, i.e. "this IPTV stream could not be played". The native path
     must be gated on Media Source Extensions being absent. */
  assert.match(appJs, /function canUseHlsJs\(\)/);
  assert.match(appJs, /MediaSource/);
  assert.match(appJs, /if\(!canUseHlsJs\(\)&&movie\.canPlayType\("application\/vnd\.apple\.mpegurl"\)\)/);
  assert.match(appJs, /case "iptv-source"/);
  assert.match(appJs, /case "iptv-nav"/);
  assert.match(iptvJs, /"X-SameCouch-IPTV"/);
  assert.match(iptvJs, /type:"iptv-source",token:source\.token/);
  assert.match(iptvJs, /type:"iptv-nav"/);
  assert.match(appJs, /iptv:!!currentMedia\.iptv/);   // every viewer must know it may use the IPTV fallback
  assert.match(appJs, /Events\.BUFFER_CODECS/);
  assert.match(appJs, /remuxIptvCurrent\("h264"\)/);
  assert.match(appJs, /savedSubs=iptvExternalSubs\.slice\(\)/);   // provider subtitles survive remux/transcode
  assert.match(appJs, /function streamIptvSubtitle\(sub,announce,startAt\)/);   // embedded provider text arrives incrementally while a long film plays, including after a seek
  assert.match(appJs, /response\.body\.getReader\(\)/);
  assert.match(appJs, /function seekIptvVod\(t,announce\)/);   // progressive transcodes seek by opening an opaque stream at the requested film time
  assert.match(appJs, /seekBase/);
  assert.match(appJs, /mediaSource\.duration=duration/);   // native controls show the complete VOD length, not only the generated fragment
  assert.match(appJs, /sourceBuffer\.timestampOffset=start/);   // a server-side seek stays on that one absolute native timeline
  assert.match(appJs, /function waitForIptvMseCapacity\(buffer,id\)/);   // bound forward buffering so a long VOD cannot exhaust browser memory
  assert.match(appJs, /if\(ahead<90\) return resolve\(\)/);
  assert.match(appJs, /movie\.addEventListener\("seeking"/);
  assert.match(appJs, /case "iptv-subtitle-track"/);   // selecting that track is shared with the room
  assert.match(appJs, /video==="h264"\?30000:12000/);   // a silent HTTP 200 cannot leave the remux player stuck at 0:00 forever
  assert.match(serverSource, /streamTicket\.url\.startsWith\("iptv:"\)/);   // no public-domain hairpin
  assert.match(serverSource, /iptvService\.remuxInputUrl/);   // FFmpeg gets a seekable opaque loopback URL, not the provider URL
  assert.match(serverSource, /min\(540/);   // HEVC fallback keeps enough CPU headroom to build a buffer on the two-core VPS
  assert.match(serverSource, /"-maxrate", "800k"/);   // the VPS-to-viewer route cannot be overrun by the provider's multi-megabit HEVC original
  assert.match(serverSource, /state\.ffmpeg\.stdout\.pause\(\)/);   // a slow HTTP viewer backpressures the shared transcoder instead of being disconnected
  assert.match(serverSource, /client\.once\("drain"/);
  assert.doesNotMatch(serverSource, /client\.writableLength > 4 \* 1024 \* 1024/);
  assert.doesNotMatch(serverSource, /MKV_STARTUP_BUFFER|startupReady/);   // never wait twelve seconds before sending the first playable bytes
  assert.match(iptvServerSource, /loopbackRequest\(req\).*equalInternalKey/s);   // the internal FFmpeg source is not a public proxy
  assert.match(iptvServerSource, /router\.get\("\/subtitle\/:ticket\/:index"/);
  assert.match(iptvServerSource, /"-c:s", "webvtt"/);
  assert.match(iptvServerSource, /"-map", "0:s:" \+ index/);   // subtitle selection uses its ordinal, independent of video/audio stream numbers
  assert.match(appJs, /function readIptvMseBatch\(reader,id,targetBytes\)/);
  assert.match(appJs, /readIptvMseBatch\(reader,id,384\*1024\)/);   // fetch must not wait for a SourceBuffer event after every tiny TCP chunk
  assert.match(appJs, /ahead>=12/);   // preserve quality and absorb ordinary WAN jitter before playback starts
  assert.match(iptvServerSource, /VLC\/3\.0\.21 LibVLC\/3\.0\.21/);   // common panels reject unknown media user agents
  assert.match(serverSource, /const iptv = !!m\.iptv && !!r\.iptvSource/);
  assert.doesNotMatch(iptvJs, /sessionStorage/);
  assert.match(iptvJs, /const rememberedLoginKey = "wmt_iptv_login_v1"/);
  assert.match(iptvJs, /localStorage\.setItem\(rememberedLoginKey/);
  assert.match(iptvJs, /localStorage\.removeItem\(rememberedLoginKey/);
  assert.match(iptvJs, /if \(rememberLogin\) saveRememberedLogin\(body\)/);   // save only after the provider accepted the login
  assert.doesNotMatch(iptvJs, /type:"iptv-source"[^\n]+username|type:"iptv-source"[^\n]+password/);
  assert.match(iptvJs, /limit:"18"/);
  assert.match(iptvJs, /grid\.addEventListener\("scroll"/);
  assert.match(appJs, /iptvGeneratedTracks\.indexOf\(trk\)>=0/);   // generated WebVTT tracks must not reappear as duplicate provider choices
});

test("a shared IPTV source reaches the room under its own message type", () => {
  /* The session payload carries its own `type` ("m3u"/"xtream"). Spreading it into the
     envelope silently overwrote type:"iptv-source", so guests dropped the message and
     never saw the host's catalogue. Keep the payload nested. */
  const serverJs = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  assert.doesNotMatch(serverJs, /\{\s*type:\s*"iptv-source",\s*\.\.\./);
  assert.match(serverJs, /type:\s*"iptv-source",\s*source:\s*r\.iptvSource/);
  assert.match(appJs, /case "iptv-source":.*m\.source/);
});

test("connection check, shared queue, timestamp moments, and recap are wired", () => {
  assert.match(publicMarkup, /id="ld_connection"/);
  assert.match(publicMarkup, /id="queueBtn"/);
  assert.match(publicMarkup, /id="momentBtn"/);
  assert.match(publicMarkup, /id="wallRecapBtn"/);
  assert.match(appJs, /function runConnectionCheck\(\)/);
  assert.match(appJs, /fetch\(httpBase\(\)\+"\/speed-test\?bytes="/);
  assert.match(appJs, /type:"queue-add"/);
  assert.match(appJs, /type:"moment-save"/);
  assert.match(appJs, /function collectRecap\(\)/);
  assert.match(serverSource, /app\.get\("\/speed-test"/);
  assert.match(serverSource, /m\.type === "queue-add"/);
  assert.match(serverSource, /m\.type === "moment-save"/);
});

test("language controls have accessible names", () => {
  assert.match(publicMarkup, /id="langSelL"[^>]*aria-label="Language"/);
  assert.match(publicMarkup, /id="langSel"[^>]*aria-label="Language"/);
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

test("shared file bytes use a framed raw fast path with a compatible fallback", () => {
  for (const sourceHtml of [html, rootHtml]) {
    assert.match(sourceHtml, /RAW_LABEL="wmt-file-v1"/);
    assert.match(sourceHtml, /RAW_FRAME_MAX=16300/);
    assert.match(sourceHtml, /serialization:"raw"/);
    assert.match(sourceHtml, /t:"file-raw-cap",v:1/);
    assert.match(sourceHtml, /d\.raw&&sendRawRange\(pid,d\.reqId,buf\)/);
    assert.match(sourceHtml, /dsend\(pid,\{t:"range-data",reqId:d\.reqId,buf:buf\}\)/);
  }
});

test("phone sharing is visible before app boot and reports real transfer speed", () => {
  const prepaint = fs.readFileSync(path.join(ROOT, "public", "prepaint-v2.js"), "utf8");
  assert.match(prepaint, /data-share-companion/);
  assert.match(appCss, /html\[data-share-companion\] \.companion\{display:flex/);
  assert.match(publicMarkup, /id="compTransfer"[^>]*aria-live="polite"/);
  assert.match(publicMarkup, /id="compXferPct"/);
  assert.match(publicMarkup, /id="compXferMeta"/);
  assert.match(appJs, /setCompanionTransfer\(tr\("comp_sending"\),pct,meta,"active"\)/);
  assert.match(appJs, /fmtRate\(presWait\.speed\[slow\]\)/);
  assert.doesNotMatch(appJs, /compStatus\.textContent=tr\("comp_shared"\)/);
});

test("slow mobile transfers start on the compatible path without premature timeouts", () => {
  assert.match(appJs, /if\(!rawCaps\[pid\]\)[\s\S]*return requestRange\(pid,fileId,start,end,false\)/);
  assert.match(appJs, /\},45000\)\}/);
  assert.match(appJs, /XFER_CHUNK=256\*1024/);
  assert.match(appJs, /chunkCount=Math\.ceil\(limit\/XFER_CHUNK\), W=6/);
  assert.match(appJs, /Date\.now\(\)-run\.lastProgress>60000/);
});

test("raw file frames reconstruct the requested bytes exactly", () => {
  const frames = [];
  const context = vm.createContext({
    RAW_MAGIC: 0x574d5431,
    RAW_HEADER: 16,
    RAW_FRAME_MAX: 16300,
    rawConns: { phone: { open: true, send: frame => frames.push(frame) } },
    dpending: {},
    clearTimeout
  });
  vm.runInContext([
    extractFunction(html, "toArrayBuffer"),
    extractFunction(html, "sendRawRange"),
    extractFunction(html, "settleDataPending"),
    extractFunction(html, "onRawData")
  ].join("\n"), context);

  const original = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 255);
  assert.equal(context.sendRawRange("phone", 77, original.buffer), true);
  assert.ok(frames.length > 1);
  assert.ok(frames.every(frame => frame.byteLength <= 16300));

  let reconstructed;
  context.dpending[77] = {
    pid: "phone", raw: true, rawReceived: 0, expected: original.byteLength,
    resolve: value => { reconstructed = value; },
    reject: error => { throw error; }
  };
  frames.forEach(frame => context.onRawData("phone", frame));
  assert.deepEqual(Buffer.from(reconstructed), Buffer.from(original));
  assert.equal(context.dpending[77], undefined);
});

test("file transfer remains separate from webcam and microphone calls", () => {
  assert.match(html, /peer\.call\(pid, localStream\|\|new MediaStream\(\)\)/);
  assert.match(html, /call\.answer\(localStream\|\|new MediaStream\(\)\)/);
  assert.match(html, /if\(shareMode\)\{ localStream=null/);
});

test("shared playback has one stable clock and never hard-rewinds a smooth viewer", () => {
  const authoritySource = extractFunction(appJs, "recomputeAuthority");
  assert.match(authoritySource, /isAuthority=!!isHost/);
  assert.doesNotMatch(authoritySource, /\.sort\(/);

  const context = vm.createContext({ Math });
  vm.runInContext(`${extractFunction(appJs, "heartbeatCorrection")}; this.correct=heartbeatCorrection`, context);
  const viewerAhead = context.correct(-5, true, false);
  assert.equal(viewerAhead.seek, false);
  assert.equal(viewerAhead.hold, 5000);
  const directBehind = context.correct(1, true, false);
  assert.equal(directBehind.seek, false);
  assert.ok(directBehind.rate > 1 && directBehind.rate <= 1.08);
  const farBehind = context.correct(6, true, false);
  assert.equal(farBehind.seek, true);
  const remuxBehind = context.correct(6, true, true);
  assert.equal(remuxBehind.seek, false);
  assert.equal(remuxBehind.rate, 1.08);

  const clockHealthSource = extractFunction(appJs, "syncClockHealthy");
  assert.match(clockHealthSource, /!nativeBuffering&&!movie\.seeking&&movie\.readyState>=3/);
  assert.match(appJs, /movie\.addEventListener\("seeked"/);
  assert.match(appJs, /if\(!consumeRemoteSeek\(\)\) broadcast\("seek"\)/);   // a programmatic seek must not echo back as a room seek
  assert.match(appJs, /function liveStream\(\)\{ return nativeMode\(\)&&iptvLive; \}/);   // remuxed live channels also opt out of clock correction entirely
  assert.match(appJs, /if\(liveStream\(\)\)\{ consumeRemoteSeek\(\); return; \}/);
  assert.match(appJs, /rtSend\(\{type:"sync",kind:on\?"buffering":"buffered-play"/);
  assert.match(serverSource, /kind === "heartbeat" \|\| kind === "buffering" \|\| kind === "buffered-play"/);
  assert.match(serverSource, /r\.host !== ws\._peerId/);
  assert.match(serverSource, /seq: r\.syncSeq, serverAt: Date\.now\(\)/);
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
  assert.match(serverSource, /transcodeVideo[\s\S]*"-c:v", "libx264"/);
  assert.match(serverSource, /process\.env\.MKV_MAX_TRANSCODES \|\| "1"/);
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
  assert.match(serverSource, /transcodeVideo[\s\S]*"-c:v", "libx264"/);
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
      rule.source === "/(.*)" && rule.destination === "https://samecouch.com/$1"
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
  const appPolicies = config.headers
    .filter(rule => rule.source === "/" || rule.source === "/index.html")
    .flatMap(rule => rule.headers || [])
    .filter(header => header.key === "Content-Security-Policy");
  assert.equal(appPolicies.length, 2);
  appPolicies.forEach(header => {
    assert.doesNotMatch(header.value.match(/script-src[^;]*/)[0], /unsafe-inline/);
    assert.doesNotMatch(header.value, /cdnjs\.cloudflare\.com/);
  });
});

test("fullscreen controls return on activity and auto-hide above subtitles", () => {
  assert.match(html, /\.stage:fullscreen \.floatctrls/);
  assert.match(html, /\.stage\.fs-controls-idle:fullscreen \.floatctrls/);
  assert.match(html, /stage\.classList\.add\("fs-controls-idle"\)/);
  assert.match(html, /setTimeout\(hideFullscreenControls,2500\)/);
  assert.match(html, /"mousemove","pointerdown","touchstart"/);
  assert.match(html, /document\.addEventListener\("fullscreenchange",fullscreenStateChanged\)/);
});

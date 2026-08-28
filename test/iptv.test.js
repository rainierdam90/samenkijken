"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { createIptvService } = require("../server/iptv");

function listen(server) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

test("IPTV credentials stay server-side while catalogs, HLS, VOD, series and subtitles work", async t => {
  let providerPort;
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${providerPort}`);
    const json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (url.pathname === "/player_api.php") {
      if (url.searchParams.get("username") !== "demo" || url.searchParams.get("password") !== "secret") { res.statusCode = 401; res.end(); return; }
      const action = url.searchParams.get("action");
      if (!action) return json({ user_info:{auth:1,status:"Active",exp_date:"1999999999"} });
      if (action === "get_live_categories") return json([{category_id:"1",category_name:"News"}]);
      if (action === "get_vod_categories") return json([{category_id:"2",category_name:"Films"}]);
      if (action === "get_series_categories") return json([{category_id:"3",category_name:"Drama"}]);
      if (action === "get_live_streams") return json([{stream_id:10,name:"Test News",category_id:"1",stream_icon:`http://127.0.0.1:${providerPort}/art.png`}]);
      if (action === "get_vod_streams") return json([{stream_id:20,name:"Test Film",category_id:"2",container_extension:"mp4",year:"2026",rating:"8.1"}]);
      if (action === "get_series") return json([{series_id:30,name:"Test Series",category_id:"3",cover:`http://127.0.0.1:${providerPort}/art.png`}]);
      if (action === "get_series_info") return json({episodes:{1:[{id:31,title:"Episode One",season:1,episode_num:1,container_extension:"mp4",info:{subtitles:[{file:`http://127.0.0.1:${providerPort}/subs/episode.en.vtt`,language:"en"}]}}]}});
      if (action === "get_vod_info") return json({info:{subtitles:[{file:`http://127.0.0.1:${providerPort}/subs/movie.nl.srt`,language:"nl"}]}});
    }
    if (url.pathname === "/live/demo/secret/10.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Nederlands",LANGUAGE="nl",URI="/subs/live.vtt"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,SUBTITLES="subs"\n/media/live.m3u8\n'); return;
    }
    if (url.pathname === "/media/live.m3u8") { res.setHeader("Content-Type", "application/vnd.apple.mpegurl"); res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n/segments/one.ts\n#EXT-X-ENDLIST\n"); return; }
    if (url.pathname === "/segments/one.ts") { res.setHeader("Content-Type", "video/mp2t"); res.end(Buffer.from("segment-bytes")); return; }
    if (url.pathname === "/movie/demo/secret/20.mp4") {
      const body=Buffer.from("0123456789movie"); const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range||"");
      if (match) { const start=+match[1], end=match[2]?+match[2]:body.length-1; res.statusCode=206; res.setHeader("Content-Range",`bytes ${start}-${end}/${body.length}`); res.setHeader("Content-Length",String(end-start+1)); res.setHeader("Content-Type","video/mp4"); res.end(body.subarray(start,end+1)); return; }
      res.setHeader("Content-Type", "video/mp4"); res.end(body); return;
    }
    if (url.pathname === "/series/demo/secret/31.mp4") { res.setHeader("Content-Type", "video/mp4"); res.end("episode-bytes"); return; }
    if (url.pathname === "/subs/live.vtt") { res.setHeader("Content-Type", "text/vtt"); res.end("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nLive subtitle\n"); return; }
    if (url.pathname === "/subs/movie.nl.srt") { res.setHeader("Content-Type", "application/x-subrip"); res.end("1\n00:00:00,000 --> 00:00:02,000\nFilm ondertitel\n"); return; }
    if (url.pathname === "/subs/episode.en.vtt") { res.setHeader("Content-Type", "text/vtt"); res.end("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nEpisode subtitle\n"); return; }
    if (url.pathname === "/art.png") { res.setHeader("Content-Type", "image/png"); res.end(Buffer.from([137,80,78,71,13,10,26,10])); return; }
    if (url.pathname === "/playlist.m3u") { res.setHeader("Content-Type", "application/x-mpegurl"); res.end(`#EXTM3U\n#EXTINF:-1 group-title="News",M3U News\nhttp://127.0.0.1:${providerPort}/live/demo/secret/10.m3u8\n`); return; }
    res.statusCode = 404; res.end();
  });
  providerPort = await listen(provider);

  const beforeTrusted=process.env.IPTV_TRUSTED_PRIVATE_HOSTS, beforePorts=process.env.IPTV_ALLOWED_PORTS;
  process.env.IPTV_TRUSTED_PRIVATE_HOSTS="127.0.0.1"; process.env.IPTV_ALLOWED_PORTS=String(providerPort);
  const app=express(); app.use(express.json());
  const service=createIptvService({authorizeRoom:(room,key)=>room==="qa-room"&&key==="qa-key",clientIp:()=>"qa",makeLimiter:()=>()=>true});
  app.use("/iptv",service.router); const appServer=http.createServer(app), appPort=await listen(appServer), appBase=`http://127.0.0.1:${appPort}`;
  t.after(async () => { await Promise.all([close(appServer),close(provider)]); if(beforeTrusted===undefined) delete process.env.IPTV_TRUSTED_PRIVATE_HOSTS; else process.env.IPTV_TRUSTED_PRIVATE_HOSTS=beforeTrusted; if(beforePorts===undefined) delete process.env.IPTV_ALLOWED_PORTS; else process.env.IPTV_ALLOWED_PORTS=beforePorts; });

  const connectResponse=await fetch(appBase+"/iptv/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"xtream",room:"qa-room",roomKey:"qa-key",server:`http://127.0.0.1:${providerPort}`,username:"demo",password:"secret"})});
  assert.equal(connectResponse.status,200); const connectText=await connectResponse.text(); assert.doesNotMatch(connectText,/demo|secret|player_api/); const connected=JSON.parse(connectText), token=connected.source.token;
  assert.equal(connected.categories.live[0].title,"News"); assert.ok(token);
  const auth={"X-SameCouch-IPTV":token};

  const liveCatalog=await (await fetch(appBase+"/iptv/catalog?kind=live",{headers:auth})).json();
  assert.equal(liveCatalog.items[0].title,"Test News"); assert.doesNotMatch(JSON.stringify(liveCatalog),/demo|secret/); assert.match(liveCatalog.items[0].image,/\/iptv\/art\//);
  const movieCatalog=await (await fetch(appBase+"/iptv/catalog?kind=movie",{headers:auth})).json();
  const seriesCatalog=await (await fetch(appBase+"/iptv/catalog?kind=series",{headers:auth})).json();
  const episodes=await (await fetch(appBase+"/iptv/series?id=30",{headers:auth})).json(); assert.equal(episodes.items[0].title,"Episode One");

  const live=await (await fetch(appBase+"/iptv/resolve",{method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({id:liveCatalog.items[0].id})})).json();
  assert.equal(live.playback.mode,"hls"); assert.equal(live.playback.live,true); assert.doesNotMatch(JSON.stringify(live),/demo|secret/);
  const master=await (await fetch(live.playback.url)).text(); assert.doesNotMatch(master,/demo|secret|127\.0\.0\.1.*live/); assert.match(master,/\/iptv\/resource\//);
  const subtitleUrl=master.match(/URI="([^"]+)"/)[1], variantUrl=master.split("\n").find(line=>/^https?:/.test(line));
  assert.match(await (await fetch(subtitleUrl)).text(),/Live subtitle/);
  const mediaManifest=await (await fetch(variantUrl)).text(), segmentUrl=mediaManifest.split("\n").find(line=>/^https?:/.test(line)); assert.equal(await (await fetch(segmentUrl)).text(),"segment-bytes");

  const movie=await (await fetch(appBase+"/iptv/resolve",{method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({id:movieCatalog.items[0].id})})).json();
  assert.equal(movie.playback.mode,"file"); assert.equal(movie.playback.subtitles[0].lang,"nl"); assert.match(await (await fetch(movie.playback.subtitles[0].url)).text(),/Film ondertitel/);
  const ranged=await fetch(movie.playback.url,{headers:{range:"bytes=2-5"}}); assert.equal(ranged.status,206); assert.equal(await ranged.text(),"2345");
  assert.equal(seriesCatalog.items[0].kind,"series");

  const m3uResponse=await fetch(appBase+"/iptv/connect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({type:"m3u",room:"qa-room",roomKey:"qa-key",playlistUrl:`http://127.0.0.1:${providerPort}/playlist.m3u?username=demo&password=secret`})});
  const m3uText=await m3uResponse.text(); assert.equal(m3uResponse.status,200); assert.doesNotMatch(m3uText,/demo|secret/); const m3u=JSON.parse(m3uText);
  const m3uCatalog=await (await fetch(appBase+"/iptv/catalog?kind=live",{headers:{"X-SameCouch-IPTV":m3u.source.token}})).json(); assert.equal(m3uCatalog.items[0].title,"M3U News"); assert.doesNotMatch(JSON.stringify(m3uCatalog),/demo|secret/);
});

/* Catalogue thumbnails once shared the video pipe's concurrency slots and the API rate limit,
   so browsing a provider with logos exhausted both and every later call came back as
   "the IPTV gateway is busy" — including the film the room was trying to start. */
test("browsing artwork never starves playback or the API budget", async t => {
  let providerPort;
  const held = [];
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${providerPort}`);
    if (url.pathname === "/slow-art.png") { res.setHeader("Content-Type", "image/png"); held.push(res); return; }   // stays open, holding a slot
    if (url.pathname === "/playlist.m3u") { res.setHeader("Content-Type", "application/x-mpegurl"); res.end(`#EXTM3U\n#EXTINF:-1 tvg-logo="http://127.0.0.1:${providerPort}/slow-art.png",Chan\nhttp://127.0.0.1:${providerPort}/clip.mp4\n`); return; }
    if (url.pathname === "/clip.mp4") { res.setHeader("Content-Type", "video/mp4"); res.end(Buffer.from("movie-bytes")); return; }
    res.statusCode = 404; res.end();
  });
  providerPort = await listen(provider);

  const before = { trusted: process.env.IPTV_TRUSTED_PRIVATE_HOSTS, ports: process.env.IPTV_ALLOWED_PORTS, art: process.env.IPTV_MAX_ART_PER_IP, streams: process.env.IPTV_MAX_STREAMS_PER_IP };
  process.env.IPTV_TRUSTED_PRIVATE_HOSTS = "127.0.0.1"; process.env.IPTV_ALLOWED_PORTS = String(providerPort);
  process.env.IPTV_MAX_ART_PER_IP = "4"; process.env.IPTV_MAX_STREAMS_PER_IP = "2";

  const app = express(); app.use(express.json());
  const service = createIptvService({ authorizeRoom: (room, key) => room === "qa-room" && key === "qa-key", clientIp: () => "qa", makeLimiter: () => () => true });
  app.use("/iptv", service.router);
  const appServer = http.createServer(app), appPort = await listen(appServer), appBase = `http://127.0.0.1:${appPort}`;
  t.after(async () => {
    held.forEach(res => { try { res.end(); } catch (_) {} });
    await Promise.all([close(appServer), close(provider)]);
    Object.entries({ IPTV_TRUSTED_PRIVATE_HOSTS: before.trusted, IPTV_ALLOWED_PORTS: before.ports, IPTV_MAX_ART_PER_IP: before.art, IPTV_MAX_STREAMS_PER_IP: before.streams })
      .forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  });

  const connected = await (await fetch(appBase + "/iptv/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "m3u", room: "qa-room", roomKey: "qa-key", playlistUrl: `http://127.0.0.1:${providerPort}/playlist.m3u` }) })).json();
  const token = connected.source.token;
  let catalog = await (await fetch(appBase + "/iptv/catalog?kind=live", { headers: { "X-SameCouch-IPTV": token } })).json();
  if (!catalog.items.length) catalog = await (await fetch(appBase + "/iptv/catalog?kind=movie", { headers: { "X-SameCouch-IPTV": token } })).json();
  const artUrl = catalog.items[0] && catalog.items[0].image;
  assert.ok(artUrl, "the channel should expose a proxied logo");

  // Fill the artwork pool to its per-IP ceiling and leave every request hanging.
  const pending = Array.from({ length: 4 }, () => fetch(artUrl).catch(() => null));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(held.length, 4, "all four thumbnails should be in flight");

  // Playback must still get through: it has its own slots.
  const resolved = await (await fetch(appBase + "/iptv/resolve", { method: "POST", headers: { "content-type": "application/json", "X-SameCouch-IPTV": token }, body: JSON.stringify({ id: catalog.items[0].id }) })).json();
  const play = await fetch(resolved.playback.url);
  assert.equal(play.status, 200, "artwork must not consume the stream pool");
  assert.equal(await play.text(), "movie-bytes");

  held.forEach(res => { try { res.end(); } catch (_) {} });
  await Promise.all(pending);
});

/* Fallback for codecs the browser can't decode (AC-3 etc.): /remux hands the player a
   /mkv-stream path. Its token is only base64+HMAC — readable — so it must wrap the OPAQUE
   resource URL, never the credentialed provider URL. And live must use the pipe-able TS variant. */
test("the remux fallback returns an opaque, credential-free stream path", async t => {
  let providerPort;
  const seen = [];
  const provider = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${providerPort}`);
    seen.push(url.pathname);
    const json = value => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (url.pathname === "/player_api.php") {
      if (url.searchParams.get("username") !== "demo" || url.searchParams.get("password") !== "secret") { res.statusCode = 401; return res.end(); }
      const action = url.searchParams.get("action");
      if (!action) return json({ user_info: { auth: 1, status: "Active", exp_date: "1999999999" } });
      if (action === "get_live_categories") return json([{ category_id: "1", category_name: "News" }]);
      if (action === "get_live_streams") return json([{ stream_id: 10, name: "News", category_id: "1" }]);
      return json([]);
    }
    if (url.pathname === "/live/demo/secret/10.ts") { res.setHeader("Content-Type", "video/mp2t"); return res.end(Buffer.from("ts-bytes")); }
    res.statusCode = 404; res.end();
  });
  providerPort = await listen(provider);

  const before = { trusted: process.env.IPTV_TRUSTED_PRIVATE_HOSTS, ports: process.env.IPTV_ALLOWED_PORTS };
  process.env.IPTV_TRUSTED_PRIVATE_HOSTS = "127.0.0.1"; process.env.IPTV_ALLOWED_PORTS = String(providerPort);
  const app = express(); app.use(express.json());
  const service = createIptvService({
    authorizeRoom: (room, key) => room === "qa-room" && key === "qa-key",
    clientIp: () => "qa", makeLimiter: () => () => true,
    makeStreamToken: url => "tok." + Buffer.from(url).toString("base64url")   // stub mirroring the real base64+HMAC shape
  });
  app.use("/iptv", service.router);
  const appServer = http.createServer(app), appPort = await listen(appServer), appBase = `http://127.0.0.1:${appPort}`;
  t.after(async () => {
    await Promise.all([close(appServer), close(provider)]);
    if (before.trusted === undefined) delete process.env.IPTV_TRUSTED_PRIVATE_HOSTS; else process.env.IPTV_TRUSTED_PRIVATE_HOSTS = before.trusted;
    if (before.ports === undefined) delete process.env.IPTV_ALLOWED_PORTS; else process.env.IPTV_ALLOWED_PORTS = before.ports;
  });

  const connected = await (await fetch(appBase + "/iptv/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "xtream", room: "qa-room", roomKey: "qa-key", server: `http://127.0.0.1:${providerPort}`, username: "demo", password: "secret" }) })).json();
  const token = connected.source.token;
  const catalog = await (await fetch(appBase + "/iptv/catalog?kind=live", { headers: { "X-SameCouch-IPTV": token } })).json();

  const remux = await (await fetch(appBase + "/iptv/remux", { method: "POST", headers: { "X-SameCouch-IPTV": token, "content-type": "application/json" }, body: JSON.stringify({ id: catalog.items[0].id }) })).json();
  assert.match(remux.streamPath, /^\/mkv-stream\?token=/, "remux returns a /mkv-stream path");
  assert.equal(remux.live, true);

  const wrapped = Buffer.from(decodeURIComponent(remux.streamPath.split("token=")[1]).slice(4), "base64url").toString("utf8");
  assert.doesNotMatch(wrapped, /demo|secret/, "the token must not carry the provider credentials");
  assert.match(wrapped, /\/iptv\/resource\//, "the token wraps the opaque resource URL");

  // and that opaque URL, when fetched, streams the credentialed TS variant server-side
  const opaque = wrapped.replace(/^"?url"?:?/, "").match(/https?:\/\/[^"]+/)[0];
  assert.equal(await (await fetch(opaque)).text(), "ts-bytes");
  assert.ok(seen.includes("/live/demo/secret/10.ts"), "live remux must pull the pipe-able .ts variant, not the .m3u8");
});

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

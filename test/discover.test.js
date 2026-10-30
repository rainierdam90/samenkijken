"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscover } = require("../server/discover");

/* Offline: every upstream is a canned response, so these tests never touch the internet. */
function fakeFetch(routes) {
  return async (url) => {
    const hit = Object.keys(routes).find(prefix => String(url).startsWith(prefix));
    if (!hit) return { ok: false, status: 404, text: async () => "" };
    const body = typeof routes[hit] === "function" ? routes[hit](url) : routes[hit];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const PRIVATE = async () => [{ address: "127.0.0.1", family: 4 }];
const blockedIp = (a) => /^(127\.|10\.|192\.168\.)/.test(a);

test("Internet Archive: picks the best browser-playable MP4 and refuses items without one", async () => {
  const d = createDiscover({ blockedIp, fetchImpl: fakeFetch({
    "https://archive.org/metadata/good_film": { metadata: { title: "Good Film" }, files: [
      { name: "good.ogv", format: "Ogg Video" }, { name: "good_512kb.mp4", format: "512Kb MPEG4", length: "100" },
      { name: "good.mp4", format: "h.264", length: "4880.7", size: "180000000" } ] },
    "https://archive.org/metadata/no_video": { metadata: { title: "No Video" }, files: [{ name: "x.ogv", format: "Ogg Video" }] },
    "https://archive.org/metadata/dark_item": { is_dark: true, files: [] }
  }) });
  const ok = await d._internal.archivePlay("good_film");
  assert.equal(ok.url, "https://archive.org/download/good_film/good.mp4");
  assert.equal(ok.duration, 4881); assert.equal(ok.live, false);
  await assert.rejects(d._internal.archivePlay("no_video"), e => e.code === "not_playable");
  await assert.rejects(d._internal.archivePlay("dark_item"), e => e.code === "not_playable");
  await assert.rejects(d._internal.archivePlay("../etc/passwd"), e => e.code === "bad_request");
});

test("Radio: only https streams in a browser-playable codec that passed the last check", async () => {
  const station = (o) => Object.assign({ stationuuid: "11111111-1111-1111-1111-111111111111", name: "S", codec: "MP3", lastcheckok: 1, url_resolved: "https://stream.example/live" }, o);
  const d = createDiscover({ blockedIp, fetchImpl: fakeFetch({ "https://de1.api.radio-browser.info/json/stations/search": [
    station({ name: "Good" }),
    station({ name: "Plain http", url_resolved: "http://stream.example/live" }),
    station({ name: "HLS", url_resolved: "https://stream.example/live.m3u8" }),
    station({ name: "Broken", lastcheckok: 0 }),
    station({ name: "Weird codec", codec: "WMA" })
  ] }) });
  const list = await d._internal.radioSearch("", "NL");
  assert.deepEqual(list.map(x => x.title), ["Good"]);
  assert.equal(list[0].url, "https://stream.example/live");
});

test("PeerTube: refuses private/bogus hosts and picks the best file up to 720p", async () => {
  const uuid = "37d9573c-a89f-4973-b1f2-4e9975f8c49a";
  const video = { name: "Natuur", duration: 600, isLive: false, files: [], streamingPlaylists: [{ files: [
    { resolution: { id: 1080 }, fileUrl: "https://tube.example/f-1080.mp4" },
    { resolution: { id: 720 }, fileUrl: "https://tube.example/f-720.mp4" },
    { resolution: { id: 0 }, fileUrl: "https://tube.example/audio.mp4" } ] }] };
  const d = createDiscover({ blockedIp, lookup: PUBLIC, fetchImpl: fakeFetch({ "https://tube.example/api/v1/videos/": video }) });
  const r = await d._internal.peertubePlay("tube.example/" + uuid);
  assert.equal(r.url, "https://tube.example/f-720.mp4");
  const priv = createDiscover({ blockedIp, lookup: PRIVATE, fetchImpl: fakeFetch({}) });
  await assert.rejects(priv._internal.peertubePlay("evil.example/" + uuid), e => e.code === "bad_request");
  await assert.rejects(d._internal.peertubePlay("localhost/" + uuid), e => e.code === "bad_request");
  await assert.rejects(d._internal.peertubePlay("127.0.0.1/" + uuid), e => e.code === "bad_request");
  const live = createDiscover({ blockedIp, lookup: PUBLIC, fetchImpl: fakeFetch({ "https://tube.example/api/v1/videos/": Object.assign({}, video, { isLive: true }) }) });
  await assert.rejects(live._internal.peertubePlay("tube.example/" + uuid), e => e.code === "not_playable");
});

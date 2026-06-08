/* WatchMovieTogether — streaming Service Worker
 *
 * Lets a <video>/<img> play from a virtual URL (/wmt-stream/<fileId>) whose bytes
 * actually live on ANOTHER user's device (the presenter). For each range the media
 * element requests, this worker asks the page (via MessageChannel); the page fetches
 * that byte range peer-to-peer from the presenter and hands it back. Nothing is
 * uploaded to any server, and the whole file is never held in memory — only the
 * chunks currently being played. Seeking triggers fresh range requests.
 */
"use strict";

const FILES = {};            // fileId -> { size, mime }
const CHUNK = 1024 * 1024;   // pull 1 MB per round-trip

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const d = e.data;
  if (d && d.type === "register") FILES[d.fileId] = { size: d.size, mime: d.mime || "" };
  if (d && d.type === "unregister") delete FILES[d.fileId];
});

/* ---- Web Push: scheduled watch-party reminders ---- */
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  const title = data.title || "WatchMovieTogether";
  const opts = {
    body: data.body || "Your watch party is starting!",
    icon: data.icon || "/icon.svg",
    badge: data.badge || "/icon.svg",
    tag: data.tag || "wmt-reminder",
    data: { url: data.url || "/" },
    requireInteraction: true
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) { if (c.url.indexOf(url) !== -1 && "focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (e) => {
  let url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/wmt-stream/") !== 0) return;
  e.respondWith(handle(e));
});

function askPage(clientId, fileId, start, end) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; reject(new Error("timeout")); } }, 25000);
    ch.port1.onmessage = (ev) => {
      if (done) return; done = true; clearTimeout(to);
      if (ev.data && ev.data.ok && ev.data.buf) resolve(ev.data.buf);
      else reject(new Error("no-data"));
    };
    const post = (client) => {
      if (!client) { reject(new Error("no-client")); return; }
      client.postMessage({ type: "range", fileId, start, end }, [ch.port2]);
    };
    if (clientId) {
      self.clients.get(clientId).then((c) => {
        if (c) post(c);
        else self.clients.matchAll({ type: "window" }).then((cs) => post(cs[0]));
      });
    } else {
      self.clients.matchAll({ type: "window" }).then((cs) => post(cs[0]));
    }
  });
}

function handle(e) {
  const url = new URL(e.request.url);
  const fileId = decodeURIComponent(url.pathname.slice("/wmt-stream/".length));
  const meta = FILES[fileId] || {};
  const size = (typeof meta.size === "number") ? meta.size : undefined;
  const mime = meta.mime || "application/octet-stream";
  const clientId = e.clientId || e.resultingClientId || "";

  const rangeHeader = e.request.headers.get("range");
  let start = 0;
  let end = (size != null) ? size - 1 : undefined;
  let partial = false;
  if (rangeHeader) {
    const mm = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (mm) {
      start = parseInt(mm[1], 10);
      end = mm[2] ? parseInt(mm[2], 10) : ((size != null) ? size - 1 : undefined);
      partial = true;
    }
  }

  let pos = start;
  const stream = new ReadableStream({
    pull(ctrl) {
      if (size != null && pos > end) { ctrl.close(); return; }
      const to = (end != null) ? Math.min(end, pos + CHUNK - 1) : (pos + CHUNK - 1);
      return askPage(clientId, fileId, pos, to).then((buf) => {
        if (!buf || buf.byteLength === 0) { ctrl.close(); return; }
        ctrl.enqueue(new Uint8Array(buf));
        pos += buf.byteLength;
        if (size != null && pos > end) ctrl.close();
      }).catch(() => { try { ctrl.close(); } catch (_) {} });
    }
  });

  const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  let status = 200;
  if (partial && size != null) {
    status = 206;
    headers["Content-Range"] = "bytes " + start + "-" + end + "/" + size;
    headers["Content-Length"] = String(end - start + 1);
  } else if (size != null) {
    headers["Content-Length"] = String(size);
  }
  return new Response(stream, { status, headers });
}

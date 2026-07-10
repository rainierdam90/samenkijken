(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SameCouchSubtitles = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_FILE_BYTES = 512 * 1024;
  var LANGS = /[._-](en|nl|de|fr|es|ar|zh|ja|ko|hi|ur)(?:[._-]|\.srt$|\.vtt$)/;
  var SRT_TIME = /^((?:\d{1,2}:)?\d{2}:\d{2})[,.](\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2})[,.](\d{3})(.*)$/;

  function decodeInput(input) {
    if (typeof input === "string") return input;
    var bytes = null;
    if (typeof ArrayBuffer !== "undefined" && input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (!bytes) return String(input == null ? "" : input);
    if (typeof TextDecoder !== "undefined") {
      var encoding = (bytes[0] === 255 && bytes[1] === 254) ? "utf-16le" : (bytes[0] === 254 && bytes[1] === 255) ? "utf-16be" : "utf-8";
      var text = new TextDecoder(encoding).decode(bytes);
      if (encoding === "utf-8" && text.indexOf("\uFFFD") >= 0) {
        try { text = new TextDecoder("windows-1252").decode(bytes); } catch (_) {}
      }
      return text;
    }
    var out = ""; for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]); return out;
  }

  function inferLanguage(name) {
    var match = String(name || "").toLowerCase().match(LANGS);
    return match ? match[1] : "und";
  }

  function timestampMs(value) {
    var parts = String(value || "").split(":");
    if (parts.length === 2) parts.unshift("0");
    if (parts.length !== 3) return NaN;
    var seconds = Number(parts[2]), minutes = Number(parts[1]), hours = Number(parts[0]);
    return isFinite(seconds) && isFinite(minutes) && isFinite(hours) ? Math.round((hours * 3600 + minutes * 60 + seconds) * 1000) : NaN;
  }

  function formatTimestamp(ms) {
    ms = Math.max(0, Math.round(Number(ms) || 0));
    var hours = Math.floor(ms / 3600000); ms -= hours * 3600000;
    var minutes = Math.floor(ms / 60000); ms -= minutes * 60000;
    var seconds = Math.floor(ms / 1000), millis = ms - seconds * 1000;
    function pad(value, size) { value = String(value); while (value.length < size) value = "0" + value; return value; }
    return pad(hours, 2) + ":" + pad(minutes, 2) + ":" + pad(seconds, 2) + "." + pad(millis, 3);
  }

  function shiftWebVtt(input, offsetSeconds) {
    var shift = Math.round((Number(offsetSeconds) || 0) * 1000);
    var timing = /^(\s*)((?:\d{1,3}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}\.\d{3})(.*)$/;
    return String(input || "").split("\n").map(function (line) {
      var match = line.match(timing); if (!match) return line;
      var start = timestampMs(match[2]), end = timestampMs(match[3]);
      if (!isFinite(start) || !isFinite(end)) return line;
      start = Math.max(0, start + shift); end = Math.max(start + 1, end + shift);
      return match[1] + formatTimestamp(start) + " --> " + formatTimestamp(end) + (match[4] || "");
    }).join("\n");
  }

  function toWebVtt(input) {
    var text = decodeInput(input)
      .replace(/^\uFEFF/, "")
      .replace(/\0/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (!text || text.indexOf("-->") < 0) return "";
    if (/^WEBVTT(?:\s|$)/i.test(text)) return text.replace(/^WEBVTT/i, "WEBVTT") + "\n";

    var validCues = 0;
    var lines = text.split("\n").map(function (line) {
      if (line.indexOf("-->") < 0) return line;
      var match = line.trim().match(SRT_TIME);
      if (!match) return line;
      validCues++;
      return match[1] + "." + match[2] + " --> " + match[3] + "." + match[4] + (match[5] || "");
    });
    return validCues ? "WEBVTT\n\n" + lines.join("\n") + "\n" : "";
  }

  return { MAX_FILE_BYTES: MAX_FILE_BYTES, decodeInput: decodeInput, inferLanguage: inferLanguage, toWebVtt: toWebVtt, shiftWebVtt: shiftWebVtt };
});

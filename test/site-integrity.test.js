"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

test("every static page has unique ids and resolvable local assets", () => {
  const pages = fs.readdirSync(PUBLIC).filter(name => name.endsWith(".html"));
  assert.ok(pages.includes("index.html"));
  const missing = [];
  for (const page of pages) {
    const source = fs.readFileSync(path.join(PUBLIC, page), "utf8");
    const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `${page} contains duplicate element ids`);

    for (const match of source.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const raw = match[1];
      if (!raw.startsWith("/") || raw.startsWith("//")) continue;
      const pathname = raw.split(/[?#]/)[0];
      if (!pathname || pathname === "/") continue;
      const local = path.join(PUBLIC, decodeURIComponent(pathname.slice(1)));
      if (!fs.existsSync(local)) missing.push(`${page}: ${raw}`);
    }
  }
  assert.deepEqual(missing, [], `missing local files:\n${missing.join("\n")}`);
});

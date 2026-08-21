"use strict";

/*
 * public/index.html and the root compatibility entry point are generated from
 * one readable source. CSS and application JavaScript are extracted into
 * independently cacheable files; --check makes CI fail on generated drift.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "src", "index.source.html");
const source = fs.readFileSync(sourcePath, "utf8");

function take(label, re) {
  const match = source.match(re);
  if (!match) throw new Error(`Could not find ${label} in ${sourcePath}`);
  return match;
}

const prepaint = take("pre-paint script", /<script>(\/\* pre-paint:[\s\S]*?)<\/script>/);
const styles = take("main stylesheet", /<style>\r?\n([\s\S]*?)\r?\n<\/style>/);
const app = take("application script", /  <script>\r?\n  \(function \(\) \{([\s\S]*?)\r?\n  \}\)\(\);\r?\n  <\/script>/);

let html = source;
html = html.replace(prepaint[0], '<script src="/prepaint-v1.js"></script>');
html = html.replace(styles[0], '<link rel="stylesheet" href="/samecouch-v2.css" />');
html = html.replace(app[0], '  <script src="/samecouch-app-v2.js"></script>');

const outputs = new Map([
  [path.join(root, "public", "prepaint-v1.js"), prepaint[1].trim() + "\n"],
  [path.join(root, "public", "samecouch-v2.css"), styles[1].trim() + "\n"],
  [path.join(root, "public", "samecouch-app-v2.js"), "(function () {" + app[1] + "\n})();\n"],
  [path.join(root, "public", "index.html"), html],
  [path.join(root, "index.html"), html],
  [path.join(root, "public", "vercel.json"), fs.readFileSync(path.join(root, "vercel.json"), "utf8")],
]);

const check = process.argv.includes("--check");
let drift = false;
for (const [file, contents] of outputs) {
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== contents) {
      console.error(`Generated frontend is stale: ${path.relative(root, file)}`);
      drift = true;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}
if (drift) process.exitCode = 1;
else console.log(check ? "Generated frontend is in sync." : "Built SameCouch frontend from src/index.source.html.");

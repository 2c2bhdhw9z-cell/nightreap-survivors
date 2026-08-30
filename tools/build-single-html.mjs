/**
 * Fold an `expo export --platform web` output into ONE self-contained .html file.
 *
 * WHY
 * A phone with no computer attached cannot run a dev server, and a multi-file export cannot be
 * opened from the Files app because every path in it is absolute (`/_expo/...`). Inlining
 * everything removes both problems: one file, no paths, no server, no network.
 *
 * WHAT IT DOES
 *   1. Base64s every asset and rewrites the bundle's asset path strings to data URIs.
 *   2. Inlines the JS bundle into the HTML (escaping `</script` so the tag cannot close early).
 *   3. Injects a small shim, because `file://` is a hostile environment:
 *        - history.pushState/replaceState throw SecurityError on an opaque origin. expo-router
 *          calls them, so they are wrapped rather than left to take the app down.
 *        - localStorage access can throw on file://. AsyncStorage-web uses it, so a memory
 *          fallback is installed if the real one is unreachable.
 *
 * USAGE
 *   bunx expo export --platform web --output-dir .webdist   (from packages/mobile)
 *   node tools/build-single-html.mjs .webdist nightreap.html
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const distDir = process.argv[2] ?? ".webdist";
const outFile = process.argv[3] ?? "nightreap.html";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Every file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const allFiles = walk(distDir);

// ---- 1. asset path -> data URI -------------------------------------------------------------
const assetFiles = allFiles.filter((f) => {
  const rel = "/" + relative(distDir, f).split("\\").join("/");
  return rel.startsWith("/assets/") && MIME[extname(f).toLowerCase()];
});

const dataUris = new Map();
for (const file of assetFiles) {
  const rel = "/" + relative(distDir, file).split("\\").join("/");
  const mime = MIME[extname(file).toLowerCase()];
  const b64 = readFileSync(file).toString("base64");
  dataUris.set(rel, `data:${mime};base64,${b64}`);
}

// ---- 2. the JS bundle ----------------------------------------------------------------------
// Only the bundles index.html actually references, in the order it references them. The export
// also emits per-route chunks for static rendering; concatenating those produces a duplicate
// module registry and a syntax error, so they are deliberately left out.
const htmlRaw = readFileSync(join(distDir, "index.html"), "utf8");
const referenced = [...htmlRaw.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1]);

const jsFiles = referenced
  .map((src) => join(distDir, src.replace(/^\//, "")))
  .filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });

if (jsFiles.length === 0) throw new Error("index.html referenced no bundle — did the export run?");

let js = jsFiles.map((f) => readFileSync(f, "utf8")).join("\n;\n");

// Longest paths first, so a shorter path can never partially match inside a longer one.
const sortedPaths = [...dataUris.keys()].sort((a, b) => b.length - a.length);
let rewritten = 0;
for (const path of sortedPaths) {
  const uri = dataUris.get(path);
  const before = js;
  js = js.split(path).join(uri);
  if (js !== before) rewritten++;
}

// ---- 2b. force the router's initial route to "/" --------------------------------------------
// expo-router derives its initial route from `new URL(window.location.href)`. In a single file
// that URL is `file:///.../nightreap.html` (or `https://host/whatever.html` if hosted at a
// non-root path), so the pathname never matches a route and every launch lands on
// "Unmatched Route". Pinning the initial URL to "/" makes the app open on the title screen
// regardless of where the file physically lives.
//
// In-app navigation is unaffected: React Navigation keeps its state in memory, and the
// history.pushState calls it makes are already wrapped by the shim below.
const ROUTER_ORIGIN = "new URL(window.location.href)";
const ROUTER_PINNED = "new URL('/','http://localhost')";

const originCount = js.split(ROUTER_ORIGIN).length - 1;
if (originCount !== 1) {
  console.error(
    `FATAL — expected exactly 1 occurrence of \`${ROUTER_ORIGIN}\`, found ${originCount}.\n` +
      `The bundle shape changed; re-inspect how expo-router resolves its initial URL before trusting this build.`,
  );
  process.exit(1);
}
js = js.split(ROUTER_ORIGIN).join(ROUTER_PINNED);

// ---- 3. the file:// survival shim ----------------------------------------------------------
const shim = `
(function () {
  // history.pushState throws SecurityError on an opaque (file://) origin. expo-router calls it
  // during navigation, and an uncaught throw there takes the whole screen down.
  try {
    var H = window.history;
    ["pushState", "replaceState"].forEach(function (name) {
      var original = H[name];
      if (typeof original !== "function") return;
      H[name] = function () {
        try { return original.apply(H, arguments); } catch (e) { /* opaque origin: ignore */ }
      };
    });
  } catch (e) {}

  // AsyncStorage-web writes to localStorage. Reading it can throw on file://, so swap in a
  // memory shim when that happens: the save simply does not persist between launches.
  try {
    window.localStorage.getItem("__probe__");
  } catch (e) {
    var mem = {};
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
          setItem: function (k, v) { mem[k] = String(v); },
          removeItem: function (k) { delete mem[k]; },
          clear: function () { mem = {}; },
          key: function (i) { return Object.keys(mem)[i] ?? null; },
          get length() { return Object.keys(mem).length; },
        },
      });
    } catch (e2) {}
  }

  // Surface boot failures on screen. Without this a file:// error is invisible on a phone,
  // where there is no console to open.
  window.addEventListener("error", function (ev) {
    var el = document.getElementById("boot-error");
    if (!el) return;
    el.style.display = "block";
    el.textContent = "Boot error: " + (ev.message || "unknown");
  });
})();
`;

// ---- 3b. syntax-check the bundle before it ever reaches a phone ----------------------------
// A phone has no console. Catching a syntax error here is the difference between a clear failure
// on this machine and a blank screen in the user's hand.
try {
  new Function(js);
} catch (err) {
  console.error(`FATAL — assembled bundle is not valid JS: ${err.message}`);
  process.exit(1);
}

// ---- 4. assemble ---------------------------------------------------------------------------
let html = readFileSync(join(distDir, "index.html"), "utf8");

// Drop the external favicon and the external bundle tag; both are absolute paths.
html = html.replace(/<link[^>]*rel="icon"[^>]*>/gi, "");
html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/gi, "");

// A visible target for the error handler above.
html = html.replace(
  '<div id="root"></div>',
  '<div id="root"></div>\n    <pre id="boot-error" style="display:none;position:fixed;left:0;right:0;bottom:0;margin:0;padding:10px;background:#3b0d0d;color:#ffb4b4;font:12px/1.4 monospace;white-space:pre-wrap;z-index:99999"></pre>',
);

// The bundle is carried as base64 rather than as raw inline text.
//
// Escaping `</script` is not sufficient. Inside a <script>, the HTML tokenizer also reacts to
// `<!--` and to a nested `<script`, which flip it into "double escaped" states where the closing
// tag stops behaving as expected. A minified bundle contains those sequences inside string
// literals, which is why raw inlining produced "Invalid or unexpected token" even though the JS
// itself parsed cleanly. Base64 contains only [A-Za-z0-9+/=], so the tokenizer has nothing to
// react to at all.
//
// Decoding goes through TextDecoder so multi-byte UTF-8 in the bundle survives; `atob` alone
// yields latin1 and would corrupt any non-ASCII character.
const b64 = Buffer.from(js, "utf8").toString("base64");

const loader = `
(function () {
  var raw = document.getElementById("app-bundle").textContent;
  var bin = atob(raw);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var src = new TextDecoder("utf-8").decode(bytes);
  (0, eval)(src);
})();
`;

html = html.replace(
  "</body>",
  `  <script>${shim}</script>\n` +
    `  <script id="app-bundle" type="text/plain">${b64}</script>\n` +
    `  <script>${loader}</script>\n</body>`,
);

writeFileSync(outFile, html);

const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`assets inlined:      ${dataUris.size}`);
console.log(`asset paths rewritten: ${rewritten}`);
console.log(`js bundles inlined:  ${jsFiles.length}`);
console.log(`output:              ${outFile} (${mb} MB)`);

// ---- 5. prove it is actually self-contained ------------------------------------------------
const leftovers = [
  ...html.matchAll(/(?:src|href)\s*=\s*"(\/[^"]*)"/gi),
  ...html.matchAll(/"(\/(?:assets|_expo)\/[^"]*)"/gi),
];
const external = [...new Set(leftovers.map((m) => m[1]))];
if (external.length > 0) {
  console.log(`\nWARNING — ${external.length} absolute reference(s) still present:`);
  for (const ref of external.slice(0, 20)) console.log(`  ${ref}`);
  process.exitCode = 1;
} else {
  console.log(`\nself-contained: no absolute /asset or /_expo references remain`);
}

/**
 * Fold an `expo export --platform web` output into ONE self-contained .html file.
 *
 * WHY
 * A phone with no computer attached cannot run a dev server, and a multi-file export cannot be
 * opened outside a web root because every path in it is absolute (`/_expo/...`). Inlining
 * everything removes both problems: one file, no paths, no server, no network.
 *
 * THREE TRAPS THIS FILE EXISTS TO AVOID
 *
 *   1. `String.prototype.replace` interprets `$$`, `$&`, "$backtick" and `$'` in the REPLACEMENT
 *      string. A minified bundle contains all of them (61, 10, 5 and 1 occurrence respectively in
 *      the build this was written against), so splicing the bundle in via `replace(x, bundle)`
 *      silently corrupts it — `$&` alone expands to the matched text and "$backtick" expands to the
 *      entire preceding document. Every splice here uses split/join, which has no such behaviour.
 *      This was the actual cause of a mystifying "Invalid or unexpected token"; the HTML tokenizer
 *      was never involved.
 *
 *   2. expo-router derives its initial route from `new URL(window.location.href)`. In a single file
 *      that is `file:///.../game.html`, or `https://host/whatever.html` when hosted at a non-root
 *      path, so the pathname matches no route and every launch lands on "Unmatched Route". The
 *      initial URL is pinned to "/" below.
 *
 *   3. `file://` is an opaque origin: `history.pushState` and `localStorage` both throw there.
 *      expo-router calls the former and AsyncStorage-web uses the latter, so both are shimmed.
 *
 * USAGE
 *   cd packages/mobile && bunx expo export --platform web --output-dir ../../.webdist
 *   cd ../.. && node tools/build-single-html.mjs .webdist nightreap.html
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const distDir = process.argv[2] ?? ".webdist";
const outFile = process.argv[3] ?? "nightreap.html";

/** Recompress JPEGs above this size. They are base64'd, which costs a further 33%. */
const JPEG_RECOMPRESS_OVER = 120 * 1024;
/** Long-edge cap. A 3x phone screen is ~1500px; beyond that is invisible detail at real cost. */
const JPEG_MAX_EDGE = 1500;
const JPEG_QUALITY = 78;

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

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Splice without `$`-pattern interpretation. See trap 1. */
function spliceAt(haystack, needle, replacement) {
  const parts = haystack.split(needle);
  if (parts.length !== 2) {
    throw new Error(`expected exactly 1 occurrence of ${JSON.stringify(needle)}, found ${parts.length - 1}`);
  }
  return parts[0] + replacement + parts[1];
}

const allFiles = walk(distDir);
const htmlRaw = readFileSync(join(distDir, "index.html"), "utf8");

// ---- 1. the JS bundle(s) index.html actually references --------------------------------------
// Per-route chunks emitted for static rendering are deliberately excluded: concatenating them
// produces a duplicate module registry.
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

// ---- 2. pin the router's initial route to "/" (trap 2) --------------------------------------
const ROUTER_ORIGIN = "new URL(window.location.href)";
const ROUTER_PINNED = "new URL('/','http://localhost')";
const originCount = js.split(ROUTER_ORIGIN).length - 1;
if (originCount !== 1) {
  console.error(
    `FATAL — expected exactly 1 occurrence of \`${ROUTER_ORIGIN}\`, found ${originCount}.\n` +
      `The bundle shape changed; re-inspect how expo-router resolves its initial URL.`,
  );
  process.exit(1);
}
js = js.split(ROUTER_ORIGIN).join(ROUTER_PINNED);

// ---- 3. assets -> data URIs ------------------------------------------------------------------
let sharp = null;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.log("note: sharp unavailable — images inlined at original size");
}

const assetFiles = allFiles.filter((f) => {
  const rel = "/" + relative(distDir, f).split("\\").join("/");
  return rel.startsWith("/assets/") && MIME[extname(f).toLowerCase()];
});

const dataUris = new Map();
let savedBytes = 0;

for (const file of assetFiles) {
  const rel = "/" + relative(distDir, file).split("\\").join("/");
  const ext = extname(file).toLowerCase();
  let buf = readFileSync(file);
  let mime = MIME[ext];

  if (sharp && (ext === ".jpg" || ext === ".jpeg") && buf.length > JPEG_RECOMPRESS_OVER) {
    const before = buf.length;
    const meta = await sharp(buf).metadata();
    const shrunk = await sharp(buf)
      .resize({
        width: Math.min(meta.width ?? JPEG_MAX_EDGE, JPEG_MAX_EDGE),
        height: Math.min(meta.height ?? JPEG_MAX_EDGE, JPEG_MAX_EDGE),
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    if (shrunk.length < buf.length) {
      console.log(
        `  recompressed ${rel.split("/").pop()}: ${(before / 1024).toFixed(0)}KB -> ${(shrunk.length / 1024).toFixed(0)}KB` +
          ` (${meta.width}x${meta.height})`,
      );
      savedBytes += before - shrunk.length;
      buf = shrunk;
    }
  }

  dataUris.set(rel, `data:${mime};base64,${buf.toString("base64")}`);
}

// Longest paths first, so a shorter path cannot partially match inside a longer one.
let rewritten = 0;
for (const path of [...dataUris.keys()].sort((a, b) => b.length - a.length)) {
  const before = js;
  js = js.split(path).join(dataUris.get(path));
  if (js !== before) rewritten++;
}

// ---- 4. syntax-check before it ever reaches a phone -----------------------------------------
// A phone has no console. Catching this here is the difference between a clear failure on this
// machine and a blank screen in someone's hand.
try {
  new Function(js);
} catch (err) {
  console.error(`FATAL — assembled bundle is not valid JS: ${err.message}`);
  process.exit(1);
}

// Cheap insurance. Zero occurrences in the build this was written against, but a future asset or
// string could introduce one, and it would truncate the script tag.
const safeJs = js.split("</script").join("<\\/script");

// ---- 5. the file:// survival shim (trap 3) ---------------------------------------------------
const shim = `
(function () {
  try {
    var H = window.history;
    ["pushState", "replaceState"].forEach(function (name) {
      var original = H[name];
      if (typeof original !== "function") return;
      H[name] = function () {
        try { return original.apply(H, arguments); } catch (e) { /* opaque origin */ }
      };
    });
  } catch (e) {}

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

  window.addEventListener("error", function (ev) {
    var el = document.getElementById("boot-error");
    if (!el) return;
    el.style.display = "block";
    el.textContent = "Boot error: " + (ev.message || "unknown");
  });
})();
`;

// ---- 6. assemble (split/join only — trap 1) -------------------------------------------------
let html = htmlRaw
  .split(/<link[^>]*rel="icon"[^>]*>/i)
  .join("")
  .split(/<script[^>]*src="[^"]*"[^>]*><\/script>/i)
  .join("");

html = spliceAt(
  html,
  '<div id="root"></div>',
  '<div id="root"></div>\n    <pre id="boot-error" style="display:none;position:fixed;left:0;right:0;bottom:0;margin:0;padding:10px;background:#3b0d0d;color:#ffb4b4;font:12px/1.4 monospace;white-space:pre-wrap;z-index:99999"></pre>',
);

html = spliceAt(html, "</body>", `  <script>${shim}</script>\n  <script>${safeJs}</script>\n</body>`);

writeFileSync(outFile, html);

// ---- 7. report and prove self-containment ---------------------------------------------------
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`\nassets inlined:        ${dataUris.size}`);
console.log(`asset paths rewritten: ${rewritten}`);
console.log(`js bundles inlined:    ${jsFiles.length}`);
if (savedBytes > 0) console.log(`image bytes saved:     ${(savedBytes / 1024).toFixed(0)}KB (pre-base64)`);
console.log(`output:                ${outFile} (${mb} MB)`);

// Two different questions, and only the first one can break the file.
//
//   (a) Does the HTML still point at something on disk? A src/href attribute the browser will try
//       to fetch is fatal in a single file.
//   (b) Does the bundle still contain a path-shaped STRING? expo-router keeps a route manifest
//       naming its own static chunks. Nothing fetches those in a client-rendered launch, so they
//       are noise rather than breakage — reported, not failed on.
const htmlRefs = [
  ...new Set([...html.matchAll(/(?:src|href)\s*=\s*"(\/[^"]*)"/gi)].map((m) => m[1])),
];
const assetRefs = [
  ...new Set(
    [...html.matchAll(/"(\/assets\/[^"]*\.(?:png|jpe?g|gif|webp|ico|svg|ttf|otf|woff2?))"/gi)].map((m) => m[1]),
  ),
];
const chunkRefs = [
  ...new Set([...html.matchAll(/"(\/_expo\/[^"]*\.js)"/gi)].map((m) => m[1])),
];

if (htmlRefs.length > 0 || assetRefs.length > 0) {
  console.log(`\nFAIL — the file is not self-contained:`);
  for (const ref of [...htmlRefs, ...assetRefs].slice(0, 20)) console.log(`  ${ref}`);
  process.exitCode = 1;
} else {
  console.log(`self-contained:        no fetchable external references remain`);
  if (chunkRefs.length > 0) {
    console.log(
      `  (${chunkRefs.length} inert route-manifest string${chunkRefs.length === 1 ? "" : "s"} left in the bundle; nothing fetches them)`,
    );
  }
}

// Bundles each extension entry point into dist/ and copies static files.
// Load dist/ as an unpacked extension in chrome://extensions.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const harness = process.argv.includes("--harness");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const f of ["manifest.json", "popup.html"]) cpSync(`src/${f}`, `dist/${f}`);
cpSync("icons", "dist/icons", { recursive: true });

const options = {
  entryPoints: { background: "src/background.ts", content: "src/content.ts", overlay: "src/overlay.ts", popup: "src/popup.ts" },
  bundle: true,
  outdir: "dist",
  format: "iife", // content scripts can't be ES modules; IIFE works for every entry
  target: "chrome120",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  define: { __TEST_PROVIDER__: "undefined" },
};

// dev/gmail.html test page: real background + content code with a chrome.* stand-in.
if (harness) {
  await build({ ...options, entryPoints: { harness: "dev/harness.ts", "popup-harness": "dev/popup-harness.ts" },
                outdir: "dev/dist", minify: false, define: { __TEST_PROVIDER__: '"gmail"' } });
  const { readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync("dev/dist/popup.html", readFileSync("src/popup.html", "utf8").replace('src="popup.js"', 'src="popup-harness.js"'));
  process.exit(0);
}
if (watch) await (await context(options)).watch();
else await build(options);

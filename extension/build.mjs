// Bundles each extension entry point into dist/ and copies static files.
// Load dist/ as an unpacked extension in chrome://extensions.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const harness = process.argv.includes("--harness");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
for (const f of ["manifest.json", "popup.html", "welcome.html"]) cpSync(`src/${f}`, `dist/${f}`);
cpSync("icons", "dist/icons", { recursive: true });

const options = {
  entryPoints: {
    background: "src/background.ts",
    "content-email": "src/content-email.ts",
    "content-chat": "src/content-chat.ts",
    "content-web": "src/content-web.ts",
    overlay: "src/overlay.ts",
    popup: "src/popup.ts",
    welcome: "src/welcome.ts",
  },
  bundle: true,
  outdir: "dist",
  format: "iife", // content scripts can't be ES modules; IIFE works for every entry
  target: "chrome120",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  define: { __TEST_PROVIDER__: "undefined", __TEST_URL__: "undefined" },
};

// dev/gmail.html test page: real background + content code with a chrome.* stand-in.
if (harness) {
  const dev = { ...options, outdir: "dev/dist", minify: false };
  await build({ ...dev, entryPoints: { harness: "dev/harness.ts", "popup-harness": "dev/popup-harness.ts", "web-harness": "dev/web-harness.ts" },
                define: { __TEST_PROVIDER__: '"gmail"', __TEST_URL__: "undefined" } });
  await build({ ...dev, entryPoints: { "chat-harness": "dev/chat-harness.ts" },
                define: { __TEST_PROVIDER__: "undefined", __TEST_URL__: '"https://web.whatsapp.com/"' } });
  const { readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync("dev/dist/popup.html", readFileSync("src/popup.html", "utf8").replace('src="popup.js"', 'src="popup-harness.js"'));
  process.exit(0);
}
if (watch) await (await context(options)).watch();
else await build(options);

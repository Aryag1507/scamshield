/**
 * Runs inside Gmail and Outlook on the web. Watches for the user opening an email, checks
 * it, and shows a banner just above the message body:
 *   scam / suspicious -> full card with the streamed explanation
 *   safe              -> a small, dismissible "no scam signs found" chip
 *
 * Both sites are single-page apps that re-render constantly, so a throttled
 * MutationObserver re-reads the open email and re-attaches the banner if the site removed
 * it. Each email (by content) is checked once per page load.
 */

import { extractOpenEmail, type OpenEmail, type Provider, providerFor } from "./extract";
import { DEFAULT_SETTINGS, type Settings } from "./types";
import { createCard } from "./ui/card";
import { runCheck, extensionAlive } from "./ui/check";

// Set only by the dev/test-page build (build.mjs --harness); compiled away in the real build.
declare const __TEST_PROVIDER__: Provider | undefined;
const provider = providerFor(location.hostname) ?? (typeof __TEST_PROVIDER__ !== "undefined" ? __TEST_PROVIDER__ : null);
const THROTTLE_MS = 400;

type Shown = { key: string; host: HTMLElement; cancel: () => void };
let shown: Shown | null = null;
const dismissed = new Set<string>();
let settings: Settings = DEFAULT_SETTINGS;

function emailKey(e: OpenEmail): string {
  return [e.provider, e.sender ?? "", e.subject ?? "", e.text].join("\u0000");
}

function scan(): void {
  if (!extensionAlive()) return; // orphaned by an extension reload; the new copy takes over
  if (!provider || !settings.email) return clear();
  const email = extractOpenEmail(document, provider);
  if (!email) return clear();
  const key = emailKey(email);
  if (dismissed.has(key)) return clear();

  if (shown?.key === key) {
    // Same email: make sure the banner is still attached right above the body.
    if (email.body.previousElementSibling !== shown.host) email.body.before(shown.host);
    return;
  }

  clear();
  const { host, render } = createCard({
    compactSafe: true,
    onDismiss: () => {
      dismissed.add(key);
      clear();
    },
  });
  const entry: Shown = { key, host, cancel: () => {} };
  shown = entry;
  email.body.before(host);
  entry.cancel = runCheck({ text: email.text, channel: "email", sender: email.sender, subject: email.subject }, render);
}

function clear(): void {
  if (!shown) return;
  shown.cancel();
  shown.host.remove();
  shown = null;
}

let pending: number | undefined;
function scheduleScan(): void {
  if (pending !== undefined) return;
  pending = window.setTimeout(() => {
    pending = undefined;
    scan();
  }, THROTTLE_MS);
}

async function start(): Promise<void> {
  if (!provider) return;
  settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) } as Settings;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && "email" in changes) {
      settings = { ...settings, email: Boolean(changes.email.newValue) };
      scan();
    }
  });
  new MutationObserver((mutations) => {
    // Ignore mutations caused by our own banner.
    if (mutations.every((m) => shown && (m.target === shown.host || shown.host.contains(m.target as Node)))) return;
    scheduleScan();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  scan();
}

declare global {
  interface Window {
    __scamshieldEmail?: boolean;
  }
}
// Registered and also injected into already-open tabs when turned on; run once per page.
if (!window.__scamshieldEmail) {
  window.__scamshieldEmail = true;
  void start();
}

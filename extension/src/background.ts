/**
 * Background service worker: the only part of the extension that talks to the API.
 * Pages can't call it directly (Gmail's and Outlook's content security policies apply to
 * content scripts), so content scripts, the popup, and the selection overlay connect here
 * over a port and receive the verdict, then the explanation as it streams.
 *
 * Results are cached in chrome.storage.session keyed by a SHA-256 of the input, so
 * reopening an email doesn't re-check it. Only hashes and results are stored, never text.
 */

import { ApiError, checkVerdict, streamReason } from "./api";
import { FEATURE_IDS, FEATURES } from "./features";
import { type CheckInput, type CheckResult, DEFAULT_SETTINGS, PORT_NAME, type PortEvent, type PortRequest, type Settings } from "./types";

const MENU_ID = "scamshield-check-selection";

type Cached = { result: CheckResult; reason?: string };

async function cacheKey(input: CheckInput): Promise<string> {
  const raw = [input.channel, input.sender ?? "", input.subject ?? "", input.text].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return "c:" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleCheck(req: PortRequest, send: (e: PortEvent) => void, signal: AbortSignal) {
  const key = await cacheKey(req.input);
  const cached = (await chrome.storage.session.get(key))[key] as Cached | undefined;

  const result = cached?.result ?? (await checkVerdict(req.input, signal));
  send({ type: "verdict", result });

  let reason = cached?.reason;
  const wantsReason = result.verdict !== "safe" || req.explain;
  if (wantsReason && reason === undefined) {
    reason = await streamReason(req.input, result.verdict, (delta) => send({ type: "reason-delta", delta }), signal);
  }
  if (wantsReason && reason !== undefined) send({ type: "reason-done", reason });
  await chrome.storage.session.set({ [key]: { result, reason } satisfies Cached });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort()); // banner closed or tab navigated
  const send = (e: PortEvent) => {
    if (!controller.signal.aborted) port.postMessage(e);
  };
  port.onMessage.addListener((req: PortRequest) => {
    if (req.type !== "check") return;
    handleCheck(req, send, controller.signal).catch((e) => {
      if (controller.signal.aborted) return;
      send({ type: "error", message: e instanceof ApiError ? e.message : "Something went wrong." });
    });
  });
});

/**
 * Keep registered content scripts in line with the user's switches and granted permissions.
 * A feature's script runs only when it's switched on AND Chrome has granted its sites
 * (the user can revoke access from Chrome's settings at any time).
 */
async function syncContentScripts(): Promise<void> {
  const settings = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
  const registered = new Set(registeredScripts.map((s) => s.id));
  for (const id of FEATURE_IDS) {
    const f = FEATURES[id];
    // Switching a feature off stops its script; access itself isn't revoked here because
    // "Websites" (all sites) overlaps the chat and email sites. Chrome's settings can revoke it.
    const granted = await chrome.permissions.contains({ origins: f.origins });
    const want = settings[id] && granted;
    const existing = registeredScripts.find((r) => r.id === id);
    if (want && existing && Boolean(existing.allFrames) !== Boolean(f.allFrames)) {
      // Registered by an older version with different options: re-register.
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
      registered.delete(id);
    }
    if (want && !registered.has(id)) {
      await chrome.scripting.registerContentScripts([
        { id, js: [f.script], matches: f.matches, excludeMatches: f.excludeMatches, allFrames: f.allFrames ?? false, runAt: "document_idle" },
      ]);
      await injectIntoOpenTabs(id); // registration only affects pages loaded from now on
    } else if (!want && registered.has(id)) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    }
    if (settings[id] && !granted) await chrome.storage.sync.set({ [id]: false }); // access was revoked
  }
}

async function injectIntoOpenTabs(id: keyof Settings): Promise<void> {
  if (id === "sites") return; // only pages loaded after opting in; no sweep of every open tab
  const tabs = await chrome.tabs.query({ url: FEATURES[id].matches });
  await Promise.all(
    tabs.map((t) => t.id && chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: FEATURES[id].allFrames ?? false }, files: [FEATURES[id].script] }).catch(() => {})),
  );
}

// Several events can fire together; registering the same script id twice throws, so run
// syncs one after another.
let syncing: Promise<void> = Promise.resolve();
function scheduleSync(): void {
  syncing = syncing.then(syncContentScripts).catch((e) => console.error("ScamShield: script sync failed", e));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && FEATURE_IDS.some((id) => id in changes)) scheduleSync();
});
chrome.permissions.onRemoved.addListener(scheduleSync);
chrome.runtime.onStartup.addListener(scheduleSync);

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Check with ScamShield", contexts: ["selection"] });
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  scheduleSync();
  // A reload or update disconnects content scripts already running in open tabs, so
  // re-attach to tabs for every enabled feature (the scripts guard against running twice).
  if (details.reason === "update") {
    syncing = syncing.then(async () => {
      const settings = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
      for (const id of FEATURE_IDS) if (settings[id]) await injectIntoOpenTabs(id);
    });
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.selectionText) return;
  // Inject the overlay only when asked (activeTab), rather than into every page.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["overlay.js"] });
  await chrome.tabs.sendMessage(tab.id, { type: "scamshield-show-selection", text: info.selectionText });
});

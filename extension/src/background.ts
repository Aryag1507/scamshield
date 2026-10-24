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
import { type CheckInput, type CheckResult, PORT_NAME, type PortEvent, type PortRequest } from "./types";

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Check with ScamShield", contexts: ["selection"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.selectionText) return;
  // Inject the overlay only when asked (activeTab), rather than into every page.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["overlay.js"] });
  await chrome.tabs.sendMessage(tab.id, { type: "scamshield-show-selection", text: info.selectionText });
});

/**
 * Injected on demand when the user right-clicks selected text and picks "Check with
 * ScamShield". Shows a floating card in the top-right corner with the verdict and the
 * explanation (always explained here, since the user asked). Escape or the close button
 * dismisses it. Guarded so injecting twice on one page reuses the same listener.
 */

import { createCard } from "./ui/card";
import { runCheck } from "./ui/check";

declare global {
  interface Window {
    __scamshieldOverlay?: boolean;
  }
}

if (!window.__scamshieldOverlay) {
  window.__scamshieldOverlay = true;
  let close: (() => void) | null = null;

  chrome.runtime.onMessage.addListener((msg: { type?: string; text?: string }) => {
    if (msg.type !== "scamshield-show-selection" || !msg.text) return;
    close?.();

    const frame = document.createElement("div");
    frame.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:min(380px,calc(100vw - 32px));";
    let cancel = () => {};
    const dismiss = () => {
      cancel();
      frame.remove();
      document.removeEventListener("keydown", onKey, true);
      close = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const { host, render } = createCard({ onDismiss: dismiss });
    frame.append(host);
    document.documentElement.append(frame);
    document.addEventListener("keydown", onKey, true);
    close = dismiss;

    const text = msg.text.trim().slice(0, 6000);
    const channel = /^https?:\/\/\S+$/.test(text) ? "webpage" : text.length > 600 ? "email" : "sms";
    cancel = runCheck({ text, channel }, render, true);
  });
}

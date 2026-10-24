/**
 * Injected on demand when the user right-clicks selected text and picks "Check with
 * ScamShield". Shows a floating card with the verdict and the explanation (always
 * explained here, since the user asked). Guarded so injecting twice reuses one listener.
 */

import { runCheck } from "./ui/check";
import { showFloating } from "./ui/floating";
import { guessChannel } from "./webrisk";

declare global {
  interface Window {
    __scamshieldOverlay?: boolean;
  }
}

if (!window.__scamshieldOverlay) {
  window.__scamshieldOverlay = true;
  let current: { dismiss: () => void } | null = null;

  chrome.runtime.onMessage.addListener((msg: { type?: string; text?: string }) => {
    if (msg.type !== "scamshield-show-selection" || !msg.text) return;
    current?.dismiss();
    let cancel = () => {};
    const card = showFloating({ onDismiss: () => cancel() });
    current = card;
    const text = msg.text.trim().slice(0, 6000);
    cancel = runCheck({ text, channel: guessChannel(text) }, card.render, true);
  });
}

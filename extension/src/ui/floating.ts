import { type CardAction, createCard } from "./card";
import type { CardState } from "./check";

/**
 * A verdict card pinned to the top-right of the page (above everything), used where there's
 * no natural spot inside the page: right-click checks, chats, and websites. Escape or the
 * close button dismisses it.
 */
export function showFloating(opts: { onDismiss?: () => void; actions?: CardAction[]; compactSafe?: boolean } = {}) {
  const frame = document.createElement("div");
  frame.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:min(380px,calc(100vw - 32px));";
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismiss();
  };
  /** Remove without counting it as the user's choice (e.g. they switched conversations). */
  const remove = (): boolean => {
    if (!frame.isConnected) return false;
    frame.remove();
    document.removeEventListener("keydown", onKey, true);
    return true;
  };
  /** The user closed it (close button or Escape). */
  const dismiss = () => {
    if (remove()) opts.onDismiss?.();
  };
  const { host, render } = createCard({ onDismiss: dismiss, actions: opts.actions, compactSafe: opts.compactSafe });
  frame.append(host);
  document.documentElement.append(frame);
  document.addEventListener("keydown", onKey, true);
  return { render: (s: CardState) => render(s), dismiss, remove, element: frame };
}

/**
 * Runs on websites once the user turns on "Websites". Sends a page for checking only when
 * it asks for a password, card details, or a crypto wallet AND isn't a well-known or
 * user-trusted site (webrisk.ts). Shows a floating warning only for scam / suspicious, with
 * a "Trust this site" button. Single-page apps render forms late, so the page is
 * re-evaluated on DOM changes for a short while after load.
 */

import { isRisky, isTrusted, pageInput, riskSignals } from "./webrisk";
import { runCheck } from "./ui/check";
import { showFloating } from "./ui/floating";

declare global {
  interface Window {
    __scamshieldWeb?: boolean;
  }
}

const WATCH_MS = 20_000;

async function trustedSites(): Promise<string[]> {
  return ((await chrome.storage.sync.get({ trustedSites: [] as string[] })).trustedSites as string[]) ?? [];
}

let checked = false;
async function evaluate(): Promise<void> {
  if (checked) return;
  const url = new URL(location.href);
  if (!/^https?:$/.test(url.protocol)) return;
  if (!isRisky(riskSignals(document))) return;
  checked = true; // one check per page load
  if (isTrusted(url.hostname, await trustedSites())) return;

  let cancel = () => {};
  let card: ReturnType<typeof showFloating> | null = null;
  cancel = runCheck(pageInput(document, url), (s) => {
    if (s.kind !== "result" || s.result.verdict === "safe") return;
    card ??= showFloating({
      onDismiss: () => cancel(),
      actions: [
        {
          label: `Trust ${url.hostname}`,
          onClick: async () => {
            const sites = await trustedSites();
            await chrome.storage.sync.set({ trustedSites: [...new Set([...sites, url.hostname])] });
            card?.dismiss();
          },
        },
      ],
    });
    card.render(s);
  });
}

if (!window.__scamshieldWeb) {
  window.__scamshieldWeb = true;
  void evaluate();
  let pending: number | undefined;
  const observer = new MutationObserver(() => {
    if (checked || pending !== undefined) return;
    pending = window.setTimeout(() => {
      pending = undefined;
      void evaluate();
    }, 600);
  });
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), WATCH_MS);
}

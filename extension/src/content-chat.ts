/**
 * Runs on supported chat sites once the user turns on "Chats". When a new conversation is
 * open (see chat.ts: the other person wrote, the user replied at most twice), checks the
 * other person's recent messages: a small "checking…" chip, then a full-screen warning for
 * scam, a corner card for suspicious (stays until closed), or a small "no scam signs found"
 * chip for safe (fades after a few seconds so it doesn't cover the chat). Re-checks when a
 * new incoming message arrives.
 */

import { conversationInput, readConversation, shouldCheck } from "./chat";
import { runCheck, extensionAlive } from "./ui/check";
import { showFloating } from "./ui/floating";
import { showScamModal } from "./ui/modal";

declare global {
  interface Window {
    __scamshieldChat?: boolean;
  }
}

const THROTTLE_MS = 800;
const SAFE_CHIP_MS = 8000;
// Set only by the dev/test-page build (build.mjs --harness); compiled away in the real build.
declare const __TEST_URL__: string | undefined;
const pageUrl = () => new URL(typeof __TEST_URL__ !== "undefined" ? __TEST_URL__ : location.href);
let currentKey = "";
let cancel = () => {};
let card: ReturnType<typeof showFloating> | null = null;
let modal: ReturnType<typeof showScamModal> | null = null;
const dismissedContacts = new Set<string>();

function reset(): void {
  cancel();
  cancel = () => {};
  card?.remove(); // not dismiss(): leaving a conversation isn't "don't warn me about them"
  card = null;
  modal?.remove();
  modal = null;
}

function scan(): void {
  if (!extensionAlive()) return; // orphaned by an extension reload; the new copy takes over
  const convo = readConversation(document, pageUrl());
  const contactKey = convo ? `${convo.site}\u0000${convo.contact ?? ""}` : "";
  if (!convo || !shouldCheck(convo) || dismissedContacts.has(contactKey)) {
    if (currentKey) reset();
    currentKey = "";
    return;
  }
  const input = conversationInput(convo);
  const key = `${contactKey}\u0000${input.text}`;
  if (key === currentKey) return; // nothing new from them
  reset();
  currentKey = key;
  const shown = showFloating({
    compactSafe: true,
    onDismiss: () => {
      dismissedContacts.add(contactKey);
      cancel();
      card = null;
    },
  });
  card = shown;
  cancel = runCheck(input, (s) => {
    // Scams get the full-screen warning instead of the corner card.
    if (s.kind === "result" && s.result.verdict === "scam") {
      if (!modal) {
        shown.remove();
        if (card === shown) card = null;
        const acknowledged = () => {
          dismissedContacts.add(contactKey); // don't pop up again for this person
          modal = null;
        };
        modal = showScamModal({ from: convo.contact, onClose: acknowledged, onNotScam: acknowledged });
      }
      modal.render(s);
      return;
    }
    shown.render(s);
    if (s.kind === "result" && s.result.verdict === "safe") {
      setTimeout(() => {
        if (card === shown) {
          shown.remove();
          card = null;
        }
      }, SAFE_CHIP_MS);
    }
  });
}

if (!window.__scamshieldChat) {
  window.__scamshieldChat = true;
  let pending: number | undefined;
  new MutationObserver(() => {
    if (pending !== undefined) return;
    pending = window.setTimeout(() => {
      pending = undefined;
      scan();
    }, THROTTLE_MS);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  scan();
}

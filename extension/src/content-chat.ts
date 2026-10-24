/**
 * Runs on supported chat sites once the user turns on "Chats". When a new conversation is
 * open (see chat.ts: the other person wrote, the user replied at most twice), checks the
 * other person's recent messages and shows a floating warning only for scam / suspicious.
 * Safe conversations stay silent. Re-checks when a new incoming message arrives.
 */

import { conversationInput, readConversation, shouldCheck } from "./chat";
import { runCheck } from "./ui/check";
import { showFloating } from "./ui/floating";

declare global {
  interface Window {
    __scamshieldChat?: boolean;
  }
}

const THROTTLE_MS = 800;
// Set only by the dev/test-page build (build.mjs --harness); compiled away in the real build.
declare const __TEST_URL__: string | undefined;
const pageUrl = () => new URL(typeof __TEST_URL__ !== "undefined" ? __TEST_URL__ : location.href);
let currentKey = "";
let cancel = () => {};
let card: ReturnType<typeof showFloating> | null = null;
const dismissedContacts = new Set<string>();

function reset(): void {
  cancel();
  cancel = () => {};
  card?.remove(); // not dismiss(): leaving a conversation isn't "don't warn me about them"
  card = null;
}

function scan(): void {
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
  cancel = runCheck(input, (s) => {
    if (s.kind !== "result" || s.result.verdict === "safe") return; // quiet unless there's a warning
    card ??= showFloating({
      onDismiss: () => {
        dismissedContacts.add(contactKey);
        cancel();
        card = null;
      },
    });
    card.render(s);
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

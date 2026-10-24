import { type CheckInput, type CheckResult, PORT_NAME, type PortEvent, type PortRequest } from "../types";

export type CardState =
  | { kind: "checking" }
  | { kind: "result"; result: CheckResult; reason: string; reasonDone: boolean }
  | { kind: "error"; message: string };

/**
 * False once the extension has been reloaded or updated: content scripts already running in
 * a tab are orphaned (they can't reach the background any more) and should stop.
 */
export const extensionAlive = (): boolean => {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
};

/**
 * Ask the background worker to check a message. Calls onState as the verdict and then
 * the explanation stream in. Returns a cancel function that closes the port, which
 * aborts the request in the background too.
 */
export function runCheck(input: CheckInput, onState: (s: CardState) => void, explain = false): () => void {
  const port = chrome.runtime.connect({ name: PORT_NAME });
  let result: CheckResult | null = null;
  let reason = "";
  onState({ kind: "checking" });
  port.onMessage.addListener((e: PortEvent) => {
    if (e.type === "verdict") {
      result = e.result;
      const done = result.verdict === "safe" && !explain; // no explanation coming
      onState({ kind: "result", result, reason, reasonDone: done });
      if (done) port.disconnect();
    } else if (e.type === "reason-delta" && result) {
      reason += e.delta;
      onState({ kind: "result", result, reason, reasonDone: false });
    } else if (e.type === "reason-done" && result) {
      reason = e.reason;
      onState({ kind: "result", result, reason, reasonDone: true });
      port.disconnect();
    } else if (e.type === "error") {
      // A verdict without an explanation is still useful; only fail if we have nothing.
      if (result) onState({ kind: "result", result, reason, reasonDone: true });
      else onState({ kind: "error", message: e.message });
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    if (!result) onState({ kind: "error", message: "ScamShield stopped unexpectedly. Try again." });
  });
  port.postMessage({ type: "check", input, explain } satisfies PortRequest);
  return () => port.disconnect();
}

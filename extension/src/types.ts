export type Verdict = "scam" | "suspicious" | "safe";
export type Channel = "email" | "sms" | "chat" | "webpage";

export type CheckInput = { text: string; channel: Channel; sender?: string; subject?: string };
export type CheckResult = { verdict: Verdict; probabilities: Record<Verdict, number> };

/** Messages over a long-lived port between a page/popup and the background worker. */
export const PORT_NAME = "scamshield-check";
export type PortRequest = { type: "check"; input: CheckInput; explain?: boolean };
export type PortEvent =
  | { type: "verdict"; result: CheckResult }
  | { type: "reason-delta"; delta: string }
  | { type: "reason-done"; reason: string }
  | { type: "error"; message: string };

/** Each automatic check is opt-in: off until the user turns it on and grants that site access. */
export type Feature = "chats" | "sites" | "email";
export type Settings = Record<Feature, boolean>;
export const DEFAULT_SETTINGS: Settings = { chats: false, sites: false, email: false };

export type Channel = "email" | "sms" | "chat" | "webpage";
export type Verdict = "scam" | "suspicious" | "safe";

export type CheckRequest = {
  text: string;
  channel: Channel;
  sender?: string;
  subject?: string;
  explain?: boolean;
  include_reason?: boolean;
};

export type CheckResult = {
  verdict: Verdict;
  probabilities: Record<Verdict, number>;
  reason: string | null;
  model: string;
  latency_ms: number;
  cached: boolean;
};

export const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

export class CheckError extends Error {}

export function checkMessage(req: CheckRequest, signal?: AbortSignal): Promise<CheckResult> {
  return post<CheckResult>("/check", req, signal);
}

/** The explanation is generated separately (it takes several seconds) so the verdict can show first. */
export async function fetchReason(req: CheckRequest & { verdict: Verdict }, signal?: AbortSignal): Promise<string> {
  return (await post<{ reason: string }>("/reason", req, signal)).reason;
}

/**
 * Stream the explanation token by token (Server-Sent Events from /reason/stream).
 * Calls onDelta with each new piece; resolves with the full text.
 */
export async function streamReason(
  req: CheckRequest & { verdict: Verdict },
  onDelta: (piece: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!API_URL) throw new CheckError("The checker isn't connected yet.");
  const res = await fetch(`${API_URL}/reason/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new CheckError("Couldn't load the explanation.");

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    // SSE events are separated by a blank line; keep any partial event for the next chunk.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.replace(/^data: /, "");
      if (!data) continue;
      const msg = JSON.parse(data) as { delta?: string; done?: boolean; reason?: string };
      if (msg.delta) {
        full += msg.delta;
        onDelta(msg.delta);
      }
      if (msg.done) return msg.reason ?? full.trim();
    }
  }
  return full.trim();
}

async function post<T>(path: string, req: object, signal?: AbortSignal): Promise<T> {
  if (!API_URL) throw new CheckError("The checker isn't connected yet. Set NEXT_PUBLIC_API_URL.");
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new CheckError("Couldn't reach the checker. Check your connection and try again.");
  }
  if (res.status === 429) throw new CheckError("You're checking a lot of messages. Wait a minute and try again.");
  if (res.status === 422) throw new CheckError("That message couldn't be read. Try pasting just the text.");
  if (!res.ok) throw new CheckError("Something went wrong on our side. Try again in a moment.");
  return res.json();
}

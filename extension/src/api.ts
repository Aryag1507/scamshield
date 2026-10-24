import type { CheckInput, CheckResult, Verdict } from "./types";

export const API_URL = "https://aryag1507--scamshield-api-web.us-east.modal.run";

export class ApiError extends Error {}

export async function checkVerdict(input: CheckInput, signal?: AbortSignal): Promise<CheckResult> {
  const res = await request("/check", { ...input, include_reason: false }, signal);
  const body = (await res.json()) as CheckResult;
  return { verdict: body.verdict, probabilities: body.probabilities };
}

/** Streams the explanation (Server-Sent Events); calls onDelta per piece and resolves with the full text. */
export async function streamReason(
  input: CheckInput,
  verdict: Verdict,
  onDelta: (piece: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await request("/reason/stream", { ...input, verdict }, signal);
  if (!res.body) throw new ApiError("No explanation stream.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n"); // SSE events end with a blank line
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.replace(/^data: /, "");
      if (!data) continue;
      const msg = JSON.parse(data) as { delta?: string; done?: boolean; reason?: string };
      if (msg.delta) {
        full += msg.delta;
        onDelta(msg.delta);
      }
      if (msg.done) return (msg.reason ?? full).trim();
    }
  }
  return full.trim();
}

async function request(path: string, body: object, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("Couldn't reach ScamShield. Check your connection.");
  }
  if (res.status === 429) throw new ApiError("Too many checks this minute. Try again shortly.");
  if (!res.ok) throw new ApiError("ScamShield had a problem checking this.");
  return res;
}

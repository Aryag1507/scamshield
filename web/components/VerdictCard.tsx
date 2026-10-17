import type { CheckResult, Verdict } from "@/lib/check";
import type { ReasonState } from "./Checker";

const COPY: Record<Verdict, { title: string; tone: string; advice: string[] }> = {
  scam: {
    title: "This looks like a scam",
    tone: "text-scam bg-scam-soft border-scam/25",
    advice: [
      "Don't click links, reply, or call numbers in the message.",
      "If it claims to be a company you use, open their app or type their website yourself.",
      "Never share codes, passwords, or payment details because a message asked you to.",
    ],
  },
  suspicious: {
    title: "Be careful with this one",
    tone: "text-suspicious bg-suspicious-soft border-suspicious/25",
    advice: [
      "It isn't clearly fraud, but something is off.",
      "Verify the sender through a channel you already trust before acting.",
      "Don't send money or personal details until you're sure.",
    ],
  },
  safe: {
    title: "This looks safe",
    tone: "text-safe bg-safe-soft border-safe/25",
    advice: ["No strong scam signals found. If something still feels wrong, trust your gut and check with the sender directly."],
  },
};

const BAR: { key: Verdict; className: string; label: string }[] = [
  { key: "scam", className: "bg-scam", label: "Scam" },
  { key: "suspicious", className: "bg-suspicious", label: "Suspicious" },
  { key: "safe", className: "bg-safe", label: "Safe" },
];

export function VerdictCard({ result, reason }: { result: CheckResult; reason: ReasonState }) {
  const copy = COPY[result.verdict];
  return (
    <section
      aria-labelledby="verdict-title"
      className={`motion-safe:animate-rise rounded-2xl border p-5 sm:p-6 ${copy.tone}`}
    >
      <div className="flex items-start gap-3">
        <VerdictIcon verdict={result.verdict} />
        <div className="min-w-0">
          <h2 id="verdict-title" tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none sm:text-xl">
            {copy.title}
          </h2>
          {(reason.kind === "ready" || reason.kind === "streaming") && (
            <p className="mt-1 text-[15px] leading-relaxed text-foreground" aria-busy={reason.kind === "streaming"}>
              {reason.text}
              {reason.kind === "streaming" && (
                <span aria-hidden="true" className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-current opacity-60 motion-safe:animate-pulse" />
              )}
            </p>
          )}
          {reason.kind === "loading" && (
            <div className="mt-2 space-y-2" aria-label="Explaining the warning signs">
              <div className="h-3 w-full max-w-md rounded bg-current opacity-15 motion-safe:animate-pulse" />
              <div className="h-3 w-3/5 max-w-xs rounded bg-current opacity-15 motion-safe:animate-pulse" />
              <p className="text-xs text-muted">Explaining what gave it away…</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-5">
        <div className="flex h-2 overflow-hidden rounded-full bg-foreground/10" role="img"
          aria-label={BAR.map((b) => `${b.label} ${Math.round(result.probabilities[b.key] * 100)}%`).join(", ")}>
          {BAR.map((b) => (
            <div key={b.key} className={`${b.className} motion-safe:transition-[width] motion-safe:duration-700`}
              style={{ width: `${result.probabilities[b.key] * 100}%` }} />
          ))}
        </div>
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {BAR.map((b) => (
            <div key={b.key} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${b.className}`} aria-hidden="true" />
              <dt>{b.label}</dt>
              <dd className="font-mono tabular-nums text-foreground">{Math.round(result.probabilities[b.key] * 100)}%</dd>
            </div>
          ))}
        </dl>
      </div>

      <ul className="mt-5 space-y-2 border-t border-current/15 pt-4 text-sm text-foreground">
        {copy.advice.map((a) => (
          <li key={a} className="flex gap-2">
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-current opacity-60" />
            {a}
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-muted">
        Checked in {(result.latency_ms / 1000).toFixed(1)}s{result.cached ? " (seen before)" : ""}
      </p>
    </section>
  );
}

function VerdictIcon({ verdict }: { verdict: Verdict }) {
  const common = { width: 28, height: 28, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: "mt-0.5 shrink-0" };
  if (verdict === "safe")
    return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16 9.5" /></svg>;
  if (verdict === "suspicious")
    return <svg {...common}><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><path d="M12 10v4M12 17h.01" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>;
}

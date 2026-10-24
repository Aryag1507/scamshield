/**
 * The verdict card shared by the email banner, the selection overlay, and the popup.
 * Rendered inside a shadow root so the host page's CSS (Gmail, Outlook, any site) can't
 * restyle it and its CSS can't leak out.
 */

import type { Verdict } from "../types";
import type { CardState } from "./check";

const COPY: Record<Verdict, { title: string; advice: string }> = {
  scam: { title: "This looks like a scam", advice: "Don't click links, reply, or call numbers in it. Contact the company through its own app or website." },
  suspicious: { title: "Be careful with this one", advice: "Verify the sender through a channel you already trust before acting." },
  safe: { title: "No scam signs found", advice: "" },
};

const COPY_SHORT: Record<Verdict, string> = { scam: "Scam", suspicious: "Suspicious", safe: "Safe" };

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.card {
  --scam: #c8312b; --scam-bg: #fdeceb; --susp: #9a5b00; --susp-bg: #fdf3e2; --safe: #1f7a4a; --safe-bg: #e7f5ed;
  --fg: #16181d; --muted: #5d6370; --border: rgba(0,0,0,.08); --surface: #fff;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--fg); border-radius: 12px; border: 1px solid var(--border); background: var(--surface);
  display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; margin: 8px 0 12px;
  animation: rise .25s cubic-bezier(.2,.8,.2,1);
}
@media (prefers-color-scheme: dark) {
  .card { --scam: #ff8a82; --scam-bg: #3a1a19; --susp: #f0b65a; --susp-bg: #3a2c14; --safe: #5fd398; --safe-bg: #15301f;
          --fg: #ecedef; --muted: #9aa0ab; --border: rgba(255,255,255,.1); --surface: #17191e; }
}
@media (prefers-reduced-motion: reduce) { .card, .cursor { animation: none !important; } }
@keyframes rise { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.card.scam { background: var(--scam-bg); border-color: color-mix(in srgb, var(--scam) 30%, transparent); }
.card.suspicious { background: var(--susp-bg); border-color: color-mix(in srgb, var(--susp) 30%, transparent); }
.card.compact { padding: 7px 10px; align-items: center; font-size: 13px; }
.icon { flex: none; width: 20px; height: 20px; margin-top: 1px; }
.compact .icon { width: 16px; height: 16px; margin-top: 0; }
.scam .icon, .scam .title { color: var(--scam); }
.suspicious .icon, .suspicious .title { color: var(--susp); }
.safe .icon { color: var(--safe); }
.body { flex: 1; min-width: 0; }
.title { font-weight: 600; }
.compact .title { font-weight: 500; }
.reason { margin-top: 3px; }
.advice { margin-top: 6px; color: var(--muted); font-size: 13px; }
.meta { margin-top: 6px; color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
.probs { display: flex; gap: 10px; font-variant-numeric: tabular-nums; }
.probs .on { color: var(--fg); font-weight: 600; }
.muted { color: var(--muted); }
.brand { font-weight: 600; letter-spacing: .01em; }
.cursor { display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: -2px; background: currentColor; opacity: .5; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.skeleton { height: 10px; border-radius: 4px; background: currentColor; opacity: .12; margin-top: 7px; }
.close { all: unset; cursor: pointer; flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; color: var(--muted); }
.close:hover { background: var(--border); color: var(--fg); }
.close:focus-visible { outline: 2px solid #2f5bea; outline-offset: 1px; }
.spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; flex: none; color: var(--muted); }
@keyframes spin { to { transform: rotate(360deg); } }
`;

const ICONS: Record<Verdict, string> = {
  scam: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  suspicious: '<path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4M12 17h.01"/>',
  safe: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
};

export type CardOptions = { compactSafe?: boolean; onDismiss?: () => void; brand?: boolean };

/** Create a shadow-rooted host element; call the returned render() with each new state. */
export function createCard(opts: CardOptions = {}): { host: HTMLElement; render: (s: CardState) => void } {
  const host = document.createElement("scamshield-card");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  const card = document.createElement("div");
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");
  root.append(style, card);

  const render = (s: CardState) => {
    card.className = "card";
    card.replaceChildren();
    const brand = opts.brand !== false ? '<span class="brand">ScamShield</span>' : "";

    if (s.kind === "checking") {
      card.classList.add("compact");
      card.innerHTML = `<div class="spinner" aria-hidden="true"></div><div class="body muted">${brand} is checking this…</div>`;
    } else if (s.kind === "error") {
      card.classList.add("compact");
      card.innerHTML = `<div class="body muted">${brand}${brand ? ": " : ""}${escape(s.message)}</div>`;
    } else {
      const v = s.result.verdict;
      const compact = v === "safe" && opts.compactSafe;
      card.classList.add(v);
      if (compact) card.classList.add("compact");
      // All three probabilities: one number alone can look contradictory (a "suspicious"
      // verdict with a 0% scam score), and the scam threshold is tuned low on purpose.
      const probs = (["scam", "suspicious", "safe"] as const)
        .map((k) => `<span class="${k === v ? "on" : ""}">${COPY_SHORT[k]} ${Math.round(s.result.probabilities[k] * 100)}%</span>`)
        .join("");
      const reason = s.reason
        ? `<div class="reason">${escape(s.reason)}${s.reasonDone ? "" : '<span class="cursor" aria-hidden="true"></span>'}</div>`
        : s.reasonDone ? "" : '<div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:60%"></div>';
      card.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[v]}</svg>
        <div class="body">
          <div class="title">${compact && brand ? `${brand}: ` : ""}${COPY[v].title}</div>
          ${compact ? "" : reason}
          ${!compact && COPY[v].advice ? `<div class="advice">${COPY[v].advice}</div>` : ""}
          ${!compact ? `<div class="meta">${brand}<span class="probs">${probs}</span></div>` : ""}
        </div>`;
    }
    if (opts.onDismiss) {
      const close = document.createElement("button");
      close.className = "close";
      close.setAttribute("aria-label", "Dismiss");
      close.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      close.addEventListener("click", opts.onDismiss);
      card.append(close);
    }
  };
  return { host, render };
}

/** Explanations are model output and may quote the email; never inject them as HTML. */
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

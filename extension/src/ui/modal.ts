/**
 * Full-screen warning for messages judged a scam: dimmed backdrop, centered dialog, the
 * streamed explanation, and what to do. Hard to miss, one click to close. Used for "scam"
 * only; "suspicious" stays a corner card so routine pushy messages don't interrupt.
 * Rendered in a shadow root so the host site's CSS can't affect it.
 */

import type { CardState } from "./check";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px;
  background: rgba(15, 17, 21, .55); backdrop-filter: blur(2px); animation: fade .2s ease-out;
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.dialog { --scam: #c8312b; --fg: #16181d; --muted: #5d6370; --surface: #fff; --soft: #fdeceb; --border: rgba(0,0,0,.08);
  width: min(460px, 100%); background: var(--surface); color: var(--fg); border-radius: 18px; overflow: hidden;
  box-shadow: 0 24px 60px -12px rgba(0,0,0,.45); animation: pop .25s cubic-bezier(.2,.8,.2,1); }
@media (prefers-color-scheme: dark) {
  .dialog { --scam: #ff8a82; --fg: #ecedef; --muted: #9aa0ab; --surface: #17191e; --soft: #3a1a19; --border: rgba(255,255,255,.1); }
}
@media (prefers-reduced-motion: reduce) { .backdrop, .dialog, .cursor { animation: none !important; } }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
.top { background: var(--soft); padding: 22px 24px 18px; display: flex; gap: 14px; align-items: center; color: var(--scam); }
.top svg { flex: none; width: 40px; height: 40px; }
h2 { margin: 0; font-size: 20px; line-height: 1.25; letter-spacing: -.01em; }
.from { margin-top: 2px; font-size: 13px; color: var(--muted); }
.content { padding: 18px 24px 8px; }
.reason { margin: 0 0 14px; font-size: 15px; }
.skeleton { height: 11px; border-radius: 4px; background: currentColor; opacity: .12; margin: 6px 0; }
.cursor { display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: -2px; background: currentColor; opacity: .5; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
li { margin: 4px 0; }
.probs { margin-top: 14px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: 8px; justify-content: flex-end; padding: 16px 24px 20px; }
button { all: unset; cursor: pointer; font-weight: 600; font-size: 14px; padding: 9px 18px; border-radius: 999px; }
.primary { background: var(--scam); color: #fff; }
.secondary { color: var(--muted); }
.secondary:hover { color: var(--fg); }
button:focus-visible { outline: 2px solid #2f5bea; outline-offset: 2px; }
`;

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 4 5.5v6.2c0 4.7 3.3 8.6 8 9.8 4.7-1.2 8-5.1 8-9.8V5.5l-8-3Z"/><path d="M12 8v5M12 16h.01"/></svg>';

export function showScamModal(opts: { from?: string; onClose?: () => void; onNotScam?: () => void }) {
  const host = document.createElement("scamshield-modal");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style>
    <div class="backdrop">
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="r">
        <div class="top">${ICON}<div><h2 id="t">This looks like a scam</h2><div class="from"></div></div></div>
        <div class="content">
          <p class="reason" id="r"></p>
          <ul>
            <li>Don't click links, send money, or share codes or passwords.</li>
            <li>Don't move the conversation to another app because they asked.</li>
            <li>If they claim to be a company, contact it through its official website or app.</li>
          </ul>
          <div class="probs"></div>
        </div>
        <div class="actions">
          <button class="secondary" data-act="not-scam">Not a scam</button>
          <button class="primary" data-act="close">Got it</button>
        </div>
      </div>
    </div>`;
  const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  if (opts.from) $(".from").textContent = `From ${opts.from} · ScamShield`;
  else $(".from").textContent = "ScamShield";

  const previousFocus = document.activeElement as HTMLElement | null;
  const remove = () => {
    if (!host.isConnected) return false;
    host.remove();
    document.removeEventListener("keydown", onKey, true);
    previousFocus?.focus?.();
    return true;
  };
  const close = () => remove() && opts.onClose?.();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    if (e.key === "Tab") {
      // Keep focus inside the dialog while it's open.
      const buttons = [...root.querySelectorAll<HTMLElement>("button")];
      const i = buttons.indexOf(root.activeElement as HTMLElement);
      e.preventDefault();
      buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    }
  };
  $(".backdrop").addEventListener("click", (e) => e.target === e.currentTarget && close());
  $<HTMLButtonElement>('[data-act="close"]').addEventListener("click", close);
  $<HTMLButtonElement>('[data-act="not-scam"]').addEventListener("click", () => remove() && opts.onNotScam?.());

  document.documentElement.append(host);
  document.addEventListener("keydown", onKey, true);
  $<HTMLButtonElement>('[data-act="close"]').focus();

  const render = (s: CardState) => {
    if (s.kind !== "result") return;
    const reason = $(".reason");
    reason.textContent = s.reason;
    if (!s.reason && !s.reasonDone) reason.innerHTML = '<span class="skeleton" style="display:block;width:92%"></span><span class="skeleton" style="display:block;width:64%"></span>';
    else if (!s.reasonDone) reason.insertAdjacentHTML("beforeend", '<span class="cursor" aria-hidden="true"></span>');
    const p = s.result.probabilities;
    $(".probs").textContent = `Scam ${Math.round(p.scam * 100)}% · Suspicious ${Math.round(p.suspicious * 100)}% · Safe ${Math.round(p.safe * 100)}%`;
  };
  return { render, close, remove };
}

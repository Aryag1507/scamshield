"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { type Channel, type CheckResult, CheckError, checkMessage, fetchReason, streamReason } from "@/lib/check";
import { parsePasted } from "@/lib/detect";
import { EXAMPLES, type Example } from "@/lib/examples";
import { VerdictCard } from "./VerdictCard";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "sms", label: "Text" },
  { value: "email", label: "Email" },
  { value: "chat", label: "Chat / DM" },
  { value: "webpage", label: "Web page" },
];

const MAX_CHARS = 50_000;
// A scaled-to-zero server takes a while on its first request; say so instead of spinning silently.
const SLOW_AFTER_MS = 3000;

type Status = { kind: "idle" } | { kind: "loading"; slow: boolean } | { kind: "done"; result: CheckResult } | { kind: "error"; message: string };
// Kept apart from Status so the explanation arriving doesn't re-trigger scroll/focus.
export type ReasonState = { kind: "none" } | { kind: "loading" } | { kind: "streaming"; text: string } | { kind: "ready"; text: string };

export function Checker() {
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<Channel>("sms");
  const [channelTouched, setChannelTouched] = useState(false);
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [reason, setReason] = useState<ReasonState>({ kind: "none" });
  const [canPaste, setCanPaste] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ids = { text: useId(), sender: useId(), subject: useId(), hint: useId() };

  useEffect(() => {
    setCanPaste(typeof navigator !== "undefined" && !!navigator.clipboard?.readText);
    return () => abortRef.current?.abort();
  }, []);

  // Once a result or error is on the page, bring it into view and move focus to it, so
  // phone users (where it renders below the fold) and screen-reader users land on it.
  useEffect(() => {
    if (status.kind !== "done" && status.kind !== "error") return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
    if (status.kind === "done") resultRef.current?.querySelector<HTMLElement>("#verdict-title")?.focus({ preventScroll: true });
  }, [status]);

  // Auto-grow the textarea with its content, up to a cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, [text]);

  const applyParsed = useCallback(
    (raw: string) => {
      const parsed = parsePasted(raw);
      setText(parsed.text);
      if (!channelTouched) setChannel(parsed.channel);
      if (parsed.sender) setSender(parsed.sender);
      if (parsed.subject) setSubject(parsed.subject);
      if (parsed.sender || parsed.subject) setShowDetails(true);
    },
    [channelTouched],
  );

  const submit = useCallback(
    async (override?: Example) => {
      const body = override
        ? { text: override.text, channel: override.channel, sender: override.sender, subject: override.subject }
        : { text: text.trim(), channel, sender: sender.trim() || undefined, subject: (channel === "email" && subject.trim()) || undefined };
      if (!body.text) {
        textareaRef.current?.focus();
        return;
      }

      abortRef.current?.abort(); // a newer check always wins
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus({ kind: "loading", slow: false });
      setReason({ kind: "none" });
      const slowTimer = setTimeout(() => setStatus((s) => (s.kind === "loading" ? { kind: "loading", slow: true } : s)), SLOW_AFTER_MS);

      try {
        // Verdict first (one fast forward pass); the explanation is generated after.
        const result = await checkMessage({ ...body, include_reason: false }, controller.signal);
        setStatus({ kind: "done", result });
        if (result.verdict !== "safe") {
          setReason({ kind: "loading" });
          const reasonReq = { ...body, verdict: result.verdict };
          let streamed = "";
          streamReason(reasonReq, (piece) => {
            streamed += piece;
            setReason({ kind: "streaming", text: streamed });
          }, controller.signal)
            // If streaming isn't possible (e.g. a proxy buffers it), fall back to one request.
            .catch((e) => (controller.signal.aborted ? Promise.reject(e) : fetchReason(reasonReq, controller.signal)))
            .then((text) => setReason({ kind: "ready", text }))
            .catch(() => !controller.signal.aborted && setReason({ kind: "none" })); // verdict still stands
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setStatus({ kind: "error", message: e instanceof CheckError ? e.message : "Something went wrong. Try again." });
      } finally {
        clearTimeout(slowTimer);
      }
    },
    [text, channel, sender, subject],
  );

  function loadExample(ex: Example) {
    setText(ex.text);
    setChannel(ex.channel);
    setChannelTouched(false);
    setSender(ex.sender ?? "");
    setSubject(ex.subject ?? "");
    setShowDetails(Boolean(ex.sender || ex.subject));
    void submit(ex);
  }

  async function pasteFromClipboard() {
    try {
      const raw = await navigator.clipboard.readText();
      if (raw.trim()) applyParsed(raw);
      textareaRef.current?.focus();
    } catch {
      textareaRef.current?.focus(); // permission denied: fall back to manual paste
    }
  }

  function clear() {
    abortRef.current?.abort();
    setText("");
    setSender("");
    setSubject("");
    setChannelTouched(false);
    setStatus({ kind: "idle" });
    textareaRef.current?.focus();
  }

  const loading = status.kind === "loading";

  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-2xl border border-border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)] focus-within:border-accent/60 motion-safe:transition-colors"
      >
        <label htmlFor={ids.text} className="sr-only">Message to check</label>
        <textarea
          id={ids.text}
          ref={textareaRef}
          value={text}
          maxLength={MAX_CHARS}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Only parse a paste into an empty box; otherwise keep normal editing behavior.
            if (text.trim()) return;
            e.preventDefault();
            applyParsed(e.clipboardData.getData("text"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          aria-describedby={ids.hint}
          placeholder="Paste a text, email, or DM you're not sure about…"
          rows={5}
          className="block w-full resize-none rounded-t-2xl bg-transparent px-4 pt-4 pb-2 text-[16px] leading-relaxed outline-none placeholder:text-muted/70 sm:px-5 sm:pt-5"
        />

        {showDetails && (
          <div className="grid gap-2 px-4 pb-2 sm:grid-cols-2 sm:px-5">
            <Field id={ids.sender} label="From" value={sender} onChange={setSender} placeholder="Sender, number, or email" />
            {channel === "email" && (
              <Field id={ids.subject} label="Subject" value={subject} onChange={setSubject} placeholder="Email subject" />
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-3 sm:px-4">
          <div role="radiogroup" aria-label="Where did you get it?" className="flex flex-wrap gap-1">
            {CHANNELS.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={channel === c.value}
                onClick={() => {
                  setChannel(c.value);
                  setChannelTouched(true);
                }}
                className={`rounded-full px-3 py-1.5 text-sm motion-safe:transition-colors ${
                  channel === c.value ? "bg-accent-soft font-medium text-accent dark:text-foreground ring-1 ring-accent/25 ring-inset" : "text-muted hover:bg-foreground/5 hover:text-foreground"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {!showDetails && (
              <button type="button" onClick={() => setShowDetails(true)} className="hidden rounded-full px-3 py-1.5 text-sm text-muted hover:bg-foreground/5 hover:text-foreground sm:block">
                + Sender
              </button>
            )}
            {text && !loading && (
              <button type="button" onClick={clear} className="rounded-full px-3 py-1.5 text-sm text-muted hover:bg-foreground/5 hover:text-foreground">
                Clear
              </button>
            )}
            {canPaste && !text && (
              <button type="button" onClick={pasteFromClipboard} className="rounded-full px-3 py-1.5 text-sm text-muted hover:bg-foreground/5 hover:text-foreground">
                Paste
              </button>
            )}
            <button
              type="submit"
              disabled={loading}
              className="inline-flex min-w-28 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-80 dark:text-background motion-safe:transition"
            >
              {loading ? <Spinner /> : null}
              {loading ? "Checking" : "Check"}
            </button>
          </div>
        </div>
      </form>

      <p id={ids.hint} className="-mt-2 px-1 text-xs text-muted">
        <span className="hidden sm:inline">
          <kbd className="font-sans">⌘</kbd>/<kbd className="font-sans">Ctrl</kbd> + <kbd className="font-sans">Enter</kbd> to check.{" "}
        </span>
        Messages are analyzed and discarded, never stored.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Try one:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            type="button"
            onClick={() => loadExample(ex)}
            className="rounded-full border border-border bg-surface px-3 py-1.5 text-sm hover:border-foreground/25 active:scale-[0.98] motion-safe:transition"
          >
            {ex.label}
          </button>
        ))}
      </div>

      <div ref={resultRef} aria-live="polite" className="scroll-mt-6">
        {status.kind === "loading" && <LoadingCard slow={status.slow} />}
        {status.kind === "error" && (
          <div role="alert" className="motion-safe:animate-rise rounded-2xl border border-border bg-surface p-5 text-sm">
            <p className="font-medium">Couldn&apos;t check that message</p>
            <p className="mt-1 text-muted">{status.message}</p>
            <button type="button" onClick={() => void submit()} className="mt-3 text-sm font-medium text-accent hover:underline">
              Try again
            </button>
          </div>
        )}
        {status.kind === "done" && <VerdictCard result={status.result} reason={reason} />}
      </div>
    </div>
  );
}

function Field(props: { id: string; label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2">
      <label htmlFor={props.id} className="text-xs font-medium uppercase tracking-wide text-muted">{props.label}</label>
      <input
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        maxLength={500}
        className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted/60"
      />
    </div>
  );
}

function LoadingCard({ slow }: { slow: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 sm:p-6" aria-busy="true">
      <div className="flex items-center gap-3">
        <div className="size-7 rounded-full bg-foreground/10 motion-safe:animate-pulse" />
        <div className="h-4 w-48 rounded bg-foreground/10 motion-safe:animate-pulse" />
      </div>
      <div className="mt-4 h-3 w-full rounded bg-foreground/10 motion-safe:animate-pulse" />
      <div className="mt-2 h-3 w-4/5 rounded bg-foreground/10 motion-safe:animate-pulse" />
      <p className="mt-4 text-sm text-muted">
        {slow ? "Waking up the model. The first check after a quiet spell takes a few extra seconds." : "Reading the message…"}
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="size-4 motion-safe:animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

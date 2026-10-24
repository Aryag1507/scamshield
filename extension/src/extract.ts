/**
 * Find the email the user is reading in Gmail or Outlook on the web.
 *
 * Neither site has an extension API for this, so it reads their DOM, which they can change
 * at any time. Every lookup tries several selectors, sender and subject are optional, and
 * a message only counts once its body has real text. Pure functions over a Document, so
 * they're unit-tested against fixture HTML.
 */

export type Provider = "gmail" | "outlook";

export type OpenEmail = {
  provider: Provider;
  sender?: string;
  subject?: string;
  text: string;
  /** The message body element; the banner is inserted just above it. */
  body: Element;
};

const MIN_BODY_CHARS = 20;
const MAX_TEXT_CHARS = 6000; // the model reads 4,000; a little extra keeps the hash stable

export function providerFor(hostname: string): Provider | null {
  if (hostname === "mail.google.com") return "gmail";
  if (/^outlook\.(live|office|office365)\.com$/.test(hostname)) return "outlook";
  return null;
}

export function extractOpenEmail(doc: Document, provider: Provider): OpenEmail | null {
  return provider === "gmail" ? extractGmail(doc) : extractOutlook(doc);
}

/** Gmail: each expanded message in a thread has a `.a3s` body; the last one is the newest. */
function extractGmail(doc: Document): OpenEmail | null {
  const bodies = [...doc.querySelectorAll("div.a3s")].filter((el) => cleanText(el).length >= MIN_BODY_CHARS);
  const body = bodies.at(-1);
  if (!body) return null;
  const message = body.closest("div.adn, div.gs") ?? doc;
  const senderEl = message.querySelector("span.gD[email], span[email].go, h3 span[email]");
  const sender = senderEl
    ? formatSender(senderEl.getAttribute("name") ?? senderEl.textContent ?? "", senderEl.getAttribute("email") ?? "")
    : undefined;
  const subject = firstText(doc, ["h2.hP", "h2[data-thread-perm-id]"]);
  return { provider: "gmail", sender, subject, text: cleanText(body).slice(0, MAX_TEXT_CHARS), body };
}

/** Outlook on the web: the reading pane body is labelled "Message body". */
function extractOutlook(doc: Document): OpenEmail | null {
  const bodies = [...doc.querySelectorAll('div[aria-label="Message body"], div[role="document"]')].filter(
    (el) => cleanText(el).length >= MIN_BODY_CHARS,
  );
  const body = bodies.at(-1);
  if (!body) return null;
  const pane = body.closest('[role="main"], [data-app-section="ConversationContainer"]') ?? doc;
  const subject = firstText(pane, ['[role="heading"][aria-level="2"]', "#SubjectLine", '[data-app-section="ConversationTopic"]']);
  const sender = senderFromOutlook(pane);
  return { provider: "outlook", sender, subject, text: cleanText(body).slice(0, MAX_TEXT_CHARS), body };
}

function senderFromOutlook(root: ParentNode): string | undefined {
  // Outlook shows "Display Name <address>" in a persona button or an aria-label like "From: Name".
  const persona = root.querySelector('[aria-label^="From:"], [data-testid="SenderPersona"], span[title*="@"]');
  if (!persona) return undefined;
  const label = persona.getAttribute("aria-label")?.replace(/^From:\s*/, "");
  const title = persona.getAttribute("title") ?? "";
  const text = label || persona.textContent || "";
  const email = (title.match(EMAIL) ?? text.match(EMAIL))?.[0] ?? "";
  return formatSender(text.replace(EMAIL, "").replace(/[<>]/g, ""), email);
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

function formatSender(name: string, email: string): string | undefined {
  const n = name.trim();
  const e = email.trim();
  if (n && e && n !== e) return `${n} <${e}>`;
  return e || n || undefined;
}

function firstText(root: ParentNode, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const t = root.querySelector(sel)?.textContent?.trim();
    if (t) return t;
  }
  return undefined;
}

/** Visible text with whitespace collapsed; quoted replies and signatures are kept (they carry signal). */
export function cleanText(el: Element): string {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
  // Trim spaces around line breaks (not other newlines), then keep at most one blank line.
  return raw.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

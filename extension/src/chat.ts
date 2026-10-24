/**
 * Read the open conversation on supported chat sites.
 *
 * Each adapter returns the other person's recent messages and how many messages the user
 * has sent. Only "new" conversations are checked: the other person wrote, and the user has
 * replied at most twice. Scams almost always start that way, and it keeps chats with people
 * the user actually talks to on their computer.
 *
 * Like extract.ts these read each site's DOM, which can change; adapters prefer stable
 * attributes (is-outgoing, data-pre-plain-text, id prefixes) over generated class names.
 */

import type { Channel, CheckInput } from "./types";

export type Conversation = {
  site: "whatsapp" | "google-messages" | "linkedin" | "telegram" | "discord";
  channel: Channel;
  contact?: string;
  /** The other person's messages, oldest first (only what's loaded on screen). */
  incoming: string[];
  /** Messages the user sent in the loaded part of the conversation. */
  outgoingCount: number;
};

const MAX_USER_REPLIES = 2;
const RECENT_INCOMING = 6;
const MIN_CHARS = 15;

export function shouldCheck(c: Conversation): boolean {
  return c.incoming.length > 0 && c.outgoingCount <= MAX_USER_REPLIES && c.incoming.join(" ").length >= MIN_CHARS;
}

export function conversationInput(c: Conversation): CheckInput {
  const text = c.incoming.slice(-RECENT_INCOMING).join("\n").slice(-4000);
  return { text, channel: c.channel, sender: c.contact };
}

export function readConversation(doc: Document, url: URL): Conversation | null {
  switch (url.hostname) {
    case "web.whatsapp.com": return whatsapp(doc);
    case "messages.google.com": return googleMessages(doc);
    // Not gated on the URL: LinkedIn now renders messaging inside a /preload/ iframe, and chat
    // bubbles open on any page. linkedin() returns null when no conversation is open.
    case "www.linkedin.com": return linkedin(doc);
    case "web.telegram.org": return telegram(doc);
    case "discord.com": return url.pathname.startsWith("/channels/@me/") ? discord(doc) : null;
    default: return null;
  }
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const nonEmpty = (xs: string[]) => xs.filter((x) => x.length > 0);

/** WhatsApp Web: messages carry message-in / message-out classes; text is in .selectable-text. */
function whatsapp(doc: Document): Conversation | null {
  const main = doc.querySelector("#main");
  if (!main) return null;
  const msgText = (m: Element) => text(m.querySelector(".copyable-text .selectable-text, span.selectable-text"));
  const incoming = nonEmpty([...main.querySelectorAll(".message-in")].map(msgText));
  const outgoingCount = main.querySelectorAll(".message-out").length;
  const contact = main.querySelector("header span[title]")?.getAttribute("title") ?? (text(main.querySelector("header span[dir='auto']")) || undefined);
  return { site: "whatsapp", channel: "chat", contact, incoming, outgoingCount };
}

/** Google Messages for web: <mws-message-wrapper is-outgoing="true|false">. These are SMS. */
function googleMessages(doc: Document): Conversation | null {
  const wrappers = [...doc.querySelectorAll("mws-message-wrapper")];
  if (!wrappers.length) return null;
  const msgText = (m: Element) => text(m.querySelector(".text-msg-content, mws-text-message-part, .text-msg") ?? m);
  const incoming = nonEmpty(wrappers.filter((w) => w.getAttribute("is-outgoing") === "false").map(msgText));
  const outgoingCount = wrappers.filter((w) => w.getAttribute("is-outgoing") === "true").length;
  const contact = text(doc.querySelector("mws-conversation-header .title, mws-header .title, h2.title")) || undefined;
  return { site: "google-messages", channel: "sms", contact, incoming, outgoingCount };
}

/**
 * LinkedIn messaging (full page and overlay bubbles). A message is the other person's if
 * LinkedIn marks it (--other), or if the sender name shown above its group matches the
 * conversation's name. InMail subject lines are included: they carry signal.
 */
function linkedin(doc: Document): Conversation | null {
  const list = doc.querySelector(".msg-s-message-list, .msg-overlay-conversation-bubble, .msg-thread");
  if (!list) return null;
  const contact = text(doc.querySelector(
    ".msg-entity-lockup__entity-title, .msg-thread__link-to-profile h2, .msg-overlay-bubble-header__title, .msg-s-profile-card .artdeco-entity-lockup__title",
  )) || undefined;
  const events = [...list.querySelectorAll("li.msg-s-message-list__event")];
  const items = events.length ? events : [...list.querySelectorAll(".msg-s-event-listitem")];

  const incoming: string[] = [];
  let outgoingCount = 0;
  let author = "";
  for (const item of items) {
    const name = text(item.querySelector(".msg-s-message-group__name, .msg-s-message-group__profile-link"));
    if (name) author = name;
    const subject = text(item.querySelector(".msg-s-event-listitem__subject"));
    const body = text(item.querySelector(".msg-s-event-listitem__body, [class*='event-listitem__body']"));
    const content = [subject, body].filter(Boolean).join("\n");
    if (!content) continue;
    const markedOther = item.matches(".msg-s-event-listitem--other") || !!item.querySelector(".msg-s-event-listitem--other");
    if (markedOther || (contact && author && sameName(author, contact))) incoming.push(content);
    else outgoingCount++;
  }
  return { site: "linkedin", channel: "chat", contact, incoming, outgoingCount };
}

/** "Patel Harshil" vs "Patel Harshil (He/Him)": compare normalized names, allowing extra suffixes. */
function sameName(a: string, b: string): boolean {
  const n = (x: string) => x.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const [x, y] = [n(a), n(b)];
  return !!x && !!y && (x === y || x.startsWith(y + " ") || y.startsWith(x + " "));
}

/** Telegram Web K (.bubble.is-in / .is-out) and Web A (.Message / .Message.own). */
function telegram(doc: Document): Conversation | null {
  const kBubbles = [...doc.querySelectorAll(".bubbles .bubble")];
  if (kBubbles.length) {
    const msgText = (b: Element) => text(b.querySelector(".translatable-message, .message"))
      .replace(/\s*\d{1,2}:\d{2}(\s?[AP]M)?\s*$/i, ""); // trailing timestamp
    return {
      site: "telegram", channel: "chat",
      contact: text(doc.querySelector(".chat-info .peer-title, .top .peer-title")) || undefined,
      incoming: nonEmpty(kBubbles.filter((b) => b.classList.contains("is-in")).map(msgText)),
      outgoingCount: kBubbles.filter((b) => b.classList.contains("is-out")).length,
    };
  }
  const aMessages = [...doc.querySelectorAll(".messages-container .Message, .MessageList .Message")];
  if (!aMessages.length) return null;
  return {
    site: "telegram", channel: "chat",
    contact: text(doc.querySelector(".ChatInfo .fullName, .ChatInfo h3")) || undefined,
    incoming: nonEmpty(aMessages.filter((m) => !m.classList.contains("own")).map((m) => text(m.querySelector(".text-content")))),
    outgoingCount: aMessages.filter((m) => m.classList.contains("own")).length,
  };
}

/**
 * Discord direct messages: li#chat-messages-*, author in span#message-username-* on the
 * first message of each group. Incoming = written by the person named in the DM header.
 */
function discord(doc: Document): Conversation | null {
  const items = [...doc.querySelectorAll('li[id^="chat-messages-"]')];
  if (!items.length) return null;
  const header = doc.querySelector('section[aria-label="Channel header"] h1, [class*="title"] h1, h1[class*="title"]');
  const other = text(header);
  if (!other) return null;
  let author = "";
  const incoming: string[] = [];
  let outgoingCount = 0;
  for (const li of items) {
    const name = text(li.querySelector('span[id^="message-username-"]'));
    if (name) author = name;
    const content = text(li.querySelector('div[id^="message-content-"]'));
    if (!content) continue;
    if (author === other) incoming.push(content);
    else outgoingCount++;
  }
  return { site: "discord", channel: "chat", contact: other, incoming, outgoingCount };
}

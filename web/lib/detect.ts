import type { Channel } from "./check";

export type Parsed = { channel: Channel; sender?: string; subject?: string; text: string };

const HEADER = /^(from|subject|to|date|cc|sent|reply-to):\s*(.*)$/i;

/**
 * Guess the channel from pasted text and lift leading From:/Subject: header lines into
 * fields, so a pasted email "just works". The user can always override the channel.
 */
export function parsePasted(raw: string): Parsed {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  let sender: string | undefined;
  let subject: string | undefined;
  const headerStart = i;
  for (let m; i < lines.length && (m = lines[i].match(HEADER)); i++) {
    const key = m[1].toLowerCase();
    if (key === "from") sender = m[2].trim() || undefined;
    if (key === "subject") subject = m[2].trim() || undefined;
  }
  const hasHeaders = i > headerStart;

  const body = (hasHeaders ? lines.slice(i) : lines).join("\n").trim();
  return { channel: guessChannel(raw, hasHeaders), sender, subject, text: body || raw.trim() };
}

function guessChannel(raw: string, hasHeaders: boolean): Channel {
  const t = raw.trim();
  if (/^https?:\/\/\S+$/.test(t)) return "webpage";
  if (hasHeaders || /^(dear|hello|hi)\b[^\n]{0,40},?\n/i.test(t) || /unsubscribe/i.test(t)) return "email";
  if (t.length > 600 || t.split("\n").length > 8) return "email";
  return "sms";
}

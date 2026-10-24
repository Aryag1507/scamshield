import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { conversationInput, readConversation, shouldCheck } from "../src/chat";

const doc = (name: string) =>
  parseHTML(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).document as unknown as Document;
const read = (fixture: string, url: string) => readConversation(doc(fixture), new URL(url));

test("whatsapp: stranger's opener is read, checked, and sent as chat", () => {
  const c = read("whatsapp-new.html", "https://web.whatsapp.com/");
  assert.ok(c);
  assert.equal(c.contact, "+1 (415) 555-0142");
  assert.deepEqual(c.incoming, ["Hi! Sorry, wrong number I think 😅", "You seem nice. I trade crypto, made 30% last month. Want me to show you?"]);
  assert.equal(c.outgoingCount, 0);
  assert.ok(shouldCheck(c));
  const input = conversationInput(c);
  assert.equal(input.channel, "chat");
  assert.equal(input.sender, "+1 (415) 555-0142");
  assert.match(input.text, /wrong number[\s\S]*crypto/);
});

test("whatsapp: an ongoing chat with someone you talk to is never sent", () => {
  const c = read("whatsapp-friend.html", "https://web.whatsapp.com/");
  assert.ok(c);
  assert.equal(c.outgoingCount, 4);
  assert.equal(shouldCheck(c), false);
});

test("google messages: incoming texts are read as sms", () => {
  const c = read("google-messages.html", "https://messages.google.com/web/conversations/12");
  assert.ok(c);
  assert.equal(c.channel, "sms");
  assert.equal(c.contact, "+1 (213) 555-0199");
  assert.equal(c.incoming.length, 2);
  assert.equal(c.outgoingCount, 0);
  assert.ok(shouldCheck(c));
});

test("linkedin: other person's messages vs. the user's reply", () => {
  const c = read("linkedin.html", "https://www.linkedin.com/messaging/thread/2-abc/");
  assert.ok(c);
  assert.equal(c.contact, "Emily Carter");
  assert.equal(c.incoming.length, 2);
  assert.equal(c.outgoingCount, 1);
  assert.ok(shouldCheck(c));
});

test("linkedin: feed pages are ignored", () => {
  assert.equal(read("linkedin.html", "https://www.linkedin.com/feed/"), null);
});

test("telegram web K: strips trailing timestamps, splits in/out", () => {
  const c = read("telegram-k.html", "https://web.telegram.org/k/#@lisa");
  assert.ok(c);
  assert.equal(c.contact, "Crypto Mentor Lisa");
  assert.deepEqual(c.incoming, ["Claim your airdrop before it expires: connect your wallet at claim-eth.app"]);
  assert.equal(c.outgoingCount, 1);
});

test("telegram web A: .Message without .own is incoming", () => {
  const c = read("telegram-a.html", "https://web.telegram.org/a/#123");
  assert.ok(c);
  assert.equal(c.contact, "Support Team");
  assert.equal(c.incoming.length, 1);
  assert.equal(c.outgoingCount, 0);
});

test("discord DM: grouped messages inherit the author; the user's own message is outgoing", () => {
  const c = read("discord.html", "https://discord.com/channels/@me/123");
  assert.ok(c);
  assert.equal(c.contact, "freenitro_events");
  assert.deepEqual(c.incoming, ["Congrats! You won 3 months of Nitro.", "Claim it here before midnight: discord-gift.ru/claim"]);
  assert.equal(c.outgoingCount, 1);
});

test("discord: server channels (group chats) are ignored", () => {
  assert.equal(read("discord.html", "https://discord.com/channels/9876/5432"), null);
});

test("unsupported site returns null", () => {
  assert.equal(read("whatsapp-new.html", "https://example.com/"), null);
});

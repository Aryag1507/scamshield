import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { cleanText, extractOpenEmail, providerFor } from "../src/extract";

const doc = (name: string) => parseHTML(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).document as unknown as Document;

test("gmail: picks the newest message in a thread, with sender and subject", () => {
  const e = extractOpenEmail(doc("gmail-thread.html"), "gmail");
  assert.ok(e);
  assert.equal(e.subject, "Your account has been limited");
  assert.equal(e.sender, "PayPal Security <security@paypa1-support.com>");
  assert.match(e.text, /^We noticed unusual activity/);
  assert.match(e.text, /paypa1-verify\.co\/login$/);
  assert.doesNotMatch(e.text, /earlier message/);
  assert.ok(!/ {2,}/.test(e.text), "whitespace collapsed");
});

test("gmail: inbox view with no open email returns null", () => {
  assert.equal(extractOpenEmail(doc("gmail-inbox.html"), "gmail"), null);
});

test("gmail: a body that is still loading is ignored", () => {
  assert.equal(extractOpenEmail(doc("gmail-loading.html"), "gmail"), null);
});

test("outlook: reading pane with subject, sender, and body", () => {
  const e = extractOpenEmail(doc("outlook.html"), "outlook");
  assert.ok(e);
  assert.equal(e.subject, "Order #GS-88214 – Auto-Renewal Confirmed");
  assert.equal(e.sender, "Geek Squad Billing <billing@geeksquad-renewal.net>");
  assert.match(e.text, /\$399\.99 will be charged/);
});

test("providerFor: only Gmail and Outlook web hosts", () => {
  assert.equal(providerFor("mail.google.com"), "gmail");
  assert.equal(providerFor("outlook.live.com"), "outlook");
  assert.equal(providerFor("outlook.office.com"), "outlook");
  assert.equal(providerFor("outlook.office365.com"), "outlook");
  assert.equal(providerFor("evil-outlook.office.com.example"), null);
  assert.equal(providerFor("google.com"), null);
});

test("cleanText: collapses spaces and runs of blank lines in rendered text", () => {
  // As a browser's innerText would return it (raw newlines in HTML source render as spaces).
  const el = { innerText: "a   b\n\n\n\n  c\u00a0\u00a0d\n" } as unknown as Element;
  assert.equal(cleanText(el), "a b\n\nc d");
});

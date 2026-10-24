import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { guessChannel, isRisky, isTrusted, pageInput, riskSignals } from "../src/webrisk";

const doc = (name: string) =>
  parseHTML(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).document as unknown as Document;

test("login page with a password field is risky", () => {
  const s = riskSignals(doc("phishing-login.html"));
  assert.equal(s.password, true);
  assert.ok(isRisky(s));
});

test("an article with only a search box is not risky (never sent)", () => {
  assert.equal(isRisky(riskSignals(doc("article.html"))), false);
});

test("card fields are detected by autocomplete or field names", () => {
  assert.equal(riskSignals(doc("checkout.html")).card, true);
});

test("wallet-connect prompts are detected", () => {
  assert.equal(riskSignals(doc("wallet.html")).wallet, true);
});

test("trusted list covers subdomains but not lookalikes", () => {
  assert.equal(isTrusted("accounts.google.com"), true);
  assert.equal(isTrusted("www.paypal.com"), true);
  assert.equal(isTrusted("paypal.com.secure-login.top"), false);
  assert.equal(isTrusted("paypa1.com"), false);
  assert.equal(isTrusted("notgoogle.com"), false);
  assert.equal(isTrusted("benefits.ssa.gov"), true);
  assert.equal(isTrusted("shop.example.com", ["example.com"]), true);
});

test("page input leads with the URL and title", () => {
  const input = pageInput(doc("phishing-login.html"), new URL("https://paypa1-verify.co/login?session=abc"));
  assert.equal(input.channel, "webpage");
  assert.equal(input.sender, "paypa1-verify.co");
  assert.match(input.text, /^https:\/\/paypa1-verify\.co\/login\nPayPal: Log in to your account\n\n/);
  assert.doesNotMatch(input.text, /session=abc/, "query strings (often tokens) are not sent");
  assert.match(input.text, /Your account has been limited/);
});

test("guessChannel", () => {
  assert.equal(guessChannel("https://claim-eth.app"), "webpage");
  assert.equal(guessChannel("Your code is 12345"), "sms");
  assert.equal(guessChannel("x".repeat(700)), "email");
});

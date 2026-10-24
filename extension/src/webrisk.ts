/**
 * Decide whether a web page is worth checking, and build the model input if so.
 *
 * Privacy rule: ordinary browsing is never sent. A page is checked only if it asks for
 * something a scam site wants (a password, card details, a crypto wallet or recovery
 * phrase) AND it isn't a well-known site or one the user chose to trust.
 */

import type { Channel, CheckInput } from "./types";

export type RiskSignals = { password: boolean; card: boolean; wallet: boolean };

const CARD_FIELD = /card.?num|cc-?num|credit.?card|cvv|cvc|security.?code|expir/i;
const WALLET_TEXT = /\b(connect (your )?wallet|claim (your )?(airdrop|tokens|reward)|seed phrase|recovery phrase|secret recovery|private key|walletconnect|metamask)\b/i;

export function riskSignals(doc: Document): RiskSignals {
  const password = !!doc.querySelector('input[type="password"]');
  const card = [...doc.querySelectorAll("input")].some((i) => {
    const ac = i.getAttribute("autocomplete") ?? "";
    if (/^cc-(number|csc|exp)/.test(ac)) return true;
    const hints = [i.name, i.id, i.getAttribute("placeholder"), i.getAttribute("aria-label")].join(" ");
    return CARD_FIELD.test(hints);
  });
  const clickable = [...doc.querySelectorAll("button, a, [role='button']")].map((e) => e.textContent ?? "").join(" ");
  const wallet = WALLET_TEXT.test(clickable) || WALLET_TEXT.test(doc.title) ||
    !!doc.querySelector("textarea, input") && WALLET_TEXT.test(doc.body?.textContent?.slice(0, 20000) ?? "");
  return { password, card, wallet };
}

export const isRisky = (s: RiskSignals) => s.password || s.card || s.wallet;

/** Popular sites whose login and checkout pages shouldn't be sent. Subdomains are covered. */
export const TRUSTED_DOMAINS = [
  "google.com", "youtube.com", "gmail.com", "apple.com", "icloud.com", "microsoft.com", "live.com", "office.com",
  "outlook.com", "microsoftonline.com", "amazon.com", "paypal.com", "github.com", "linkedin.com", "facebook.com",
  "instagram.com", "whatsapp.com", "x.com", "twitter.com", "reddit.com", "netflix.com", "spotify.com", "chase.com",
  "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com", "americanexpress.com", "discover.com",
  "usbank.com", "schwab.com", "fidelity.com", "vanguard.com", "robinhood.com", "coinbase.com", "kraken.com",
  "venmo.com", "cash.app", "zellepay.com", "stripe.com", "shopify.com", "ebay.com", "walmart.com", "target.com",
  "bestbuy.com", "costco.com", "etsy.com", "airbnb.com", "booking.com", "expedia.com", "uber.com", "lyft.com",
  "doordash.com", "usps.com", "ups.com", "fedex.com", "dhl.com", "adobe.com", "dropbox.com", "zoom.us", "slack.com",
  "notion.so", "atlassian.com", "okta.com", "salesforce.com", "yahoo.com", "wikipedia.org", "stackoverflow.com",
  "openai.com", "anthropic.com", "claude.ai", "steampowered.com", "steamcommunity.com", "epicgames.com",
  "discord.com", "telegram.org", "tiktok.com", "pinterest.com", "twitch.tv", "duolingo.com", "irs.gov",
];

export function isTrusted(hostname: string, userTrusted: string[] = []): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (/\.(gov|mil)$/.test(h)) return true;
  return [...TRUSTED_DOMAINS, ...userTrusted].some((d) => h === d || h.endsWith("." + d));
}

/** URL and title first (lookalike domains are a strong signal), then the visible text. */
export function pageInput(doc: Document, url: URL): CheckInput {
  const body = ((doc.body as HTMLElement | null)?.innerText ?? doc.body?.textContent ?? "")
    .replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const text = `${url.origin}${url.pathname}\n${doc.title}\n\n${body}`.slice(0, 4000);
  return { text, channel: "webpage", sender: url.hostname };
}

/** Best guess at where a pasted or selected snippet came from. */
export function guessChannel(text: string): Channel {
  if (/^https?:\/\/\S+$/.test(text)) return "webpage";
  return text.length > 600 ? "email" : "sms";
}

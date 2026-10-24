# ScamShield Chrome extension

Manifest V3, TypeScript, bundled with esbuild. Uses the live ScamShield API.

Spam filters already catch most scam email, so the extension focuses on where scams get through: chats and websites. Every automatic check is **opt-in**; on install a welcome page offers three switches, and Chrome only grants a feature's sites when it's turned on.

| Feature | What it does |
|---|---|
| **Chats** | WhatsApp Web, LinkedIn messages, Google Messages for web, Telegram Web, Discord DMs. When a stranger starts a conversation, checks their messages and shows a floating warning if it looks like a scam. |
| **Websites** | Warns on unfamiliar sites that ask for a password, card details, or a crypto wallet / recovery phrase, with a "Trust this site" button. |
| **Email** | Gmail and Outlook on the web: a banner above each opened email. Off by default. |
| Always on | Right-click selected text → **Check with ScamShield**; toolbar popup to paste any message. |

## Install locally

```bash
npm install
npm run build
```

Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/dist`.

## How it's built

| File | Role |
|---|---|
| `src/features.ts` | The three opt-in features: their sites, optional host permissions, and content script. |
| `src/background.ts` | Service worker. The only code that calls the API (sites' content security policies block content scripts); streams explanations over ports; caches results by SHA-256 in `chrome.storage.session`. Registers a feature's content script only while it's switched on and its sites are granted, and re-syncs when access is revoked. |
| `src/chat.ts` | Per-site readers for the open conversation, using stable markers (`is-outgoing`, `message-in`/`-out`, id prefixes) over generated class names. Decides which conversations are "new". |
| `src/webrisk.ts` | Risky-page detection (password, card, wallet fields), trusted-domain list, page-to-model input. |
| `src/extract.ts` | Gmail/Outlook email reader. |
| `src/content-*.ts` | One content script per feature; throttled `MutationObserver`s for single-page apps. |
| `src/ui/` | Verdict card in Shadow DOM (host CSS can't touch it; model output is HTML-escaped), floating card, opt-in switches. |

## Tests

```bash
npm test                     # 23 unit tests: email, chat, and website readers on fixture HTML
node build.mjs --harness     # builds dev/dist for the test pages
python3 -m http.server 5500 --directory dev
```

Test pages run the real background and content scripts against the live API with a small `chrome.*` stand-in (`dev/chrome-mock.ts`):
`gmail.html` (email banner), `whatsapp.html` (stranger vs. friend chats, new messages, dismissal), `phishing.html` (fake login page, trust button), `dist/popup.html` (switches and manual checks).

The site readers are written against each site's current markup and verified on fixture pages, not inside signed-in accounts, so check them in a real account after installing. Facebook Messenger isn't supported: its markup doesn't reliably distinguish your messages from the other person's.

## Privacy

- **Nothing is read until you turn a feature on**, and Chrome asks before ScamShield gets access to those sites. Turning a feature off stops it immediately; you can also revoke site access in Chrome's extension settings.
- **Chats:** only conversations the other person started, where you've replied at most twice, are sent; the other person's latest few messages are checked. Ongoing chats with people you talk to are never sent. Safe conversations show nothing.
- **Websites:** a page is sent only if it asks for a password, card details, or a crypto wallet **and** isn't a well-known site (big banks, Google, Apple, Amazon, PayPal, …) or one you've trusted. The page address (without the query string), title, and visible text are sent. Ordinary browsing is never sent.
- **Email:** when on, the email you open (sender, subject, body) is sent.
- Sent text goes over HTTPS to the ScamShield API, is analyzed in memory, and is discarded. The API never logs or stores message text.
- The extension caches results in session storage keyed by a SHA-256 hash, never the message itself; the cache clears when the browser closes.
- No accounts, no analytics, nothing sold or shared.

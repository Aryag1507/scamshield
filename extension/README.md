# ScamShield Chrome extension

Manifest V3, TypeScript, bundled with esbuild. Uses the live ScamShield API.

- **In Gmail and Outlook on the web:** opening an email shows a banner above it. Scam or suspicious gets a full warning with a streamed explanation; safe gets a small dismissible chip.
- **Anywhere:** select text, right-click → **Check with ScamShield** for a floating verdict card.
- **Toolbar popup:** paste any message to check it, and turn automatic email checking on or off.

## Install locally

```bash
npm install
npm run build
```

Then in Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose `extension/dist`.

## How it's built

| File | Role |
|---|---|
| `src/background.ts` | Service worker; the only code that calls the API (pages' content security policies block direct calls). Streams the explanation back over a port; caches results by SHA-256 in `chrome.storage.session`. |
| `src/extract.ts` | Finds the open email in Gmail/Outlook (sender, subject, body). Both sites can change their DOM, so every field has fallbacks and sender/subject are optional. |
| `src/content.ts` | Watches the single-page app with a throttled `MutationObserver`, checks each email once, re-attaches the banner when the site re-renders, remembers dismissals. |
| `src/ui/card.ts` | The verdict card, rendered in a Shadow DOM so host-page CSS can't affect it. Model output is HTML-escaped. |
| `src/overlay.ts` | Floating card for right-click checks, injected only on demand (`activeTab`). |

## Tests

```bash
npm test                       # extraction unit tests against Gmail/Outlook fixture HTML
node build.mjs --harness       # builds dev/dist for the test pages below
python3 -m http.server 5500 --directory dev   # then open http://localhost:5500/gmail.html
```

`dev/gmail.html` runs the real background, content, and overlay code against the live API, with a small `chrome.*` stand-in (`dev/chrome-mock.ts`); its buttons simulate opening emails and Gmail re-rendering. `dev/dist/popup.html` does the same for the popup.

The extraction selectors are written against Gmail's and Outlook's current markup. They're verified on fixture pages, not inside a signed-in account, so check them in a real inbox after installing.

## Privacy

- Emails are only read on Gmail and Outlook on the web, and only while automatic checking is on (toggle in the popup).
- The text of the email you open (with its sender and subject) is sent over HTTPS to the ScamShield API, analyzed in memory, and discarded. The API never logs or stores message text.
- The extension caches results in session storage keyed by a SHA-256 hash of the message, never the message itself; the cache is cleared when the browser closes.
- No accounts, no analytics, no data sold or shared.

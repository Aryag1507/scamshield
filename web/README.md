# ScamShield website

Next.js 15 (App Router) + Tailwind 4. Paste a message, get a verdict from the ScamShield API.

```bash
npm install
echo "NEXT_PUBLIC_API_URL=https://aryag1507--scamshield-api-web.us-east.modal.run" > .env.local
npm run dev
```

- `components/Checker.tsx`: input, channel auto-detect, examples, request lifecycle (cancels stale requests, slow-start notice, verdict first then explanation)
- `components/VerdictCard.tsx`: verdict, explanation, confidence bar, what-to-do advice
- `lib/detect.ts`: guesses the channel from pasted text and lifts `From:`/`Subject:` headers into fields
- `lib/check.ts`: API client

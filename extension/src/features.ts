import type { Feature } from "./types";

export const CHAT_SITES = [
  "https://web.whatsapp.com/*",
  "https://www.linkedin.com/*",
  "https://messages.google.com/*",
  "https://web.telegram.org/*",
  "https://discord.com/*",
];
export const EMAIL_SITES = [
  "https://mail.google.com/*",
  "https://outlook.live.com/*",
  "https://outlook.office.com/*",
  "https://outlook.office365.com/*",
];

type FeatureDef = {
  title: string;
  description: string;
  /** Optional host permissions requested when the user turns the feature on. */
  origins: string[];
  script: string;
  matches: string[];
  excludeMatches?: string[];
  /** Also run inside same-site frames (LinkedIn renders messaging in an iframe). */
  allFrames?: boolean;
};

export const FEATURES: Record<Feature, FeatureDef> = {
  chats: {
    title: "Chats",
    description: "WhatsApp Web, LinkedIn, Google Messages, Telegram, Discord. Only new conversations a stranger started are checked; chats with people you talk to stay on your computer.",
    origins: CHAT_SITES,
    script: "content-chat.js",
    matches: CHAT_SITES,
    allFrames: true,
  },
  sites: {
    title: "Websites",
    description: "Warns on unfamiliar sites that ask for a password, card details, or a crypto wallet. Ordinary browsing is never sent.",
    origins: ["<all_urls>"],
    script: "content-web.js",
    matches: ["http://*/*", "https://*/*"],
    excludeMatches: [...CHAT_SITES, ...EMAIL_SITES],
  },
  email: {
    title: "Email",
    description: "Gmail and Outlook on the web. Their spam filters already catch most scams, so this is off by default.",
    origins: EMAIL_SITES,
    script: "content-email.js",
    matches: EMAIL_SITES,
  },
};

export const FEATURE_IDS = Object.keys(FEATURES) as Feature[];

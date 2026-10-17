import type { Channel } from "./check";

export type Example = { label: string; channel: Channel; sender?: string; subject?: string; text: string };

// Written for the demo; none of these appear in the training data.
export const EXAMPLES: Example[] = [
  {
    label: "Toll text",
    channel: "sms",
    sender: "+1 (213) 555-0199",
    text: "FasTrak: You have an unpaid toll balance of $6.85. To avoid a $50 late fee, pay by tonight: fastrak-tollpay.info/pay",
  },
  {
    label: "Bank code",
    channel: "sms",
    sender: "37284",
    text: "Your Chase verification code is 482913. Don't share this code with anyone. Chase will never call you to ask for it.",
  },
  {
    label: "\"Wrong number\"",
    channel: "chat",
    sender: "Jessica",
    text: "Hi! Sorry, wrong number I think. But you seem nice :) I'm a crypto trader in Singapore, my uncle taught me a strategy that made 30% last month. Want me to show you?",
  },
  {
    label: "PayPal alert",
    channel: "email",
    sender: "security@paypa1-support.com",
    subject: "Your account has been limited",
    text: "We noticed unusual activity on your PayPal account and have limited it. Confirm your identity within 24 hours or your account will be permanently closed: http://paypa1-verify.co/login",
  },
  {
    label: "Order shipped",
    channel: "email",
    sender: "auto-confirm@amazon.com",
    subject: "Your Amazon.com order has shipped",
    text: "Hi Arya, your package with \"USB-C Cable (2-pack)\" has shipped and will arrive Thursday. You can track it in Your Orders.",
  },
];

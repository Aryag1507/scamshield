"""Teacher-model data generation via the Claude Message Batches API (50% cheaper, async).

Two jobs, each split into `submit` (creates a batch) and `collect` (downloads results):

  synth  - generate modern scam messages + hard-negative legitimate messages across a
           taxonomy of scam types and channels. Public datasets are 2000s-era and miss
           today's scams (toll texts, pig butchering, task scams, MFA-code theft...).
  label  - re-label the public data into scam / suspicious / safe with a one-sentence
           reason, so the student learns to explain itself, not just classify.

Usage:
  python teacher.py synth submit [--variants 5] [--per-request 10]
  python teacher.py label submit [--limit 12000]
  python teacher.py synth collect      # run after the batch finishes (usually < 1h)
  python teacher.py label collect
"""

import argparse
import json
import random
import sys
import time

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

from common import DATA_DIR, VERDICTS, dedupe_key, format_input, load_env, normalize_whitespace, read_jsonl, write_jsonl

STATE_FILE = DATA_DIR / "batches.json"

# Batch pricing is 50% of list price; $ per 1M tokens (input, output) for cost estimates.
BATCH_PRICES = {
    "claude-opus-5-5": (2.00, 10.00),
    "claude-sonnet-5-5": (1.00, 5.00),
    "claude-haiku-5-5": (0.05, 0.25),
}

# (category, verdict, channels, description). Verdict is the label every generated message gets.
TAXONOMY = [
    # --- scams ---
    ("unpaid_toll", "scam", ["sms"], "unpaid toll / E-ZPass / FasTrak balance with a payment link"),
    ("package_redelivery", "scam", ["sms", "email"], "USPS/UPS/DHL/FedEx failed delivery, pay a small redelivery fee"),
    ("bank_impersonation", "scam", ["sms", "email"], "fake fraud alert from a bank asking to verify via link or call a number"),
    ("p2p_payment_reversal", "scam", ["sms", "chat"], "Zelle/Venmo/Cash App 'accidental payment, please send it back' or fake payment-pending"),
    ("tax_authority", "scam", ["email", "sms"], "IRS/HMRC/CRA refund or arrest-threat for unpaid taxes"),
    ("crypto_investment", "scam", ["chat", "sms"], "pig-butchering style crypto/forex investment pitch from a friendly stranger"),
    ("romance", "scam", ["chat"], "online romance that escalates to asking for money, gift cards, or travel costs"),
    ("task_job_scam", "scam", ["sms", "chat"], "remote 'rate products / like videos' job that requires depositing money to unlock earnings"),
    ("fake_recruiter", "scam", ["email", "chat"], "too-good job offer requiring payment for equipment, training, or a check deposit"),
    ("tech_support", "scam", ["email", "webpage"], "Microsoft/Apple virus warning or locked computer, call support now"),
    ("fake_order_invoice", "scam", ["email"], "fake Amazon/PayPal/Best Buy Geek Squad order or subscription renewal with a dispute phone number"),
    ("streaming_billing", "scam", ["email", "sms"], "Netflix/Spotify/Disney+ payment failed, update card details"),
    ("ceo_gift_card", "scam", ["email", "sms"], "boss/executive urgently asking an employee to buy gift cards"),
    ("wrong_number_opener", "scam", ["sms", "chat"], "'wrong number' friendly opener designed to start a long-con conversation"),
    ("family_emergency", "scam", ["sms", "chat"], "'hi mum/dad, new number, phone broke' then urgent money request"),
    ("prize_lottery", "scam", ["email", "sms"], "you won a prize/lottery/giveaway, pay fees or share details to claim"),
    ("loan_forgiveness", "scam", ["email", "sms"], "student loan forgiveness or debt relief with an upfront fee"),
    ("vendor_bank_change", "scam", ["email"], "business email compromise: vendor 'updated bank details' for an invoice payment"),
    ("credential_phish_docs", "scam", ["email"], "shared DocuSign/SharePoint/Google Drive document requiring sign-in on a lookalike page"),
    ("mfa_code_theft", "scam", ["sms", "chat"], "someone asking you to read back a verification code you were just sent"),
    ("rental_housing", "scam", ["email", "chat"], "apartment listing where landlord is abroad and wants a deposit before viewing"),
    ("marketplace_overpay", "scam", ["chat", "email"], "Facebook Marketplace/Craigslist buyer overpays, asks for refund, or sends fake shipping link"),
    ("sextortion", "scam", ["email"], "claims to have hacked webcam/passwords and demands bitcoin"),
    ("account_suspension", "scam", ["email", "sms"], "Instagram/Meta copyright violation or Apple ID/Google account locked, appeal via link"),
    ("fake_charity", "scam", ["email", "sms"], "disaster relief donation request to an unverifiable charity"),
    ("utility_shutoff", "scam", ["sms", "email"], "electricity/water will be cut off in 1 hour unless paid immediately"),
    ("jury_duty_fine", "scam", ["sms", "email"], "missed jury duty / warrant, pay a fine to avoid arrest"),
    ("phishing_login_page", "scam", ["webpage"], "lookalike bank/email/crypto-wallet login page text asking for password or seed phrase"),
    ("fake_shop", "scam", ["webpage"], "too-good-to-be-true online store, massive discounts, only crypto or wire payment"),
    ("crypto_drainer", "scam", ["webpage", "chat"], "airdrop/NFT mint asking to connect wallet and sign a transaction"),
    # --- suspicious: not clearly fraud, but deserves caution ---
    ("aggressive_marketing", "suspicious", ["email", "sms"], "high-pressure marketing with countdown timers and vague unsubscribe"),
    ("unverified_job", "suspicious", ["email", "chat"], "vague recruiter outreach with no company details, asking to move to WhatsApp/Telegram"),
    ("unknown_link_share", "suspicious", ["sms", "chat"], "acquaintance-sounding message with just a shortened link and little context"),
    ("too_good_deal", "suspicious", ["webpage", "email"], "legitimate-looking store with unrealistic deals and few verifiable details"),
    # --- safe hard negatives: legitimate messages that share surface features with scams ---
    ("real_otp", "safe", ["sms"], "genuine one-time passcode message that says never to share the code"),
    ("real_bank_alert", "safe", ["sms", "email"], "real bank transaction alert that asks you to check the official app, no links to login"),
    ("real_shipping", "safe", ["sms", "email"], "real shipping/delivery update from a retailer with tracking number, no payment request"),
    ("requested_password_reset", "safe", ["email"], "password reset email the user requested, says to ignore if not you"),
    ("real_recruiter", "safe", ["email", "chat"], "legitimate recruiter from a named company with a specific role and interview scheduling"),
    ("newsletter_marketing", "safe", ["email"], "normal brand newsletter or sale promotion from a known retailer"),
    ("personal_chat", "safe", ["sms", "chat"], "everyday personal conversation between friends/family, including money between people who know each other"),
    ("work_email", "safe", ["email"], "normal workplace email about meetings, projects, or an invoice from a known vendor"),
    ("login_security_alert", "safe", ["email", "sms"], "genuine new-sign-in security alert that directs the user to account settings"),
    ("appointment_reminder", "safe", ["sms", "email"], "doctor/dentist/salon appointment reminder with reply-to-confirm"),
    ("school_community", "safe", ["email", "sms"], "school, university, or community group announcement"),
    ("subscription_receipt", "safe", ["email"], "genuine subscription renewal receipt from a real service, matching the user's account"),
    ("legit_webpage", "safe", ["webpage"], "ordinary website text: news article, product page of a real store, documentation, login page of the real site"),
]

STYLES = ["formal", "casual", "terse", "with typos and odd capitalization", "friendly and chatty", "urgent"]
REGIONS = ["US", "UK", "Canada", "India", "Australia", "US", "US"]
PERSONAS = ["college student", "retiree", "small business owner", "job seeker", "parent", "office worker", "crypto hobbyist"]

SYNTH_SCHEMA = {
    "type": "object",
    "properties": {
        "messages": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sender": {"type": "string"},
                    "subject": {"type": "string"},
                    "text": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["sender", "subject", "text", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["messages"],
    "additionalProperties": False,
}

LABEL_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": list(VERDICTS)},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "reason"],
    "additionalProperties": False,
}

SYNTH_SYSTEM = (
    "You generate realistic training data for ScamShield, a scam-detection model that protects "
    "ordinary people. Realism matters: the detector is only as good as the examples it learns from. "
    "Write messages exactly as they would arrive in someone's inbox, phone, chat app, or browser. "
    "Use made-up but plausible names, numbers, and lookalike domains; never use a real person's "
    "private details. Vary length, structure, and wording across messages so no two share a template."
)

LABEL_SYSTEM = (
    "You label messages for ScamShield, a scam-detection model.\n"
    "verdict: 'scam' = phishing, fraud, impersonation, or any attempt to steal money, credentials, or "
    "codes. 'suspicious' = not clearly fraud but a reasonable person should be cautious (pushy "
    "marketing, unverifiable requests, unexplained links). 'safe' = ordinary legitimate message, "
    "including normal marketing and spam that is merely unwanted.\n"
    "reason: one sentence, at most 25 words, naming the concrete signals in this message (sender, "
    "link, urgency, payment method, request) - not generic advice.\n"
    "The dataset's original binary label is given as a weak hint; it is often wrong for marketing spam."
)


def synth_prompt(category: str, verdict: str, channel: str, desc: str, n: int, rng: random.Random) -> str:
    style, region, persona = rng.choice(STYLES), rng.choice(REGIONS), rng.choice(PERSONAS)
    subject_rule = "a realistic subject line" if channel == "email" else "an empty string"
    kind = {
        "scam": "scam messages",
        "suspicious": "borderline messages that are not clearly fraud but warrant caution",
        "safe": "LEGITIMATE messages (these are hard negatives: they should look superficially similar to scams but be genuinely safe)",
    }[verdict]
    return (
        f"Generate {n} distinct {kind} for the channel '{channel}'.\n"
        f"Type: {desc}.\n"
        f"Target recipient: a {persona} in the {region}. Writing style for most of them: {style}.\n"
        f"Fields: sender = phone number, email address, username, or URL as it would appear; "
        f"subject = {subject_rule}; text = the full message body"
        f"{' (for webpage: the visible page text, including the URL at the top)' if channel == 'webpage' else ''}; "
        f"reason = one sentence (max 25 words) naming the specific signals that make it {verdict}."
    )


def estimate_and_confirm(requests: list[Request], model: str, est_output_tokens: int) -> None:
    in_tok = sum(len(json.dumps(r["params"]["messages"])) + len(r["params"].get("system", "")) for r in requests) / 4
    out_tok = est_output_tokens * len(requests)
    pin, pout = BATCH_PRICES.get(model, BATCH_PRICES["claude-opus-5-5"])
    cost = in_tok / 1e6 * pin + out_tok / 1e6 * pout
    print(f"{len(requests)} requests to {model}: ~{in_tok/1e6:.1f}M input + ~{out_tok/1e6:.1f}M output tokens, est. ${cost:.2f} (batch pricing, includes thinking estimate)")
    if input("submit? [y/N] ").strip().lower() != "y":
        sys.exit("aborted")


def save_state(job: str, batch_id: str, meta: dict) -> None:
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    state[job] = {"batch_id": batch_id, "meta": meta, "submitted_at": time.time()}
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def submit_synth(client: anthropic.Anthropic, args) -> None:
    rng = random.Random(args.seed)
    requests, meta = [], {}
    for category, verdict, channels, desc in TAXONOMY:
        for channel in channels:
            for v in range(args.variants):
                custom_id = f"{category}-{channel}-{v}"
                meta[custom_id] = {"category": category, "verdict": verdict, "channel": channel}
                requests.append(Request(
                    custom_id=custom_id,
                    params=MessageCreateParamsNonStreaming(
                        model=args.model,
                        max_tokens=16000,
                        system=SYNTH_SYSTEM,
                        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SYNTH_SCHEMA}},
                        messages=[{"role": "user", "content": synth_prompt(category, verdict, channel, desc, args.per_request, rng)}],
                    ),
                ))
    estimate_and_confirm(requests, args.model, est_output_tokens=args.per_request * 250 + 1500)
    batch = client.messages.batches.create(requests=requests)
    save_state("synth", batch.id, meta)
    print(f"submitted synth batch {batch.id} ({len(requests)} requests, ~{len(requests) * args.per_request} messages)")


def submit_label(client: anthropic.Anthropic, args) -> None:
    rows = read_jsonl(DATA_DIR / "public.jsonl")
    rng = random.Random(args.seed)
    # Keep every scam-labelled row (rarer, more valuable) and fill the rest with safe rows.
    scams = [r for r in rows if r["label"] == "scam"]
    safes = [r for r in rows if r["label"] == "safe"]
    rng.shuffle(scams)
    rng.shuffle(safes)
    n_scam = min(len(scams), args.limit // 2)
    picked = scams[:n_scam] + safes[: args.limit - n_scam]

    requests = [
        Request(
            custom_id=r["id"],
            params=MessageCreateParamsNonStreaming(
                model=args.model,
                max_tokens=2000,
                system=LABEL_SYSTEM,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": LABEL_SCHEMA}},
                messages=[{"role": "user", "content": f"Original label hint: {r['label']}\n\n" + format_input(r["text"], r["channel"])}],
            ),
        )
        for r in picked
    ]
    estimate_and_confirm(requests, args.model, est_output_tokens=300)
    batch = client.messages.batches.create(requests=requests)
    save_state("label", batch.id, {})
    print(f"submitted label batch {batch.id} ({len(requests)} requests)")


def iter_results(client: anthropic.Anthropic, job: str):
    state = json.loads(STATE_FILE.read_text())[job]
    batch = client.messages.batches.retrieve(state["batch_id"])
    if batch.processing_status != "ended":
        sys.exit(f"batch {batch.id} still {batch.processing_status}: {batch.request_counts}")
    stats = {"ok": 0, "errored": 0, "refused": 0, "bad_json": 0}
    for result in client.messages.batches.results(batch.id):
        if result.result.type != "succeeded":
            stats["errored"] += 1
            continue
        msg = result.result.message
        if msg.stop_reason == "refusal":
            stats["refused"] += 1
            continue
        text = next((b.text for b in msg.content if b.type == "text"), "")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            stats["bad_json"] += 1
            continue
        stats["ok"] += 1
        yield result.custom_id, data, state["meta"]
    print(f"results: {stats}")


def collect_synth(client: anthropic.Anthropic, args) -> None:
    rows, seen = [], set()
    for custom_id, data, meta in iter_results(client, "synth"):
        info = meta[custom_id]
        for m in data["messages"]:
            text = normalize_whitespace(m["text"])
            key = dedupe_key(text)
            if len(text) < 15 or key in seen:
                continue
            seen.add(key)
            rows.append({
                "id": key[:16], "text": text, "channel": info["channel"],
                "sender": m["sender"] or None, "subject": m["subject"] or None,
                "verdict": info["verdict"], "reason": m["reason"],
                "category": info["category"], "group": custom_id, "source": "synthetic",
            })
    write_jsonl(DATA_DIR / "synthetic.jsonl", rows)
    print(f"wrote {len(rows)} synthetic messages")


def collect_label(client: anthropic.Anthropic, args) -> None:
    public = {r["id"]: r for r in read_jsonl(DATA_DIR / "public.jsonl")}
    rows = []
    for custom_id, data, _ in iter_results(client, "label"):
        r = public[custom_id]
        rows.append({**r, "sender": None, "subject": None, "verdict": data["verdict"], "reason": data["reason"], "group": r["id"]})
    write_jsonl(DATA_DIR / "public_labeled.jsonl", rows)
    flips = sum(1 for r in rows if (r["label"] == "scam") != (r["verdict"] == "scam"))
    print(f"wrote {len(rows)} labeled rows; teacher disagreed with the original binary label on {flips}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("job", choices=["synth", "label"])
    parser.add_argument("action", choices=["submit", "collect"])
    parser.add_argument("--model", default="claude-opus-5-5", choices=list(BATCH_PRICES))
    parser.add_argument("--variants", type=int, default=5, help="synth: requests per (category, channel)")
    parser.add_argument("--per-request", type=int, default=10, help="synth: messages per request")
    parser.add_argument("--limit", type=int, default=12000, help="label: max public rows to label")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    load_env()  # ANTHROPIC_API_KEY from scamshield/.env
    client = anthropic.Anthropic()
    {
        ("synth", "submit"): submit_synth, ("synth", "collect"): collect_synth,
        ("label", "submit"): submit_label, ("label", "collect"): collect_label,
    }[(args.job, args.action)](client, args)


if __name__ == "__main__":
    main()

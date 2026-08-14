<h1 align="center">Clinic AI Assistant</h1>

<p align="center">
  A 24/7 bilingual assistant for medical clinics — answers from a clinic-approved
  knowledge base, collects booking requests, and hands anything sensitive to a human.<br>
  Runs entirely on Cloudflare Workers' free tier.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white">
  <img src="https://img.shields.io/badge/Gemini-4285F4?style=flat-square&logo=google&logoColor=white">
  <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white">
  <img src="https://img.shields.io/badge/Instagram-E4405F?style=flat-square&logo=instagram&logoColor=white">
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square">
</p>

> Built for and deployed at a private multi-profile clinic in Tashkent.
> This repository is the **generalised template** — all clinic-specific data has
> been replaced with example values in [`src/config.js`](src/config.js) and
> [`src/knowledge-base.js`](src/knowledge-base.js).

---

## The problem

A clinic receives the same handful of questions dozens of times a day — opening hours, address, the price of an ultrasound, how to book. An administrator answers each one by hand. Three things follow:

- Anyone who writes in the evening or at the weekend gets no reply until Monday
- Most of the administrator's day goes to questions a document could answer
- Some patients do not wait, and book at another clinic instead

## What it does

| Capability | Detail |
|---|---|
| **24/7 replies** | Nights, weekends, holidays |
| **Clinic facts** | Address, hours, phone, departments, doctors |
| **Prices & offers** | Only what is written in the knowledge base |
| **Two languages** | Answers in Uzbek or Russian, matching the client |
| **Conversation memory** | Remembers the thread, does not re-ask |
| **Lead capture** | Name → phone → reason, one question at a time |
| **Admin notification** | A completed request lands in the admin's Telegram instantly |
| **Human handover** | Escalates when it cannot answer, or when asked for a person |
| **Reply-to-answer** | The admin replies to the notification; the text reaches the client |

## What it deliberately does *not* do

In healthcare this is the part that matters. The constraints are enforced in the system prompt, and the assistant cannot argue itself out of them:

| Blocked | Behaviour |
|---|---|
| Diagnosing | Refuses, directs to an in-person appointment |
| Prescribing medication or dosages | Refuses |
| Interpreting test results | Refuses |
| Emergencies | Points to the emergency number and escalates immediately |
| Comparing the clinic's own doctors | Declines |
| Promising discounts that do not exist | Declines |
| Off-topic requests | Politely returns to clinic matters |

The assistant is a **first filter and an out-of-hours receptionist**, not a replacement for the administrator. Complaints, clinical questions and anything it is unsure of go to a person.

---

## Architecture

```
Telegram  ─┐
Instagram ─┼─► Cloudflare Worker ──► Gemini (system prompt + knowledge base)
Messenger ─┘         │                        │
                     │                        ▼
                     │                  reply + control tags
                     │                  [ESCALATE] / [LEAD_READY: ...]
                     │                        │
              ┌──────┴───────┐                │
              ▼              ▼                ▼
       Workers KV      client reply     admin Telegram
       (history,       (tags stripped)  (lead / escalation)
        mute state)
```

The model does not call tools. It signals intent by emitting control tags at the end of its reply, which the Worker parses and strips before the client sees anything. That keeps the whole round trip to a single model call — which is what makes it fit in the free tier.

### Repository layout

```
src/
├── index.js          Worker entry — routing, webhook verification, orchestration
├── ai.js             Gemini calls, control-tag parsing
├── messaging.js      Telegram / Meta send, admin notifications
├── storage.js        Conversation state in Workers KV
├── config.js         Clinic profile + system prompt   <- edit this
├── knowledge-base.js Clinic FAQ                       <- and this
└── privacy.js        Privacy policy page (Meta requires a public URL)
```

Adapting this to a different clinic means editing two files. Nothing else.

---

## Setup

```bash
git clone https://github.com/Mardonaka05/clinic-ai-assistant.git
cd clinic-ai-assistant
npm install

cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars        # fill in for local development
```

**1. Create the KV namespace** and paste the id into `wrangler.toml`:

```bash
npx wrangler kv namespace create CHATS_KV
```

**2. Push the secrets:**

```bash
npx wrangler secret put TELEGRAM_TOKEN           # @BotFather
npx wrangler secret put GEMINI_API_KEY           # Google AI Studio
npx wrangler secret put ADMIN_CHAT_ID            # @userinfobot
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # openssl rand -hex 32
npx wrangler secret put META_TOKEN               # optional, Instagram only
npx wrangler secret put VERIFY_TOKEN             # optional, Instagram only
```

**3. Deploy:**

```bash
npx wrangler deploy
```

**4. Point Telegram at the Worker:**

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

**5. For Instagram**, set the callback URL to the same Worker and the verify token to `VERIFY_TOKEN`. Meta also requires a public privacy policy — the Worker serves one at `/privacy`.

### Making it your own

- `src/config.js` — clinic name, address, phone, departments, and the behavioural rules
- `src/knowledge-base.js` — the FAQ the assistant is allowed to answer from

Anything not in the knowledge base triggers an escalation rather than an invented answer. That is intentional: a confidently wrong price costs more than an "I'll check with the administrator".

---

## Admin commands

Sent from the administrator's own Telegram chat:

| Command | Effect |
|---|---|
| `/mute <id>` | Silence the assistant for one conversation |
| `/unmute <id>` | Hand the conversation back to the assistant |
| *Reply to a notification* | Relays your text to that client and mutes the assistant |

---

## Cost

Designed to run on free tiers: Cloudflare Workers (100k requests/day), Workers KV (100k reads/day), and the Gemini free tier. No card required for a single-clinic deployment.

---

## Roadmap

- [ ] Per-conversation rate limiting
- [ ] Structured lead export (Google Sheets / CRM webhook)
- [ ] Working-hours awareness so the assistant says "the call centre opens at..."
- [ ] Analytics: most-asked questions, escalation rate, lead conversion

## License

MIT — see [LICENSE](LICENSE).

## Author

**Mardonbek Sulaymonqulov** — AI / Computer Vision Engineer
[GitHub](https://github.com/Mardonaka05) · mardonbeksulaymonqulov156@gmail.com

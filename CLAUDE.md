# CLAUDE.md — Blue Lighthouse IVR Handover
**SnapFlatFee.com® / Blue Lighthouse Realty, Inc.**
**Jorge Zea, Broker**
*For Claude Code — auto-loaded at session start*

---

## What This Project Is

A cloud-hosted IVR (Interactive Voice Response) system that answers inbound real estate listing calls, routes them intelligently to sellers/landlords, and sends notifications. Built on Node.js + Express, deployed on Railway, connected to Twilio (calls/SMS), Airtable (database), and Resend (email).

**Anthropic Claude API is wired up but not currently used.** The `@anthropic-ai/sdk` client is instantiated (`const claude = new Anthropic(...)`) and `buildRealtorSystemPrompt()` exists, but nothing in server.js ever calls `claude.messages.create()` — grep confirms zero invocations. In practice, Realtor commission questions get a hardcoded scripted response, and any other Realtor question just transfers the call to the seller. If a past version of this doc described "Claude AI answering Realtor questions" as live, that's aspirational/planned, not current behavior — confirm with Jorge before relying on it.

**This is a LIVE production system handling real customer calls.** Test carefully. Never push untested code to `main`.

---

## Repository

- **GitHub:** `snapflatfee/bluelighthouse-ivr` (private)
- **Branch:** `main` — Railway auto-deploys on every push
- **Live URL:** `https://elegant-forgiveness-production-bd35.up.railway.app`

---

## Files in This Repo

```
bluelighthouse-ivr/
├── server.js          ← THE entire IVR application (all routes, all logic)
├── dashboard.html     ← Call log + SMS conversations dashboard UI (served at /dashboard)
├── package.json       ← Dependencies
├── railway.toml       ← Railway deploy config (Nixpacks, npm start, restart on failure)
├── README.md          ← Public-facing repo overview
└── CLAUDE.md          ← This file
```

### Key dependencies (package.json)
- `express` — HTTP server
- `twilio` — Twilio SDK (TwiML generation, REST API calls)
- `airtable` — Airtable JS client
- `fuse.js` — Fuzzy address matching
- `@anthropic-ai/sdk` — installed and initialized, but currently unused (no `messages.create()` call anywhere in server.js — see note above)
- `dotenv` — env var loading
- `nodemailer` — **unused/dead.** Listed in package.json and `require()`'d at the top of server.js, but never called. All email actually goes through the Resend HTTP API (`sendEmail()`). Safe to remove next time someone's touching dependencies.

---

## Environment Variables (stored in Railway — never in code)

| Variable | What it is |
|---|---|
| `AIRTABLE_API_KEY` | Airtable personal access token (`patjG261WU...`) |
| `AIRTABLE_BASE_ID` | `appwWjEUf4fI8YvMq` |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | `+15617862892` (test number — will be replaced post-port) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `RESEND_API_KEY` | Resend API key (sending access only) |
| `EMAIL_TO` | Default recipient for unmatched voicemail notifications (falls back to this when no seller/property match is found — **required**, see note below) |
| `BASE_URL` | `https://elegant-forgiveness-production-bd35.up.railway.app` |
| `VOICE_EN` *(optional)* | Overrides the default English Twilio voice (`Google.en-US-Chirp3-HD-Aoede`) |
| `VOICE_ES` *(optional)* | Overrides the default Spanish Twilio voice (`Google.es-US-Chirp3-HD-Zephyr`) |
| `HOLD_MUSIC_URL` *(optional)* | Public URL of a short (~3–5s) MP3 played after "One moment while I look that up" while the Airtable lookup runs. Unset = spoken line only |
| `PORT` | Set automatically by Railway |

**`EMAIL_TO` is load-bearing, not optional.** It's the fallback recipient in `/voicemail-transcribed` when a call has no property match. If it's unset in Railway, those voicemail notifications fail silently.

**`EMAIL_FROM` is read but ignored.** Every `sendEmail()` call site passes `from: process.env.EMAIL_FROM`, but `sendEmail()`'s implementation only accepts `{ to, subject, html }` — the `from` field is dropped and hardcoded to `noreply@snapflatfee.com` inside the function. So the env var can be set or unset with zero behavioral difference; it's dead code, not a required variable.

**`EMAIL_APP_PASSWORD` is genuinely never needed** — a leftover from the old Gmail SMTP setup, before email moved to the Resend HTTP API (Railway blocks SMTP port 587).

---

## Architecture Overview

```
Inbound call → Twilio → POST to BASE_URL/inbound
                                ↓
                        server.js (Express)
                                ↓
              ┌─────────────────┴─────────────────┐
              ↓                                   ↓
          Airtable                           Twilio TTS
        (ALL LISTINGS)                       (Chirp3-HD
        (CALL LOG)                          Aoede/Zephyr)
              ↓
         After call ends:
         → SMS via Twilio REST API
         → Email via Resend HTTP API
           (noreply@snapflatfee.com → reply-to snapflatfee@gmail.com)
```

---

## Airtable Database

**Base:** Real Estate Listings Manager (`appwWjEUf4fI8YvMq`)

### Table: ALL LISTINGS
Key fields used by the IVR:
- `Address` / `Street Address` — property address (fuzzy matched with Fuse.js)
- `City`, `State`, `Zip code`
- `Name`, `Phone`, `Email` — seller contact info
- `Status` — singleSelect (`Active`, `Stand By`, `Pending`, `Closed`, `Temp Off`, `Canceled`, `Upload`, `Abandoned`, `Wait for Commission`). Code treats `Active` or `Pending` = live; anything else = "no longer available"
- `Type` — singleSelect, actual choices are `Sale` / `Rent` (not "Rent/Lease" — code matches via `/rent|lease|alquil/i` so it also tolerates "Lease" if that value is ever added)
- `prop_id` — unique ID (e.g. `ONBRD_00185`) used as fallback when `Listing_Link` is empty
- `SMS_Recording_Consent` — singleSelect, actual choices are `Yes I Agree` / `No I Don't Agree`. Code does an exact-string check for `'Yes I Agree'` (`server.js:1270`) — drives seller SMS in `notifySeller()`. There's a separate `Call_Recording_Consent` field on this table too, but it's not referenced anywhere in server.js.
- `BAC Offered`, `Commission NOTES` — for Realtor disclosure
- `Email` — for FCHB special case routing (see below)

### Table: CALL LOG
Key fields written by the IVR:
- `Call_ID` — Twilio CallSid
- `Call_Date`, `Caller_Number`, `Caller_Type`, `Language`
- `Property_Address` — what the caller said
- `Real_Address`, `Prop_ID` — matched property
- `Listing_Link` — linked record to ALL LISTINGS (sometimes silently dropped by Airtable on create — system uses `Prop_ID` as fallback in `postCallSends`)
- `Seller_Notified` — checkbox, set `true` in `/transfer-seller` when a call is handed to the seller

The CALL LOG table also has `Seller_SMS_Sent copy`, `SMS_Confirmed`, and `SMS_Confirmed copy` fields — none of these are referenced anywhere in server.js. Likely leftover from an earlier iteration; don't assume they're kept current.
- `Call_Disposition` — outcome string
- `SMS_Sent`, `Seller_SMS_Sent`, `Caller_SMS_Requested`, `Seller_Accepted_Call`
- `Voicemail_URL`, `Second_Leg_Recording_URL`, `Transcript`
- `BAC_Disclosed`, `Notes`

---

## Call Flow Summary

```
/inbound
  └── After hours? → /afterhours-lang → voicemail → /afterhours-transcribed
  └── In hours → /select-language
        └── /caller-type (address request, STT forced en-US always)
              └── /lookup-property (Fuse.js match → Airtable)
                    ├── No match → voicemail → snapflatfee2@gmail.com
                    ├── Inactive → "no longer available" → optional voicemail
                    ├── FCHB email? → /handleFCHB → voicemail → seller directly
                    ├── Realtor → /realtorFlow → /realtor-branch
                    │     ├── Press 1 (showing) → playTransferPrompt → /flag-sms → transfer
                    │     └── Press 2 (other) → /realtor-question
                    │           ├── Commission keywords → commission script → /realtor-commission-choice
                    │           │     ├── Press 1 → transfer
                    │           │     └── Timeout → voicemail → snapflatfee2 ONLY (not seller)
                    │           └── Anything else → playTransferPrompt → transfer
                    └── Buyer/Tenant → /buyerTenantFlow → /flag-sms → transfer
                          └── Transfer → /transfer-seller
                                └── /seller-whisper (always EN)
                                      ├── Seller accepts → dual-channel recording → /seller-unavailable
                                      │     ├── ≥20s completed → silent hangup + postCallSends()
                                      │     └── Unavailable → /unavailable-choice → voicemail or hangup
                                      └── No response → /seller-unavailable
```

---

## Key Functions

### `postCallSends(logId)`
Called when a call ends. Reads CALL LOG, finds the listing (via `Listing_Link` or `Prop_ID` fallback), then fires:
- SMS to caller (if `Caller_SMS_Requested = true`)
- SMS to seller (if `SMS_Recording_Consent = YES` in ALL LISTINGS)
- Email to seller (always, via Resend)

Triggered by:
- `setImmediate(() => postCallSends(logId))` in `/seller-unavailable`
- `/call-status` Twilio webhook (backup, fires when call ends)

### `playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber)`
Shared prompt for ALL Realtor transfer paths. Offers SMS opt-in, then always transfers regardless.

### `notifySeller({ record, callerNumber, callerType, address, city })`
Sends seller email (always) and SMS (if `SMS_Recording_Consent = YES`). Returns `true` if SMS sent.

### `sendEmail({ to, subject, html })`
HTTP POST to Resend API. Sends from `noreply@snapflatfee.com`, reply-to `snapflatfee@gmail.com`.

---

## SMS Conversation Dashboard

Separate from the voice IVR flow — a two-way texting inbox served alongside the call log, all through `dashboard.html` at `/dashboard`.

```
/sms-inbound            POST — Twilio webhook for inbound SMS replies.
                         Logs the message into the matching CALL LOG record's
                         Notes field (matched by Caller_Number, most recent).
                         No auto-reply; message just appears in the dashboard.

/api/conversations      GET  — Builds the conversation list by merging Twilio's
                         full message history (both directions, via REST API)
                         with CALL LOG context (caller type, matched property).

/api/messages           GET  — Full message thread for one conversation.

/api/send                POST — Sends an outbound SMS via Twilio REST API
                         (used by the dashboard's reply box).

/api/hide-conversation  POST — No-op placeholder; Twilio doesn't support
                         deleting message history this way. "Hiding" a
                         conversation is handled client-side via localStorage.
```

This means SMS history the dashboard shows is not stored in Airtable — it's read live from Twilio each time, with Airtable only used to attach caller-type/property context.

---

## Special Cases

### FCHB (Florida Cash Home Buyers)
Emails `kevin@floridacashhomebuyers.com` or `alejandro@floridacashhomebuyers.com` → skip all transfer logic, go straight to voicemail, email transcript directly to that seller. Checked AFTER address match and AFTER Realtor/Buyer branch decision, inside `realtorFlow` and `buyerTenantFlow`.

### Lookup flow (hold + "Great, I found…")
`/lookup-property` is now a front door: it starts the Airtable listings fetch in the background (`fetchListings()`, cached per CallSid), says "One moment while I look that up" (+ `HOLD_MUSIC_URL` if set), then redirects to `/lookup-property-run`, which does the Fuse match (`handleLookup()`). "Something else"/no-address input skips the hold. After a match, Realtor and Buyer flows open with "Great, I found {address}" (`speakableAddress()` expands SW/Ave etc. for TTS). If the search outlasts the first hold, `/lookup-property-run` holds again (up to 2 extra rounds via `attempt=`), and the wait is capped at 8s → `/universal-fallback`. Ringing while connecting to the seller can't be replaced with music without moving to `<Conference>`.

### Post-call sends are de-duplicated
`postCallSends(logId)` is triggered by both `/seller-unavailable` and `/call-status`. An in-memory `postCallSentLogIds` set makes it fire once per call (cleared after 2h, or on error so the backup can retry). Lost on restart — acceptable for this volume.

### Seller whisper and "take a message"
The seller hears: "Hi, this is SnapFlatFee calling. We have {a Realtor | a potential buyer | a potential tenant} on the line inquiring about your property. Press 1 or say yes to connect. Or press 2 or say no, and we'll take a message and send it to you by email." Caller type is passed `flag-sms`/flows → `/transfer-seller?type=` → `/seller-whisper?callerType=`. Press 2 / no / no answer → caller hears the "seller not available" menu → voicemail with `branch=seller&sellerEmail=…` → `/voicemail-transcribed` emails the seller and sends a copy to `EMAIL_TO`.

### SMS wording
Caller SMS: "Hi. The info you requested for Property: {address, city state zip}. Contact Seller|Landlord for showings and questions at Phone… Email… Attn: Jorge Zea - Broker - Realtor." then a blank line and the opt-out. (Buyers also get the sell-with-SnapFlatFee line.) Seller SMS: "Lead alert from SnapFlatFee.com. Call received inquiring about your property…", blank line before "Attn:". **No ® anywhere in SMS** (it forces Unicode encoding); emails still carry it.

Seller "Lead Call Received" email + SMS intentionally fire for every matched call that ends (including commission voicemails, inactive listings, hang-ups) — decided to keep.

Hold music: files in `audio/` are served at `BASE_URL/audio/<file>`; set `HOLD_MUSIC_URL` to that URL (currently `audio/hold.wav`, a 4s clip with 1s fade-out; the original 112s hold.mp3 is not for the repo).

### Commission branch voicemail
After the commission-disclosure script, the realtor gets an explicit two-option menu (6s window): "Press 1 / say showing" → transfers to the seller via `playTransferPrompt`; "press 2 / say message" (or silence/timeout, or anything else recognized) → voicemail. The message-leaving prompt (in both `/realtor-question`'s timeout fallback and `/realtor-commission-choice`'s else branch) explicitly invites feedback on the commission policy — this is the Sherman Act evidence layer (see README) doing its job: any pushback on the no-BAC-offered policy gets recorded on tape.

If a Realtor leaves a voicemail after the commission script → email goes to `snapflatfee2@gmail.com` ONLY. Never to seller (may contain complaints). Identified by `branch=commission` query param passed to `/voicemail-transcribed`.

### Spanish address recognition
The address gather always uses `language: 'en-US'` for STT even when the caller selected Spanish — because all Airtable addresses are in English format. Voice prompts still play in Spanish.

### `Listing_Link` fallback
Airtable's JS client sometimes silently drops linked record writes on create. `postCallSends` checks `Listing_Link` first, then falls back to searching ALL LISTINGS by `Prop_ID`. Railway logs will show: `postCallSends: Listing_Link was empty — used Prop_ID fallback (ONBRD_XXXXX)`.

---

## Voice Configuration

| Language | Voice | Twilio identifier |
|---|---|---|
| English | Aoede | `Google.en-US-Chirp3-HD-Aoede` |
| Spanish | Zephyr | `Google.es-US-Chirp3-HD-Zephyr` |

Business hours: **7AM–9PM Eastern**, every day. Handled by `isWithinBusinessHours()`.

---

## Email Routing

| Scenario | To |
|---|---|
| Matched call — seller notification | Seller's email (Airtable) |
| Voicemail — no address match | snapflatfee2@gmail.com |
| Voicemail — commission branch | snapflatfee2@gmail.com ONLY |
| After hours — matched | Seller's email |
| After hours — no match | snapflatfee2@gmail.com |
| FCHB property | kevin@ or alejandro@floridacashhomebuyers.com |

All from `noreply@snapflatfee.com`, reply-to `snapflatfee@gmail.com`.

---

## Twilio Configuration

- **Inbound webhook:** `POST https://elegant-forgiveness-production-bd35.up.railway.app/inbound`
- **Call status callback:** `POST .../call-status` (configured on the phone number in Twilio console)
- **A2P 10DLC:** Campaign `C19Z367` — Verified. Any new number must be linked to this campaign.
- **Test number:** `+15617862892` — will be canceled after RingCentral port

---

## Diagnostics

**Test Airtable connectivity:**
```
https://elegant-forgiveness-production-bd35.up.railway.app/test-airtable
```
Returns JSON showing env vars set, tables accessible, and sample records.

**Railway logs:** Railway → elegant-forgiveness → Deployments → View Logs

**Key log messages to watch for:**
- `CALL LOG create (non-fatal):` → Airtable write issue on call create
- `postCallSends: Listing_Link was empty — used Prop_ID fallback` → normal fallback
- `postCallSends: no Listing_Link or Prop_ID` → call wasn't matched to a property
- `Resend error` → email API issue
- `Caller SMS error:` → Twilio SMS issue

---

## What's Next (Pending Work)

In priority order:

1. **Test deliverables end-to-end** — confirm emails, caller SMS, seller SMS all fire after a live test call with Resend verified
2. **Jotform consent form** — add SMS + recording consent question to new seller intake forms, integrate response to Airtable `SMS_Recording_Consent` field
3. **Consent email to 184 active listings** — `consent_request_email.html` and `consent_webhook_route.js` already built (in project files). Deploy webhook route to this same Railway service, then send email campaign via Make.com
4. **Client/inbound caller IVR** — separate Twilio number, Claude-powered voice agent, grounded in `KB CONTENT` Airtable table. Architecture designed in separate chat.
5. **Port RingCentral numbers to Twilio** — port all numbers at once after both IVR systems are tested. After confirmed working, cancel test number `+15617862892`.
6. **Website chat widget** — Claude AI agent, bilingual EN/ES, vanilla JS embed, logs to `CHAT LOG` Airtable table
7. **Higgsfield AI video tutorials** — content TBD

---

## Working Style Notes

- **This is a live system** — always test locally or on a branch before pushing to `main`
- Railway auto-deploys on every push to `main` (~60 seconds)
- Confirm before: touching Twilio number config, modifying Airtable field names/types, changing `BASE_URL`
- Railway logs are the first place to look when something breaks
- Jorge prefers autonomous execution with a summary at the end
- Individual file delivery preferred over full repo zips for small changes

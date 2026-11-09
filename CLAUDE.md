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
| `SELLER_RING_SECONDS` *(optional)* | How long the seller's phone rings before we give up (default `40`). Keep it above the seller's carrier voicemail delay |
| `SELLER_CALLER_ID` *(optional)* | `caller` (default: seller sees the original caller's number) or `twilio` (seller sees `TWILIO_PHONE_NUMBER`) |
| `RECORDING_BACKFILL_DELAYS_MS` *(optional)* | Comma-separated delays for the recording look-up after the seller's leg ends (default `20000,90000`) |
| `HOLD_MUSIC_URL` *(optional)* | Public URL of a short (~3–5s) MP3 played after "One moment while I look that up" while the Airtable lookup runs. Unset = spoken line only |
| `ALERT_EMAIL` *(optional)* | Where `alertError()` sends a "something failed" email (currently: `fetchRecordingAttachment` / `uploadRecordingToAirtable` failures). Falls back to `EMAIL_TO` if unset; if neither is set, failures only show in Railway logs |
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
- `UniqueID` — unique ID (e.g. `ONBRD_00185`), used as fallback when `Listing_Link` is empty. **Renamed from `prop_id` in Airtable between 2026-09-21 and 2026-10-15**; the IVR asks Airtable for fields by name, so a renamed field breaks every lookup — check `/test-airtable` after any Airtable rename. (CALL LOG still has its own `Prop_ID` field, unchanged.)
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
                                ("If the seller doesn't answer, you can leave a message on their voicemail after the tone")
                                └── plain <Dial> to the seller's phone — NO whisper/screening, dual-channel recorded,
                                    rings SELLER_RING_SECONDS (default 40s) so the seller's carrier voicemail can answer
                                      ├── Seller answers OR their voicemail answers → caller talks / leaves the message there
                                      │     └── /seller-unavailable: ≥20s completed → silent hangup + postCallSends()
                                      └── No answer / busy / failed / call ended <20s → /seller-unavailable
                                            → "seller not available" → /unavailable-choice → OUR voicemail (emailed to seller + copy to EMAIL_TO) or hangup
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

## SMS Conversation Dashboard — moved to Manager Dashboard

The two-way texting inbox (`/dashboard`, `dashboard.html`, `/api/conversations`, `/api/messages`, `/api/send`, `/api/hide-conversation`) was **removed from this IVR on 2026-10-15**. It had no login, so anyone with the Railway URL could read every SMS thread and send texts from the A2P-registered number. Jorge reads and replies to texts in the **Messages tab of the Manager Dashboard** (`../manager_dashboard`, its own repo/Railway service with its own login). Don't re-add these routes here.

What stays in this IVR:

```
/sms-inbound            POST — Twilio webhook for inbound SMS replies (keep it
                         set on the Twilio number). Logs the message into the
                         matching CALL LOG record's Notes field (matched by
                         Caller_Number, most recent). No auto-reply.
```

SMS history is not stored in Airtable — the Manager Dashboard reads it live from Twilio.

---

## Special Cases

### FCHB (Florida Cash Home Buyers)
Emails `kevin@floridacashhomebuyers.com` or `alejandro@floridacashhomebuyers.com` → skip all transfer logic, go straight to voicemail, email transcript directly to that seller. Checked AFTER address match and AFTER Realtor/Buyer branch decision, inside `realtorFlow` and `buyerTenantFlow`.

### Recordings: emailed as attachments + saved into Airtable (rewritten 2026-11-09)
- **ROOT CAUSE found 2026-11-09:** the `<Dial record=…>` value was `record-from-answer-dual-channel`, which is **not a valid Twilio value** (valid: `record-from-answer`, `record-from-ringing`, `record-from-answer-dual`, `record-from-ringing-dual`). Twilio ignored it, so **calls with sellers were never recorded** (that's why no CALL LOG row ever had `Second_Leg_Recording_URL`). Now `record-from-answer-dual`. If a recording is missing again, first check Twilio Console → Monitor → Recordings for a Dial-sourced recording before debugging Airtable.
Twilio's `RecordingUrl` needs our Twilio login, so a bare link is useless to anyone else. Two destinations:
- **Voicemails** (≤120s) are fetched server-side (`fetchRecordingAttachment`) and **attached** to the email as `voicemail.mp3`; the same bytes go into CALL LOG **`Voicemail_File`**.
- **The call with the seller** (dual-channel, includes a seller-voicemail greeting + message) goes into CALL LOG **`MP3`** — **never emailed** (can be long, and it's a conversation between two people).
- **Attachment fields are addressed by permanent Airtable field ID** (`AT_FIELDS` in server.js: `fldMMqmGHjQAR3Db4` = Voicemail_File, `fldhLW65JGGv27bId` = MP3). **Why:** on 2026-11-09 every voicemail upload failed with a 403 `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` because the code wrote `"Voicemail File"` (space) and the field is `Voicemail_File` (underscore). Field names can now be renamed freely in Airtable (the old "Call Recording File" was renamed to "MP3" that way).
- **Two ways in** (`saveRecordingToAirtable`): (1) *direct upload* — base64 to `content.airtable.com/.../{fieldId}/uploadAttachment`, used for voicemails ≤4.5 MB (Airtable's direct limit is 5 MB); (2) *link method* — `createRecordingLink()` makes a short-lived (15 min) unguessable URL `BASE_URL/rec/<token>.mp3` that streams the recording from Twilio with our Twilio login; Airtable is given `[{url}]` on the field and downloads its own copy. Used for every call recording (any length) and as the fallback when a direct upload fails. If both fail → one alert email (`alertError`).
- **`/second-leg-recording` has never delivered** in any call we can see (no CALL LOG row has ever had `Second_Leg_Recording_URL`), so there is a **safety net**: when the seller's leg ends (`/seller-status` `completed`), `scheduleRecordingBackfill` asks Twilio's REST API for that call's recordings (parent + child SID) at +20s and +90s (`RECORDING_BACKFILL_DELAYS_MS`), keeps only `source = DialVerb`, and saves them. `savedRecordingSids` makes webhook + look-up idempotent. Railway logs now say `second-leg-recording webhook: …` and `recording look-up: call X has N recording(s)` — check these if a recording is missing.
- Not verified live as of 2026-11-09: whether Airtable accepts field IDs as keys in record *writes* (the code retries with the field name if it doesn't), and whether the Dial recording is attached to the parent or child call SID (both are queried).

### Error alerts
Railway has no built-in "email me when this log line appears" feature, so `alertError(context, err)` sends its own email via Resend (to `ALERT_EMAIL`, falling back to `EMAIL_TO`) whenever `fetchRecordingAttachment` or `uploadRecordingToAirtable` fails, in addition to the Railway log line. Not wired into every `console.error` in the file — just these two so far.

### Lookup flow (hold + "Great, I found…")
`/lookup-property` is now a front door: it starts the Airtable listings fetch in the background (`fetchListings()`, cached per CallSid), says "One moment while I look that up" (+ `HOLD_MUSIC_URL` if set), then redirects to `/lookup-property-run`, which does the Fuse match (`handleLookup()`). "Something else"/no-address input skips the hold. After a match, Realtor and Buyer flows open with "Great, I found {address}" (`speakableAddress()` expands SW/Ave etc. for TTS). If the search outlasts the first hold, `/lookup-property-run` holds again (up to 2 extra rounds via `attempt=`), and the wait is capped at 8s → `/universal-fallback`. Ringing while connecting to the seller can't be replaced with music without moving to `<Conference>`.

### Post-call sends are de-duplicated
`postCallSends(logId)` is triggered by both `/seller-unavailable` and `/call-status`. An in-memory `postCallSentLogIds` set makes it fire once per call (cleared after 2h, or on error so the backup can retry). Lost on restart — acceptable for this volume.

### Seller handoff: plain forward, caller reaches the seller's own voicemail (changed 2026-11-03)
The old whisper ("Hi, this is SnapFlatFee calling… press 1 to connect") and its `/seller-whisper` + `/seller-consent` routes were **removed**. `/transfer-seller` now tells the caller *"We are connecting you with the seller now. If the seller doesn't answer, you can leave a message on their voicemail after the tone. One moment please."* and does a plain `<Dial>` to the seller's phone (record-from-answer-dual, so the greeting + message are recorded to Airtable's `MP3` either way).
- **Ring time:** `SELLER_RING_SECONDS` (default 40, range 15–120). Must outlast the seller's carrier "ring then voicemail" delay (~20–30s) or the caller never reaches the voicemail and falls to our fallback.
- **Caller ID the seller sees:** by default the **original caller's number** (Twilio's `<Dial>` default — the seller can call the Realtor/buyer back from the missed-call/voicemail entry). Set `SELLER_CALLER_ID=twilio` to show SnapFlatFee's number (`TWILIO_PHONE_NUMBER`) instead (callbacks would then reach the IVR).
- **What the seller gets:** their own voicemail from the caller, plus the generic "Lead Call Received" email and the lead-alert SMS. **No emailed recording** for a message left on their own voicemail.
- **Our voicemail is still the fallback** when nobody takes the call: no answer / busy / failed / seller hung up in <20s → "The seller is not available right now… press 1 to leave a message" → our `/voicemail` (`branch=seller`) → email with the recording attached to the seller + copy to `EMAIL_TO`.
- **Known limitation:** with no screening we cannot tell a live conversation from a voicemail. Both are a ≥20s completed call → `Call_Disposition = Completed`, and `Seller_Accepted_Call` is checked whenever the seller's line *answered* (person **or** voicemail). Listen to `MP3` to know which. (Twilio's machine detection exists for `<Number>` but its docs don't say how it interacts with bridging, it may cost extra and need an account feature — deliberately not used; revisit if labeling matters.)
- Tested by running the real server against stand-ins for Airtable (which rejects invalid dropdown values like the real one), Twilio recordings and Resend, with signed requests (50 checks on 2026-11-09, mutation-checked against the original bugs); the harness lives outside the repo.

### SMS wording
Caller SMS: "Hi. The info you requested for Property: {address, city state zip}. Contact Seller|Landlord for showings and questions at Phone… Email… Attn: Jorge Zea - Broker - Realtor." then a blank line and the opt-out. (Buyers also get the sell-with-SnapFlatFee line.) Seller SMS: "Lead alert from SnapFlatFee.com. Call received inquiring about your property…", blank line before "Attn:". **No ® anywhere in SMS** (it forces Unicode encoding); emails still carry it.

Seller "Lead Call Received" email + SMS intentionally fire for every matched call that ends (including commission voicemails, inactive listings, hang-ups) — decided to keep.

Hold music: files in `audio/` are served at `BASE_URL/audio/<file>`; set `HOLD_MUSIC_URL` to that URL (currently `audio/hold.wav`, a 4s clip with 1s fade-out; the original 112s hold.mp3 is not for the repo).

### Commission branch voicemail
After the commission-disclosure script, the realtor gets an explicit two-option menu (6s window): "Press 1 / say showing" → transfers to the seller via `playTransferPrompt`; "press 2 / say message" (or silence/timeout, or anything else recognized) → voicemail. The message-leaving prompt (in both `/realtor-question`'s timeout fallback and `/realtor-commission-choice`'s else branch) explicitly invites feedback on the commission policy — this is the Sherman Act evidence layer (see README) doing its job: any pushback on the no-BAC-offered policy gets recorded on tape.

If a Realtor leaves a voicemail after the commission script → email goes to `snapflatfee2@gmail.com` ONLY. Never to seller (may contain complaints). Identified by `branch=commission` query param passed to `/voicemail-transcribed`.

### Address recognition (rewritten 2026-11-09)
- **Language:** the address prompt listens in the caller's language (`es-US` for Spanish — it used to be forced to en-US, which turned Spanish speech into nonsense). The text is **normalized** (`normalizeAddress`: suroeste/sur oeste → SW, avenida/calle → ave/st, 13th → 13, apt/unit dropped) before comparing with the English addresses in Airtable.
- **A fuzzy match is no longer trusted on its own** (`findBestMatch`): the **house number must equal** the listing's, the **direction** (NW/SW…) must agree, and other street numbers must be present; filler words before/after the address are ignored. If the same property is listed twice, the Active/Pending listing wins. **Why:** "On to Southwest." was fuzzy-matched to an unrelated Temp Off listing and the caller was told "no longer available".
- **Can't pin it down → keypad:** "Please use your keypad to enter the numeric portion of the address, the house number, then press pound" (`/lookup-keypad` → `/lookup-number`) → reads up to 4 Active/Pending candidates back one at a time ("Is this the property: …? Press 1 for yes, 2 for no" — `/lookup-confirm`, `/lookup-confirm-answer`; silence = no) → yes continues into the normal flow (log Notes say it was confirmed on the keypad); no/none → "couldn't find it". State is stateless (digits + idx in the query string; candidates recomputed).
- **Not found, or the property isn't Active/Pending → the same message** (`finishNotFound`): "we couldn't find that property. We'll take your message… a service representative will process your inquiry shortly", logged `No Match Found` with the reason in Notes. The IVR **never says "no longer available"** any more.
- **Every prompt that asks for a message asks for the property address** (`MSG_EN`/`MSG_ES`/`leaveMsg()`); the seller-voicemail announcement does too. `test`: harness checks all of them.
- After-hours voicemails use the same strict matching on the transcript (`findMatchInText`) so a garbled transcript can never email the wrong seller.
- **Spanish voicemails:** Twilio's built-in transcription is **English-only** (documented), so Spanish messages produce nonsense transcripts. Emails and the Airtable `Transcript` now say so ("Mensaje en español… listen to the recording"). A real Spanish transcript would need a different service (e.g. Twilio Voice Intelligence with an es-US service, or another speech-to-text) — not built; ask Jorge.

### Call_Disposition may only use these 6 values
`Transferred to Seller`, `SMS Sent`, `Voicemail Left`, `Hung Up`, `No Match Found`, `Transferred to Voicemail`. Airtable **rejects any other value** (and the code swallows the error, so the whole update is lost). Until 2026-11-09 the code wrote `Completed`, `Inactive Property`, `FCHB - Voicemail` and `Seller Unavailable (…)` — those updates silently failed. Now: seller never took the call → `Transferred to Voicemail` + a line in Notes (`appendNote`); inactive/unmatched → `No Match Found` + Notes; FCHB → `Voicemail Left` + Notes; real call length → `Call_Duration_Sec` (from `/call-status`). If you add a disposition, add the dropdown option in Airtable first.

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
Returns only yes/no JSON (`all_listings_ok`, `call_log_ok`). It's public, so it no longer shows env vars, key prefixes or sample records — on `false`, the reason is in the Railway logs (`test-airtable ALL LISTINGS:` / `test-airtable CALL LOG:`).

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

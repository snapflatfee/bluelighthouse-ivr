# Blue Lighthouse Realty — IVR System
## Jorge Zea | Licensed Real Estate Broker

---

## What This System Does

- Answers inbound calls in English and Spanish automatically
- Detects caller as Realtor, Buyer/Tenant, or Seller-side and routes accordingly
- Collects property address via speech recognition (always transcribed as English, since Airtable addresses are in English)
- Fuzzy-matches spoken address against Airtable `ALL LISTINGS`
- For Realtors: discloses commission policy with a scripted response, transfers non-commission questions to the seller directly, offers to transfer to the seller for showings (the Anthropic SDK is installed but not currently wired into this flow — see `CLAUDE.md`)
- For Buyers/Tenants: offers to connect with the seller and texts contact info
- Sends SMS with seller contact info to the caller (with consent) and notifies the seller by SMS/email
- Records calls (dual-channel) and transcribes voicemails
- Emails voicemail transcripts and call notifications to the office
- Logs every call to the Airtable `CALL LOG` table
- Includes a two-way SMS conversation dashboard (`/dashboard`) for replying to callers/sellers by text

This is a **live production system**. See `CLAUDE.md` for the full architecture, call-flow diagram, and environment variable reference.

---

## Setup Instructions

### 1. Deploy to Railway

1. Go to railway.app → New Project → Deploy from GitHub
2. Connect this repo (`snapflatfee/bluelighthouse-ivr`)
3. Railway auto-detects Node.js (`railway.toml` sets the build/start/restart config) and deploys
4. Copy your Railway URL

### 2. Set Environment Variables in Railway

| Variable | Where to find it |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account Info |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Account Info |
| `TWILIO_PHONE_NUMBER` | Twilio Console → Phone Numbers |
| `AIRTABLE_API_KEY` | Airtable → Account → Developer Hub → Personal Access Token |
| `AIRTABLE_BASE_ID` | `appwWjEUf4fI8YvMq` |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `RESEND_API_KEY` | resend.com → API Keys (email delivery; Railway blocks SMTP) |
| `EMAIL_TO` | Default recipient for unmatched voicemail notifications (**required**) |
| `BASE_URL` | Your Railway URL |
| `VOICE_EN` *(optional)* | Overrides the default English Twilio voice |
| `VOICE_ES` *(optional)* | Overrides the default Spanish Twilio voice |

### 3. Configure Twilio Phone Number

1. Twilio Console → Phone Numbers → Manage → Your number
2. Under Voice & Fax:
   - When a call comes in: Webhook
   - URL: `https://your-railway-url.railway.app/inbound`
   - Method: HTTP POST
3. Under Messaging:
   - When a message comes in: Webhook
   - URL: `https://your-railway-url.railway.app/sms-inbound`
   - Method: HTTP POST
4. Save

### 4. Test the System

Call your Twilio number and say:
- "Realtor" → should ask for property address → respond with commission info
- Say any address in your Airtable → should match and continue the flow
- "Buyer" or "Tenant" → should ask for address → offer to connect + text

---

## Webhook Endpoints

Voice (IVR) flow — see `CLAUDE.md` for the full call-flow diagram:

| Endpoint | Purpose |
|---|---|
| POST /inbound | Answers call, plays greeting, checks business hours |
| POST /select-language | Language selection |
| POST /caller-type | Detects Realtor vs Buyer/Tenant |
| POST /lookup-property | Airtable fuzzy address match |
| POST /realtor-branch, /realtor-question, /realtor-commission-choice | Realtor flow + commission disclosure |
| POST /transfer-seller, /seller-whisper, /seller-status, /seller-unavailable | Connects caller to seller |
| POST /voicemail, /voicemail-done, /voicemail-transcribed | Voicemail recording + transcription |
| POST /afterhours-lang, /afterhours-transcribed | After-hours flow |
| POST /call-status | Twilio call-status webhook (backup trigger for post-call notifications) |

SMS conversation dashboard:

| Endpoint | Purpose |
|---|---|
| POST /sms-inbound | Twilio webhook for inbound SMS replies |
| GET /api/conversations | Conversation list (merges Twilio history + CALL LOG context) |
| GET /api/messages | Full thread for one conversation |
| POST /api/send | Sends an outbound SMS |
| POST /api/hide-conversation | Hides a conversation client-side (no-op server-side) |
| GET /dashboard | Serves the dashboard UI |

---

## Airtable Fields Used

### ALL LISTINGS (source data)
- Address / Street Address, City, State, Zip code
- Name, Phone, Email (seller)
- Status (Active/Pending = live), Type (Sale vs Rent)
- prop_id (fallback ID when Listing_Link doesn't stick)
- SMS_Recording_Consent (Yes I Agree / No I Don't Agree)
- BAC Offered, Commission NOTES

### CALL LOG (written per call)
- Call_ID, Call_Date, Caller_Number, Caller_Type, Language
- Property_Address (spoken), Real_Address, Prop_ID, Listing_Link
- Call_Disposition, SMS_Sent, Seller_SMS_Sent, Seller_Notified, Caller_SMS_Requested, Seller_Accepted_Call
- Voicemail_URL, Second_Leg_Recording_URL, Transcript
- BAC_Disclosed, Notes (also used to log inbound SMS replies)

---

## Voice Settings

Default voices (Google Chirp3-HD, via Twilio):
- English: Aoede (`Google.en-US-Chirp3-HD-Aoede`)
- Spanish: Zephyr (`Google.es-US-Chirp3-HD-Zephyr`)

To change: set `VOICE_EN` / `VOICE_ES` in environment variables.

Business hours: 7AM–9PM Eastern, every day.

---

## Sherman Act Evidence Layer

Every Realtor call automatically logs:
- Caller phone number (brokerage identification)
- Commission disclosed at time of call
- Call duration (short calls = potential steering)
- Full transcript of what they said
- Call disposition (showed / didn't show / hung up)
- Recording URL with timestamp

This data accumulates in CALL LOG linked to each listing, enabling pattern analysis by brokerage, commission level, and showing rate over time.

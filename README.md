# Blue Lighthouse Realty — IVR System
## Jorge Zea | Licensed Real Estate Broker

---

## What This System Does

- Answers inbound calls in English and Spanish automatically
- Detects caller as Realtor, Buyer, or Tenant
- Collects property address via speech recognition
- Fuzzy-matches spoken address against Airtable ALL LISTINGS
- For Realtors: discloses commission policy, lets Claude AI handle questions
- For Buyers/Tenants: offers to connect with seller + text contact info
- Sends SMS with seller contact info to caller
- Records every call + transcribes voicemails
- Emails voicemail transcripts to Jorge
- Notifies seller by email when someone calls about their property
- Logs every call to Airtable CALL LOG table

---

## Setup Instructions

### 1. Deploy to Railway (Free tier available)

1. Go to railway.app → New Project → Deploy from GitHub
2. Upload this folder or connect your GitHub repo
3. Railway auto-detects Node.js and deploys
4. Copy your Railway URL (e.g. https://bluelighthouse-ivr.railway.app)

### 2. Set Environment Variables in Railway

Copy all values from `.env.example` into Railway's Variables tab:

| Variable | Where to find it |
|---|---|
| TWILIO_ACCOUNT_SID | Twilio Console → Account Info |
| TWILIO_AUTH_TOKEN | Twilio Console → Account Info |
| TWILIO_PHONE_NUMBER | Twilio Console → Phone Numbers |
| AIRTABLE_API_KEY | Airtable → Account → Developer Hub → Personal Access Token |
| AIRTABLE_BASE_ID | Already set: appwWjEUf4fI8YvMq |
| ANTHROPIC_API_KEY | console.anthropic.com → API Keys |
| EMAIL_FROM | snapflatfee@gmail.com |
| EMAIL_APP_PASSWORD | Google Account → Security → App Passwords |
| EMAIL_TO | snapflatfee@gmail.com |
| BASE_URL | Your Railway URL |

### 3. Configure Twilio Phone Number

1. Twilio Console → Phone Numbers → Manage → Your number
2. Under Voice & Fax:
   - When a call comes in: Webhook
   - URL: https://your-railway-url.railway.app/inbound
   - Method: HTTP POST
3. Save

### 4. Test the System

Call your Twilio number and say:
- "Realtor" → should ask for property address
- Say any address in your Airtable → should respond with commission info
- "Buyer" → should ask for address → offer to connect + text

---

## Webhook Endpoints

| Endpoint | Purpose |
|---|---|
| POST /inbound | Answers call, plays greeting |
| POST /caller-type | Detects Realtor vs Buyer/Tenant + language |
| POST /lookup-property | Airtable fuzzy address match |
| POST /realtor-response | Claude AI handles Realtor questions |
| POST /buyer-tenant | Buyer/Tenant flow |
| POST /send-sms | Sends SMS with contact info |
| POST /transfer-seller | Connects caller to seller |
| POST /voicemail | Records voicemail |
| POST /voicemail-transcribed | Saves transcript, emails Jorge |
| POST /recording-status | Saves recording URL to Airtable |

---

## Airtable Fields Used

### ALL LISTINGS (source data)
- Address / Street Address
- City, State, Zip code
- Name (seller)
- Phone (seller)
- Email (seller)
- BAC Offered (commission)
- Commission NOTES
- Type, List Price, Notes

### CALL LOG (written per call)
- Call_ID, Call_Date, Caller_Number
- Caller_Type, Language
- Property_Address (spoken), Real_Address (matched)
- Prop_ID, Listing_Link
- BAC_Disclosed, Call_Disposition
- SMS_Sent, Seller_Notified
- Call_Duration_Sec, Voicemail_URL, Transcript

---

## Voice Settings

Default voices (Amazon Polly Neural):
- English: Matthew-Neural (professional male)
- Spanish: Lupe-Neural (US Spanish female)

To change: update VOICE_EN / VOICE_ES in environment variables.
Other options: Polly.Joanna-Neural (EN female), Polly.Miguel-Neural (ES male)

---

## Sherman Act Evidence Layer

Every Realtor call automatically logs:
- Caller phone number (brokerage identification)
- Commission disclosed at time of call
- Call duration (short calls = potential steering)
- Full transcript of what they said
- Call disposition (showed / didn't show / hung up)
- Recording URL with timestamp

This data accumulates in CALL LOG linked to each listing,
enabling pattern analysis by brokerage, commission level,
and showing rate over time.

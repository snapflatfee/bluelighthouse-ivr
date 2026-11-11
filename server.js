/**
 * Jorge Zea | Blue Lighthouse Realty
 * Twilio IVR + Claude AI + Airtable Webhook Server
 * v2.0 — Dual voice, language selection, FL two-party consent
 */

const crypto    = require('crypto');
const express   = require('express');
const twilio    = require('twilio');
const Airtable  = require('airtable');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const Fuse      = require('fuse.js');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
const path = require('path');

// ─── TWILIO SIGNATURE CHECK ──────────────────────────────────────────────────
// Every POST route in this file is a Twilio webhook, so all POSTs must carry a
// valid X-Twilio-Signature. Twilio signs the public URL it called; Railway's
// proxy hides that, so it's rebuilt from BASE_URL + the path/query.
// TWILIO_VALIDATE (Railway env var): "on" (default) rejects bad signatures,
// "log" only logs them, "off" skips the check — the quick kill switch if calls break.
const TWILIO_VALIDATE = (process.env.TWILIO_VALIDATE || 'on').toLowerCase();
app.use((req, res, next) => {
  if (req.method !== 'POST' || TWILIO_VALIDATE === 'off') return next();
  const url = `${(process.env.BASE_URL || '').replace(/\/+$/, '')}${req.originalUrl}`;
  const ok  = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN || '',
    req.get('X-Twilio-Signature') || '',
    url,
    req.body || {}
  );
  if (ok) return next();
  console.warn(`Twilio signature check failed (${TWILIO_VALIDATE}): POST ${url}`);
  if (TWILIO_VALIDATE === 'log') return next();
  res.status(403).send('Forbidden');
});

// ─── CALLER NAME (CNAM) ──────────────────────────────────────────────────────
// With "Caller Name Lookup" switched on for the Twilio number, every voice webhook carries CallerName.
// Remember it per call (bounded, in memory) so the CALL LOG row and the seller alerts can use it.
// Carriers often return filler ("WIRELESS CALLER", "UNKNOWN"…), which is dropped; blank is fine.
const callerNames = new Map(); // callSid -> cleaned name
function cleanCallerName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60) return '';
  if (!/[a-z]/i.test(name)) return '';   // digits/symbols only (e.g. the number again)
  if (/^(unknown|unavailable|unavailable caller|wireless caller|wireless|toll free( caller)?|private|private caller|anonymous|restricted|null|n\/a|none|v\d*)$/i.test(name)) return '';
  // CNAM is usually ALL CAPS ("JOHN SMITH") — make it readable
  return name === name.toUpperCase() ? name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : name;
}
function callerNameFor(callSid) { return callerNames.get(callSid) || ''; }
app.use((req, res, next) => {
  const sid  = req.body && req.body.CallSid;
  const name = req.body && cleanCallerName(req.body.CallerName);
  if (sid && name && !callerNames.has(sid)) {
    callerNames.set(sid, name);
    if (callerNames.size > 500) callerNames.delete(callerNames.keys().next().value);
  }
  next();
});

// Airtable formula string literal: escapes \ " ' and wraps in double quotes,
// so request values can't break out of the formula.
function airtableStr(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'")}"`;
}

// Static audio (e.g. hold music). Put files in ./audio, reference as BASE_URL/audio/<file>
app.use('/audio', express.static(path.join(__dirname, 'audio')));

// SMS dashboard (/dashboard + /api/*) moved to the Manager Dashboard's
// Messages tab (separate repo with its own login) — removed here 2026-10-15
// because it was publicly reachable with no auth.

// ─── INBOUND SMS — replies from callers/sellers ──────────────────────────────
app.post('/sms-inbound', async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';

  console.log(`Inbound SMS from ${from}: ${body}`);

  // Log to CALL LOG if a recent record exists for this number, else just log to console
  try {
    const records = await base('CALL LOG').select({
      filterByFormula: `{Caller_Number} = ${airtableStr(from)}`,
      sort: [{ field: 'Call_Date', direction: 'desc' }],
      maxRecords: 1,
    }).firstPage();

    if (records.length > 0) {
      const existing = records[0].get('Notes') || '';
      await base('CALL LOG').update(records[0].id, {
        Notes: existing + `\n[SMS REPLY ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}]: ${body}`,
        Handled: false, 'Handled at': null,     // a new reply re-opens it
      }).catch(console.error);
      await updateCallSummary(records[0].id);
    }
  } catch (err) {
    console.error('SMS inbound log error:', err);
  }

  // No auto-reply — message just gets logged; read/reply in the Manager Dashboard's Messages tab
  res.type('text/xml').send('<Response></Response>');
});

const twilioClient  = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const base          = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const claude        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const { summarizeCall, changedFields } = require('./lib/callSummary');

// ─── Email via Resend (Railway blocks SMTP port 587 — use HTTP API instead) ──
// Sign up free at resend.com, get API key, add RESEND_API_KEY to Railway env vars
// Sends FROM noreply@snapflatfee.com, replies go to snapflatfee@gmail.com
async function sendEmail({ to, subject, html, attachments }) {
  const res = await fetch(`${process.env.RESEND_API_URL || 'https://api.resend.com'}/emails`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'SnapFlatFee IVR <noreply@snapflatfee.com>',
      reply_to: ['snapflatfee@gmail.com'],
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(attachments && attachments.length ? { attachments } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

// ─── Error alert email ────────────────────────────────────────────────────────
// Railway has no built-in "email me on this log line" feature, so when a step
// below fails, send ourselves an email via the same Resend path rather than
// relying on someone noticing it in Railway logs. Set ALERT_EMAIL in Railway;
// falls back to EMAIL_TO if unset. If neither is set, this just logs — same as
// before.
async function alertError(context, err) {
  const message = (err && err.message) || String(err);
  console.error(`${context}:`, message);
  const to = process.env.ALERT_EMAIL || process.env.EMAIL_TO;
  if (!to) return;
  try {
    await sendEmail({
      to, subject: `⚠️ IVR error: ${context}`,
      html: `<p><b>${context}</b></p><p>${message.replace(/</g, '&lt;')}</p><p>Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</p>`,
    });
  } catch (e) {
    console.error('alertError: failed to send alert email:', e.message);
  }
}

// ─── Recording as an email attachment ────────────────────────────────────────
// Twilio recording URLs (RecordingUrl) require Twilio Account SID/Auth Token
// Basic Auth to view — a bare link in an email is a dead end for the seller or
// snapflatfee2, who don't have Twilio Console access. Fetch the audio here
// (server-side, with our own Twilio credentials) and attach it to the email
// instead, so it just plays from the inbox. Voicemails are capped at 120s
// (see twiml.record maxLength), so this is a small file — safe to attach.
async function fetchRecordingAttachment(recordingUrl, filename = 'voicemail.mp3') {
  if (!recordingUrl) return null;
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res  = await fetch(`${recordingUrl}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const buf  = Buffer.from(await res.arrayBuffer());
    return [{ filename, content: buf.toString('base64') }];
  } catch (err) {
    await alertError('fetchRecordingAttachment', err);
    return null; // caller falls back to the (Twilio-login-gated) link
  }
}

// ─── Recordings into Airtable ────────────────────────────────────────────────
// Attachment fields are addressed by their permanent Airtable ID, never by name. (On 2026-11-09 the
// voicemail upload failed with a 403 "model not found" because the code said "Voicemail File" and the
// field is called "Voicemail_File". Renaming a field in Airtable can no longer break this.)
const AT_FIELDS = {
  voicemail: { id: 'fldMMqmGHjQAR3Db4', name: 'Voicemail_File' }, // voicemail left on our line (<= 120s)
  callMp3:   { id: 'fldhLW65JGGv27bId', name: 'MP3' },            // full call with the seller
};
const AIRTABLE_CONTENT_URL = process.env.AIRTABLE_CONTENT_URL || 'https://content.airtable.com';
const DIRECT_UPLOAD_MAX_BYTES = 4.5 * 1024 * 1024; // Airtable's direct upload limit is 5 MB

// Way 1 (small files): push the bytes straight into the field. Airtable's endpoint takes base64, so the
// auth-gated Twilio URL doesn't matter. Returns true/false; the caller decides what to do on failure.
async function uploadRecordingToAirtable(recordId, base64, filename, field = AT_FIELDS.voicemail) {
  if (!recordId || !base64) return false;
  try {
    if (Buffer.byteLength(base64, 'base64') > DIRECT_UPLOAD_MAX_BYTES) throw new Error('file is over the 5 MB direct-upload limit');
    const url = `${AIRTABLE_CONTENT_URL}/v0/${process.env.AIRTABLE_BASE_ID}/${recordId}/${field.id}/uploadAttachment`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'audio/mpeg', file: base64, filename }),
    });
    if (!res.ok) throw new Error(`Airtable uploadAttachment ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return true;
  } catch (err) {
    console.error(`direct upload to ${field.name} failed (${err.message}) — will try the link method`);
    return false;
  }
}

// Way 2 (any size): give Airtable a short-lived, unguessable link to the recording and let Airtable
// download its own copy. Our server streams the audio from Twilio (with our Twilio login) so Airtable
// never needs one. The link works for 15 minutes, then it is gone.
const recordingLinks = new Map(); // token -> { url (Twilio recording URL, no extension), expires }
function createRecordingLink(twilioRecordingUrl) {
  const token = crypto.randomBytes(24).toString('hex');
  recordingLinks.set(token, { url: twilioRecordingUrl.replace(/\.(mp3|wav|json)$/i, ''), expires: Date.now() + 15 * 60 * 1000 });
  setTimeout(() => recordingLinks.delete(token), 15 * 60 * 1000).unref();
  return `${(process.env.BASE_URL || '').replace(/\/+$/, '')}/rec/${token}.mp3`;
}
app.get('/rec/:token.mp3', async (req, res) => {
  const entry = recordingLinks.get(req.params.token);
  if (!entry || entry.expires < Date.now()) return res.status(404).send('Not found');
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const upstream = await fetch(`${entry.url}.mp3`, { headers: { Authorization: `Basic ${auth}` } });
    if (!upstream.ok) return res.status(502).send('Recording not available yet');
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    require('stream').Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('recording link error:', err.message);
    if (!res.headersSent) res.status(502).send('Error');
  }
});

// Save a recording into an attachment field: direct upload when we already have the (small) bytes,
// otherwise — or if that fails — the link method. One alert email if both fail.
async function saveRecordingToAirtable(recordId, recordingUrl, field, filename, base64) {
  if (base64 && await uploadRecordingToAirtable(recordId, base64, filename, field)) return true;
  try {
    const value = [{ url: createRecordingLink(recordingUrl), filename }];
    try { await base('CALL LOG').update(recordId, { [field.id]: value }); }
    catch (byIdErr) { await base('CALL LOG').update(recordId, { [field.name]: value }); }
    return true;
  } catch (err) {
    await alertError(`saving recording to Airtable (${field.name})`, err);
    return false;
  }
}

// The recording of the call with the seller. Twilio's callback AND our own look-up (below) can both
// deliver the same recording, so each one is only saved (and emailed) once.
const savedRecordingSids   = new Set();
const emailedRecordingSids = new Set();
const recordingSidOf = (url) => (/\/Recordings\/(RE[0-9a-f]{32})/i.exec(url || '') || [])[1] || url;
const CALL_RECORDING_EMAIL_MAX_BYTES = 25 * 1024 * 1024; // email limit is ~40 MB after base64; stay well under

// Jorge always gets the full call recording by email ("IVR - Completed Call Recording"), independent of Airtable.
async function emailCompletedCallRecording(logId, recordingUrl, durationSecs) {
  const sid = recordingSidOf(recordingUrl);
  if (emailedRecordingSids.has(sid)) return;
  emailedRecordingSids.add(sid);
  try {
    let fields = {};
    try { fields = (await base('CALL LOG').find(logId)).fields || {}; } catch (e) { console.error('call recording email: could not read CALL LOG:', e.message); }
    const pick = (v) => (v && typeof v === 'object' ? v.name : v) || '';
    const attachments = await fetchRecordingAttachment(recordingUrl, 'call-recording.mp3'); // alerts + returns null on failure
    const tooBig = attachments && Buffer.byteLength(attachments[0].content, 'base64') > CALL_RECORDING_EMAIL_MAX_BYTES;
    const attach = attachments && !tooBig ? attachments : undefined;
    const mins = Number.isFinite(durationSecs) ? `${Math.floor(durationSecs / 60)}:${String(durationSecs % 60).padStart(2, '0')}` : '';
    const row = (k, v) => (v ? `<tr><td style="padding:3px 14px 3px 0;color:#555;">${k}</td><td><b>${String(v).replace(/</g, '&lt;')}</b></td></tr>` : '');
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    await sendEmail({
      to: process.env.CALL_RECORDING_EMAIL_TO || 'snapflatfee2@gmail.com',
      subject: 'IVR - Completed Call Recording',
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">🎙️ Completed call recording</h2>
        <table style="font-size:14px;">
          ${row('Property', fields.Real_Address || fields.Property_Address)}
          ${row('Caller', [fields.Caller_Number, pick(fields.Caller_Type)].filter(Boolean).join(' · '))}
          ${row('Caller name', fields.Caller_Name)}
          ${row('Language', pick(fields.Language))}
          ${row('Recorded length', mins)}
          ${row('Email sent', ts + ' ET')}
        </table>
        <p>${attach ? 'The full recording (caller + seller, both sides) is attached as <b>call-recording.mp3</b>.'
          : (tooBig ? 'The recording is too large to attach — listen to it in Airtable (CALL LOG → MP3).' : 'The recording could not be attached — listen to it in Airtable (CALL LOG → MP3). An error alert was sent.')}</p>
        <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p></div>`,
      attachments: attach,
    });
    base('CALL LOG').update(logId, { 'Recording emailed': true }).catch((e) => console.error('Recording emailed flag failed:', e.message));
  } catch (err) {
    emailedRecordingSids.delete(sid);   // let a later delivery of the same recording try again
    await alertError('emailing the completed call recording', err);
  }
}

async function saveCallRecording(logId, recordingUrl, via, durationSecs) {
  if (!logId || !recordingUrl) return;
  const sid = recordingSidOf(recordingUrl);
  if (savedRecordingSids.has(sid)) return;
  savedRecordingSids.add(sid);
  console.log(`call recording ${sid} → CALL LOG ${logId} (${via})`);
  await base('CALL LOG').update(logId, { Second_Leg_Recording_URL: recordingUrl }).catch((e) => console.error('Second_Leg_Recording_URL update failed:', e.message));
  // Email and Airtable are independent: a failure in one never blocks the other.
  const [, ok] = await Promise.all([
    emailCompletedCallRecording(logId, recordingUrl, durationSecs),
    saveRecordingToAirtable(logId, recordingUrl, AT_FIELDS.callMp3, 'call-recording.mp3'),
  ]);
  if (!ok) savedRecordingSids.delete(sid); // let the next look-up retry the Airtable save
}

// Safety net: no call has ever had its recording saved by Twilio's callback (it may never fire), so
// after the seller's leg ends we also ask Twilio directly for the call's recordings, twice
// (20s and 90s later — a recording can take a moment to finish processing).
const BACKFILL_DELAYS = (process.env.RECORDING_BACKFILL_DELAYS_MS || '20000,90000').split(',').map(Number).filter(Boolean);
async function backfillCallRecordings(logId, callSids) {
  for (const callSid of callSids) {
    const recs = await twilioClient.recordings.list({ callSid, limit: 10 });
    console.log(`recording look-up: call ${callSid} has ${recs.length} recording(s)`);
    for (const r of recs) {
      if (r.status !== 'completed' || (r.source && r.source !== 'DialVerb')) continue; // skip voicemails etc.
      const url = r.mediaUrl
        ? r.mediaUrl.replace(/\.(mp3|wav)$/i, '')
        : `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${r.sid}`;
      await saveCallRecording(logId, url, 'look-up', parseInt(r.duration, 10));
    }
  }
}
function scheduleRecordingBackfill(logId, callSids) {
  const sids = [...new Set((callSids || []).filter(Boolean))];
  if (!logId || !sids.length) return;
  BACKFILL_DELAYS.forEach((ms) => setTimeout(
    () => backfillCallRecordings(logId, sids).catch((e) => console.error('recording look-up failed:', e.message)), ms).unref());
}

// Append a line to a CALL LOG record's Notes (without wiping what's there).
// Fills the plain-language columns (What happened, Outcome, Attention, Action needed, the ✓ columns) from the row.
// Safe to call any number of times: it only writes what changed, and never throws. `extra` = event-only fields to
// write along with it ('Voicemail emailed to'); `messageRecorded` overrides the derived value for a message that
// has just been recorded but is not on the row yet.
async function updateCallSummary(logId, { messageRecorded, extra } = {}) {
  if (!logId) return;
  try {
    const rec = await base('CALL LOG').find(logId);
    const diff = { ...changedFields(rec.fields || {}, summarizeCall(rec.fields || {}, { messageRecorded })), ...(extra || {}) };
    if (Object.keys(diff).length) await base('CALL LOG').update(logId, diff);
  } catch (e) { console.error('updateCallSummary failed:', e.message || e); }
}

async function appendNote(logId, text) {
  if (!logId) return;
  try {
    const rec = await base('CALL LOG').find(logId);
    const cur = rec.get('Notes') || '';
    await base('CALL LOG').update(logId, { Notes: cur ? `${cur}\n${text}` : text });
  } catch (e) { console.error('appendNote failed:', e.message); }
}

const VOICE = {
  en: { voice: process.env.VOICE_EN || 'Google.en-US-Chirp3-HD-Aoede',  language: 'en-US' },
  es: { voice: process.env.VOICE_ES || 'Google.es-US-Chirp3-HD-Zephyr', language: 'es-US' },
};

function say(twiml, lang, text) {
  twiml.say(VOICE[lang], text);
}

// Every prompt that asks a caller to leave a message must ask for the property address.
const MSG_EN = 'Please leave your name, your callback number, the property address, and your message after the tone.';
const MSG_ES = 'Por favor deje su nombre, su numero de telefono, la direccion de la propiedad y su mensaje despues del tono.';
const leaveMsg = (lang) => (lang === 'es' ? MSG_ES : MSG_EN);
const notFoundPrompt = (lang) => (lang === 'es'
  ? `Lo sentimos, no pudimos encontrar esa propiedad. Tomaremos su mensaje. ${MSG_ES} Un representante de servicio procesara su consulta a la brevedad.`
  : `I'm sorry, we couldn't find that property. We'll take your message. ${MSG_EN} A service representative will process your inquiry shortly.`);

// ─── Business Hours Check (7:00 AM – 9:00 PM Eastern, every day) ────────────
function isWithinBusinessHours() {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }));
  return etHour >= 7 && etHour < 21; // 7:00 AM through 8:59:59 PM
}
// ─── POST-CALL SENDS ─────────────────────────────────────────────────────────
// Reads CALL LOG record and fires pending SMS/email AFTER the call ends.
// Called from seller-unavailable (completed) and via /call-status callback.
const postCallSentLogIds = new Set();

// ─── CALLER TEXT (every caller gets one — changed 2026-11-10) ─────────────────
// No more "press 1 to get a text": after every call the caller gets a courtesy SMS.
//   • matched a property + was connected/offered the seller → thanks + Ref + seller contact info
//   • matched a property, never reached the seller           → thanks + Ref + "text us back"
//   • no property / no address / hung up                      → "it looks like you called but we couldn't connect"
// Plain ASCII on purpose (no accents, dashes or symbols) so each text stays in cheap GSM-7 segments.
// CALLER_SMS=off in Railway is the kill switch (stops every caller text without a deploy).
const CALLER_SMS_REPEAT_MS = 30 * 60 * 1000;   // same number + same property: one text per 30 minutes
const recentCallerSms = new Map();
const callerSmsOn = () => (process.env.CALLER_SMS || 'on').toLowerCase() !== 'off';

function callerSmsBody({ lang, listing, fullAddr, transferred }) {
  const EN_TAIL = '\n\nMsg & data rates may apply. Reply STOP to opt out.';
  const ES_TAIL = '\n\nTarifas pueden aplicar. Responda STOP para cancelar.';
  if (!listing) {
    const en = `Hi, it appears you just called the Office of Jorge Zea (Broker) but we couldn't connect or get the property address. Feel free to text us back and tell us how we can assist you.`;
    const es = `Hola, parece que llamo a la oficina de Jorge Zea (Corredor) pero no pudimos comunicarnos ni obtener la direccion de la propiedad. Envienos un texto y digenos como podemos ayudarle.`;
    return lang === 'es' ? es + ES_TAIL : lang === 'en' ? en + EN_TAIL : `${en}\n\n${es}${ES_TAIL}`;
  }
  const isRental = /rent|lease|alquil/i.test((listing.get('Type') || '').toString());
  const phone = (listing.get('Phone') || '').toString().trim();
  const email = (listing.get('Email') || '').toString().trim();
  const contactEN = [phone && `Phone: ${phone}`, email && `Email: ${email}`].filter(Boolean).join('. ');
  const partyEN = isRental ? 'Landlord' : 'Seller';
  const partyES = isRental ? 'el propietario' : 'el vendedor';
  if (lang === 'es') {
    return `Gracias por llamar a la oficina de Jorge Zea (Corredor). Ref: ${fullAddr}.` +
      (transferred && contactEN ? ` Por si no logro comunicarse con ${partyES}: ${contactEN}.` : '') +
      ` Estamos a su disposicion para cualquier pregunta, solo responda a este texto.${ES_TAIL}`;
  }
  return `Thanks for calling the Office of Jorge Zea (Broker). Ref: ${fullAddr}.` +
    (transferred && contactEN ? ` In case you couldn't connect with the ${partyEN}: ${contactEN}.` : '') +
    ` We are available to answer any questions, just text us back.${EN_TAIL}`;
}

async function sendCallerSms({ to, lang, listing, fullAddr, transferred }) {
  if (!callerSmsOn()) return false;
  if (!/^\+\d{10,15}$/.test(String(to || ''))) return false;            // blocked / anonymous callers
  if (to === process.env.TWILIO_PHONE_NUMBER) return false;
  const key = `${to}|${listing ? listing.id : 'none'}`;
  const last = recentCallerSms.get(key);
  if (last && Date.now() - last < CALLER_SMS_REPEAT_MS) { console.log(`Caller SMS skipped (already texted ${to} in the last 30 min)`); return false; }
  recentCallerSms.set(key, Date.now());
  if (recentCallerSms.size > 1000) recentCallerSms.delete(recentCallerSms.keys().next().value);
  try {
    await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body: callerSmsBody({ lang, listing, fullAddr, transferred }) });
    return true;
  } catch (e) {
    console.error('Caller SMS error:', e.message);
    recentCallerSms.delete(key);   // let a later attempt retry
    return false;
  }
}

// postCallSends(logId, { callerOnly }) — callerOnly skips the seller notification (used for the delayed
// hang-up / after-hours follow-up, where the seller was already handled by another path).
async function postCallSends(logId, { callerOnly = false } = {}) {
  if (!logId) return;
  // /seller-unavailable AND /call-status both trigger this — send once per call
  if (postCallSentLogIds.has(logId)) return;
  postCallSentLogIds.add(logId);
  setTimeout(() => postCallSentLogIds.delete(logId), 2 * 60 * 60 * 1000).unref();
  try {
    const logRecord          = await base('CALL LOG').find(logId);
    const callerNumber       = logRecord.get('Caller_Number') || '';
    const callerName         = logRecord.get('Caller_Name')   || '';
    const callerType         = logRecord.get('Caller_Type')   || 'Buyer';
    const langField          = logRecord.get('Language');
    const lang               = langField === 'Spanish' ? 'es' : langField === 'English' ? 'en' : 'both';
    // Try Listing_Link first — Airtable sometimes silently drops linked record
    // writes on create, so fall back to Prop_ID search if link is empty
    let listing = null;
    const listingLinks = logRecord.get('Listing_Link') || [];
    if (listingLinks.length) {
      listing = await base('ALL LISTINGS').find(listingLinks[0]).catch(() => null);
    }
    if (!listing) {
      const propId = (logRecord.get('Prop_ID') || '').toString().trim();
      if (propId) {
        const recs = await base('ALL LISTINGS').select({
          filterByFormula: `{UniqueID}=${airtableStr(propId)}`,
          maxRecords: 1,
          fields: ['Address','Street Address','City','State','Zip code','Type','Phone','Email','Name','SMS_Recording_Consent'],
        }).firstPage();
        if (recs.length) {
          listing = recs[0];
          console.log(`postCallSends: Listing_Link was empty — used Prop_ID fallback (${propId})`);
        } else {
          console.log(`postCallSends: no listing found for prop_id ${propId}`);
        }
      } else {
        console.log(`postCallSends: no Listing_Link or Prop_ID on logId ${logId} — caller gets the generic text, no seller notice`);
      }
    }

    const address = listing ? (listing.get('Address') || listing.get('Street Address') || '') : '';
    const city    = listing ? (listing.get('City') || '') : '';
    const state   = listing ? (listing.get('State') || '') : '';
    const zip     = listing ? (listing.get('Zip code') || '') : '';
    const fullAddr = [address, [city, state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

    // SMS to the caller — always (see CALLER TEXT above)
    if (callerNumber) {
      const sent = await sendCallerSms({ to: callerNumber, lang, listing, fullAddr, transferred: !!logRecord.get('Seller_Notified') });
      if (sent) await base('CALL LOG').update(logId, { SMS_Sent: true }).catch(console.error);
    }

    // Seller notification (email always + SMS if consent)
    if (listing && !callerOnly) {
      const sent = await notifySeller({ record: listing, callerNumber, callerName, callerType, address, city });
      const upd = { ...(sent.sms ? { Seller_SMS_Sent: true } : {}), ...(sent.email ? { 'Seller emailed': true } : {}) };
      if (Object.keys(upd).length) await base('CALL LOG').update(logId, upd).catch(console.error);
    }
    await updateCallSummary(logId);
  } catch (err) {
    console.error('postCallSends error:', err.message || err);
    postCallSentLogIds.delete(logId); // allow the /call-status backup to retry
  }
}

// A call that ended with NO CALL LOG row (caller hung up in the greeting / language / caller-type steps).
// Wait a moment (an after-hours voicemail's row is created when its transcript arrives), look again, and
// if there is still no row: log it as "Hung Up" so it is visible, and send the courtesy text.
const hangupFollowUps = new Set();
function scheduleHangupFollowUp({ callSid, from, callerName }) {
  if (!callSid || hangupFollowUps.has(callSid)) return;
  hangupFollowUps.add(callSid);
  const delay = parseInt(process.env.HANGUP_FOLLOWUP_DELAY_MS, 10) || 90000;
  setTimeout(async () => {
    try {
      const found = await base('CALL LOG').select({ filterByFormula: `{Call_ID}=${airtableStr(callSid)}`, maxRecords: 1 }).firstPage();
      let id = found.length ? found[0].id : '';
      if (!id) {
        const rec = await base('CALL LOG').create({
          Name: `Call ${new Date().toISOString()}`, Call_ID: callSid, Call_Date: new Date().toISOString(),
          Caller_Number: from || '', Caller_Type: 'Unknown', Property_Address: 'No Address',
          Call_Disposition: 'Hung Up',
          Notes: 'Caller hung up before reaching a property lookup or voicemail (no log row was created during the call). A courtesy text was sent.',
          ...(callerName ? { Caller_Name: callerName } : {}),
        });
        id = rec.id;
      }
      await postCallSends(id, { callerOnly: true });
    } catch (e) { console.error('hang-up follow-up error:', e.message || e); }
    finally { setTimeout(() => hangupFollowUps.delete(callSid), 60 * 60 * 1000).unref(); }
  }, delay).unref();
}

// ─── REALTOR TRANSFER PROMPT helper ──────────────────────────────────────────
// Shared by ALL Realtor transfer paths (showing, anything-else, post-commission)
function playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber) {
  const partyEN = isRental ? 'landlord' : 'seller';
  const partyES = isRental ? 'el propietario' : 'el vendedor';
  // No "press 1 for a text" any more — every caller is texted after the call (see CALLER TEXT above).
  say(twiml, lang, lang === 'es'
    ? `${partyES.charAt(0).toUpperCase() + partyES.slice(1)} coordina las visitas y respondera sus preguntas directamente. Le transfiero ahora mismo. Tambien le enviaremos un texto con la informacion de contacto por si no podemos comunicarle ahora.`
    : `The ${partyEN} handles showings and will answer any questions directly. Transferring your call right now. We will also text you the ${partyEN}'s contact information in case we can't connect you now.`
  );
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}&type=Realtor`);
}

// ─── FCHB SPECIAL CASE ───────────────────────────────────────────────────────
const FCHB_EMAILS = ['kevin@floridacashhomebuyers.com', 'alejandro@floridacashhomebuyers.com'];
async function handleFCHB(res, twiml, { match, lang, logId }) {
  // (Call_Disposition has no "FCHB" option in Airtable — writing one is rejected — so use Voicemail Left + a note.)
  if (logId) await base('CALL LOG').update(logId, { Call_Disposition: 'Voicemail Left' }).catch(console.error);
  appendNote(logId, 'FCHB property — routed directly to voicemail per account rule.');
  say(twiml, lang, lang === 'es'
    ? `Gracias. ${MSG_ES} Se lo haremos llegar al propietario de inmediato.`
    : `Thank you. ${MSG_EN} We will forward it to the property owner right away.`
  );
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=false&sellerEmail=${encodeURIComponent(match.email)}`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  return res.type('text/xml').send(twiml.toString());
}

// ─── AIRTABLE HEALTH CHECK ────────────────────────────────────────────────────
// Public, so it only answers yes/no — no keys, IDs, record data or error text.
// Details go to the Railway logs.
app.get('/test-airtable', async (req, res) => {
  const result = {};
  try {
    await base('ALL LISTINGS').select({ maxRecords: 1, fields: ['UniqueID'] }).firstPage();
    result.all_listings_ok = true;
  } catch (err) { result.all_listings_ok = false; console.error('test-airtable ALL LISTINGS:', err.message); }
  try {
    await base('CALL LOG').select({ maxRecords: 1, fields: ['Name'] }).firstPage();
    result.call_log_ok = true;
  } catch (err) { result.call_log_ok = false; console.error('test-airtable CALL LOG:', err.message); }
  res.json(result);
});

// ─── TWILIO CALL STATUS CALLBACK ─────────────────────────────────────────────
// Set this URL as the Status Callback on your Twilio phone number in the console:
// https://elegant-forgiveness-production-bd35.up.railway.app/call-status
// This fires post-call and ensures SMS/emails go out even if other callbacks miss.
app.post('/call-status', async (req, res) => {
  const callSid    = req.body.CallSid    || '';
  const callStatus = req.body.CallStatus || '';
  console.log(`Call ${callSid} status: ${callStatus}`);
  if (['completed','busy','no-answer','failed','canceled'].includes(callStatus)) {
    try {
      const records = await base('CALL LOG').select({
        filterByFormula: `{Call_ID}=${airtableStr(callSid)}`, maxRecords: 1,
      }).firstPage();
      if (records.length) {
        const id = records[0].id;
        const secs = parseInt(req.body.CallDuration, 10);
        if (callStatus === 'completed' && Number.isFinite(secs)) {
          base('CALL LOG').update(id, { Call_Duration_Sec: secs }).catch((e) => console.error('Call_Duration_Sec update failed:', e.message));
        }
        setImmediate(() => postCallSends(id));
        setTimeout(() => updateCallSummary(id), 4000).unref();   // after the duration + texts above have landed
      } else if (callStatus === 'completed' && !/^outbound/i.test(req.body.Direction || '')) {
        // No CALL LOG row at all: the caller hung up before a lookup/voicemail started.
        scheduleHangupFollowUp({ callSid, from: req.body.From || '', callerName: callerNameFor(callSid) });
      }
    } catch (err) { console.error('call-status error:', err.message); }
  }
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1 — INBOUND: FL two-party consent + dual-language greeting
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/inbound', (req, res) => {
  const twiml = new VoiceResponse();

  if (!isWithinBusinessHours()) {
    // After-hours: language select first, then single-language prompt
    const gather = twiml.gather({
      input: 'speech dtmf', numDigits: 1, timeout: 6, speechTimeout: 'auto',
      language: 'en-US',
      hints: 'English, Spanish, espanol, one, two, uno, dos, 1, 2',
      action: `${process.env.BASE_URL}/afterhours-lang`, method: 'POST',
    });
    gather.say(VOICE.en, 'Thank you for calling the answering service for Jorge Zea, Real Estate Broker. This call will be recorded. Press 1 for English.');
    gather.say(VOICE.es, 'Gracias por llamar al servicio de atencion automatica de Jorge Zea, Corredor de Bienes Raices. Esta llamada sera grabada. Oprima 2 para espanol.');
    twiml.redirect(`${process.env.BASE_URL}/afterhours-lang`);
    return res.type('text/xml').send(twiml.toString());
  }

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: 'en-US',
    hints: 'English, Spanish, espanol, one, two, uno, dos, 1, 2',
    action: `${process.env.BASE_URL}/select-language`, method: 'POST',
  });
  gather.say(VOICE.en,
    'Thank you for calling the answering service for Jorge Zea, Real Estate Broker. ' +
    'This call will be recorded for training and compliance. ' +
    'By staying on the line you acknowledge and agree to recording. ' +
    'Press 1 or say English for English.'
  );
  gather.say(VOICE.es,
    'Gracias por llamar al servicio de atencion automatica de Jorge Zea, Corredor de Bienes Raices. ' +
    'Esta llamada sera grabada para entrenamiento y cumplimiento. ' +
    'Al seguir en la linea usted entiende y acepta la grabacion. ' +
    'Oprima 2 o diga espanol para espanol.'
  );
  twiml.redirect(`${process.env.BASE_URL}/select-language`);
  res.type('text/xml').send(twiml.toString());
});

// ─── AFTER-HOURS LANGUAGE + VOICEMAIL ────────────────────────────────────────
app.post('/afterhours-lang', (req, res) => {
  const speech = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits = (req.body.Digits || '').trim();
  const lang   = (digits === '2' || /espa|spanish|dos|2/.test(speech)) ? 'es' : 'en';
  const twiml  = new VoiceResponse();

  say(twiml, lang, lang === 'es'
    ? 'Desafortunadamente estamos fuera de nuestro horario de atencion de 7 AM a 9 PM todos los dias. ' +
      `${MSG_ES} Le contactaremos prontamente.`
    : 'Unfortunately you reached us outside our working schedule, which is from 7 AM to 9 PM every day. ' +
      `${MSG_EN} We will get back to you shortly.`
  );
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/afterhours-transcribed?lang=${lang}`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2 — LANGUAGE → CALLER TYPE
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/select-language', (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const callSid = req.body.CallSid;
  const lang    = (digits === '2' || /espa|spanish|dos|2/.test(speech)) ? 'es' : 'en';
  const twiml   = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 7, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es'
      ? 'Realtor, agente, corredor, broker, cliente, comprador, inquilino, interesado, otro, una, dos, tres, 1, 2, 3'
      : 'Realtor, agent, broker, co-broker, customer, buyer, tenant, purchaser, prospect, interested, other, one, two, three, 1, 2, 3',
    action: `${process.env.BASE_URL}/caller-type?lang=${lang}&callSid=${callSid}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say(VOICE.es,
      'Oprima 1 o diga agente si es un profesional de bienes raices. ' +
      'Oprima 2 o diga cliente si esta interesado en una propiedad. ' +
      'Oprima 3 o diga otro para cualquier otra consulta.'
    );
  } else {
    gather.say(VOICE.en,
      'Press 1 or say agent if you are a real estate professional. ' +
      'Press 2 or say client if you are interested in a property. ' +
      'Press 3 or say other for anything else.'
    );
  }
  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_input&callSid=${callSid}`);
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3 — CALLER TYPE → ADDRESS REQUEST
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/caller-type', (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const lang    = req.query.lang || 'en';
  const callSid = req.query.callSid || req.body.CallSid;
  const twiml   = new VoiceResponse();

  // "Other" → attention voicemail
  const isOther = digits === '3' || /\b(other|otro|otra|something else|3)\b/.test(speech);
  if (isOther) {
    say(twiml, lang, lang === 'es'
      ? `${leaveMsg('es')} Le contactaremos prontamente.`
      : `${leaveMsg('en')} We will get back to you promptly.`
    );
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=&lang=${lang}&attention=true`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
    });
    return res.type('text/xml').send(twiml.toString());
  }

  // Detect caller type — broad synonyms, all map to Realtor or Buyer
  const isRealtor  = digits === '1' || /\b(realtor|agent|agente|broker|co.?broker|cobrokerage|real.?estate|licen[sc]ed|corredor|one|uno|1)\b/i.test(speech);
  const isTenant   = /\b(tenant|inquilino|rent|alquil)\b/i.test(speech);
  const callerType = isRealtor ? 'Realtor' : (isTenant ? 'Tenant' : 'Buyer');

  // Address request — recognized in the CALLER's language (Spanish callers: es-US). The recognized text is
  // normalized (suroeste → SW, avenida → Ave …) before matching against the English addresses in Airtable,
  // and if the address still can't be pinned down we fall back to the keypad (see findBestMatch).
  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 10, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es'
      ? 'calle, avenida, bulevar, camino, norte, sur, este, oeste, noroeste, suroeste, noreste, sureste, otra, dos, 2'
      : 'street, avenue, boulevard, drive, court, lane, circle, road, way, place, terrace, trail, NW, NE, SW, SE, north, south, east, west, two, other, 2',
    action: `${process.env.BASE_URL}/lookup-property?lang=${lang}&type=${callerType}&callSid=${callSid}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say(VOICE.es,
      'Por favor diga la direccion de la propiedad y la buscamos para usted. ' +
      'O presione 2 o diga otra cosa si la llamada es para algo diferente.'
    );
  } else {
    gather.say(VOICE.en,
      'Please say the property address and I will locate the information for you. ' +
      'Or press 2 or say other if this isn\'t about a property.'
    );
  }
  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_input&type=${callerType}&callSid=${callSid}&attention=true`);
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4 — AIRTABLE LOOKUP
// ═══════════════════════════════════════════════════════════════════════════════
// ─── Address matching ────────────────────────────────────────────────────────
// Speech-to-text is imperfect (and gets worse for Spanish callers), so a "close enough" fuzzy match is
// NOT trusted on its own: the house number the caller said must equal the listing's house number, the
// direction (NW/SW…) must agree, and any other street numbers (13th, 8th…) must be present. If we can't
// pin the address down, we ask for the house number on the keypad and read candidates back to the caller.
// (2026-11-09: "On to Southwest." was fuzzy-matched to an unrelated Temp Off listing and the caller was
// told it was "no longer available".)
const DIRECTIONS = { north: 'n', south: 's', east: 'e', west: 'w', northwest: 'nw', northeast: 'ne', southwest: 'sw', southeast: 'se',
                     norte: 'n', sur: 's', este: 'e', oeste: 'w', noroeste: 'nw', noreste: 'ne', suroeste: 'sw', sureste: 'se' };
const SUFFIXES = { avenue: 'ave', avenida: 'ave', av: 'ave', street: 'st', calle: 'st', drive: 'dr', boulevard: 'blvd', bulevar: 'blvd',
                   court: 'ct', corte: 'ct', lane: 'ln', road: 'rd', camino: 'rd', terrace: 'ter', terraza: 'ter', circle: 'cir',
                   circulo: 'cir', place: 'pl', trail: 'trl', highway: 'hwy', parkway: 'pkwy' };
const DROP_WORDS = new Set(['apt', 'apartment', 'apartamento', 'apto', 'unit', 'unidad', 'suite', 'ste', 'number', 'numero']);
const DIR_TOKENS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

function normalizeAddress(s) {
  let t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/[.,#]/g, ' ').replace(/\s+/g, ' ');
  t = t.replace(/\b(south|sur)\s*(west|oeste)\b/g, 'sw').replace(/\b(south|sur)\s*(east|este)\b/g, 'se')
       .replace(/\b(north|nor|norte)\s*(west|oeste)\b/g, 'nw').replace(/\b(north|nor|norte)\s*(east|este)\b/g, 'ne');
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1');
  return t.split(' ').map((w) => DIRECTIONS[w] || SUFFIXES[w] || w).filter((w) => w && !DROP_WORDS.has(w)).join(' ').trim();
}
function houseNumbers(addr) {            // "1008-1010 Habershan Ave" -> ['1008','1010']
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?/.exec(String(addr || ''));
  return m ? [m[1], m[2]].filter(Boolean) : [];
}
const isLive = (l) => /^(active|pending)$/i.test(String(l.status || '').trim());

function findBestMatch(listings, spoken) {
  const q = normalizeAddress(spoken);
  const qTokens = q.split(' ');
  const wantNum = qTokens.find((w) => /^\d{1,6}$/.test(w));
  if (!wantNum) return null;                                  // no house number heard → keypad
  const qDirs = qTokens.filter((w) => DIR_TOKENS.has(w));
  const qOtherNums = qTokens.filter((w) => /^\d+$/.test(w) && w !== wantNum);
  const pool = listings.filter((l) => {
    if (!l.nums.includes(wantNum)) return false;
    const lTokens = l.norm.split(' ');
    const lDirs = lTokens.filter((w) => DIR_TOKENS.has(w));
    if (qDirs.length && lDirs.length && qDirs.join(' ') !== lDirs.join(' ')) return false;   // SW ≠ NW
    return qOtherNums.every((n) => lTokens.includes(n));                                     // 13th must be there
  });
  if (!pool.length) return null;
  // Compare only "house number + the next few words": filler before ("yes it's …") or after ("…please") is noise.
  const core = qTokens.slice(qTokens.indexOf(wantNum), qTokens.indexOf(wantNum) + 8).join(' ');
  const results = new Fuse(pool, { keys: ['norm', 'normFull'], threshold: 0.45, includeScore: true, ignoreLocation: true }).search(core);
  if (!results.length) return null;
  const best = results[0].score;
  const near = results.filter((r) => r.score <= best + 0.05).map((r) => r.item);   // same property listed more than once
  return near.find(isLive) || near[0];
}

// For free-form messages (after-hours voicemail transcripts): try each number in the text as a possible
// house number, using the words after it as the street. Same strict checks as findBestMatch.
function findMatchInText(listings, text) {
  const words = normalizeAddress(text).split(' ');
  for (let i = 0; i < words.length; i++) {
    if (!/^\d{1,6}$/.test(words[i])) continue;
    const m = findBestMatch(listings, words.slice(i, i + 7).join(' '));
    if (m) return m;
  }
  return null;
}

// ─── Fetch + shape all listings ─────────────────────────────────────────────
// Started as soon as the caller finishes speaking so the Airtable round-trip overlaps the
// "one moment" prompt / hold music.
const listingsCache = new Map(); // callSid -> { done, promise }
function fetchListings() {
  return base('ALL LISTINGS').select({
    fields: ['Address','Street Address','City','State','Zip code','Name','Phone','Email',
             'Commission NOTES','Type','List Price','Notes','UniqueID','Status','SMS_Recording_Consent'],
  }).all().then(records => records.map(r => {
    const address     = r.get('Address') || r.get('Street Address') || '';
    const fullAddress = [address, r.get('City'), r.get('State'), r.get('Zip code')].filter(Boolean).join(', ');
    return {
      id: r.id, prop_id: r.get('UniqueID') || '',
      address, city: r.get('City') || '', fullAddress,
      name: r.get('Name') || '', phone: r.get('Phone') || '', email: r.get('Email') || '',
      commNotes: r.get('Commission NOTES') || '',
      type: r.get('Type') || '', price: r.get('List Price') || '', notes: r.get('Notes') || '',
      status: (r.get('Status') || '').toString(),
      norm: normalizeAddress(address), normFull: normalizeAddress(fullAddress), nums: houseNumbers(address),
    };
  }));
}
async function getListings(callSid) {
  const pending = listingsCache.get(callSid)?.promise || fetchListings();
  // Cap the wait at 8s → falls to /universal-fallback rather than a Twilio timeout drop
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('listings lookup timed out')), 8000).unref());
  return Promise.race([pending, timeout]);
}

// ─── Shared call-log + voicemail endings for the lookup ─────────────────────
const lookupQS = (o) => new URLSearchParams(o).toString();
async function createLookupLog({ callSid, callerNumber, callerType, lang, spoken, extraNotes, fields }) {
  try {
    const rec = await base('CALL LOG').create({
      Name: `Call ${new Date().toISOString()}`, Call_ID: callSid,
      Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
      Caller_Type: callerType, Language: lang === 'es' ? 'Spanish' : 'English',
      Property_Address: spoken,
      Notes: `Caller consented to recording by continuing on the line (FL two-party notice at greeting).${extraNotes ? ` ${extraNotes}` : ''}`,
      ...(callerNameFor(callSid) ? { Caller_Name: callerNameFor(callSid) } : {}),
      ...fields,
    });
    return rec.id;
  } catch (logErr) {
    console.error('CALL LOG create (non-fatal):', logErr.message || logErr);   // never blocks the call
    return '';
  }
}

// "We couldn't find that property" — used when there is no match, the match is not Active/Pending,
// or the caller rejected every keypad candidate. Always asks for the property address.
async function finishNotFound(res, { lang, callerType, callSid, callerNumber, spoken, reason }) {
  const logId = await createLookupLog({
    callSid, callerNumber, callerType, lang, spoken: spoken || '(not recognized)', extraNotes: reason,
    fields: { Call_Disposition: 'No Match Found' },
  });
  const twiml = new VoiceResponse();
  say(twiml, lang, notFoundPrompt(lang));
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  return res.type('text/xml').send(twiml.toString());
}

// A confirmed, Active/Pending property: log it and continue into the Realtor / Buyer flow.
async function startWithMatch(res, { match, spoken, lang, callerType, callSid, callerNumber, via }) {
  const twiml = new VoiceResponse();
  const fields = {
    Real_Address: match.fullAddress, Prop_ID: match.prop_id,
    Listing_Link: [match.id],  // Airtable JS client expects string IDs, not objects
  };
  const logId = await createLookupLog({ callSid, callerNumber, callerType, lang, spoken, extraNotes: via, fields });
  if (callerType === 'Realtor') return realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId });
  return buyerTenantFlow(res, twiml, { match, lang, callerNumber, callerType, callSid, logId });
}

// ─── Front door: acknowledge, start the lookup in the background, play hold audio ──
app.post('/lookup-property', (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const spoken  = (req.body.SpeechResult || '').trim();
  const lang    = req.query.lang || 'en';
  const callerType = req.query.type || 'Buyer';
  const callSid = req.query.callSid || req.body.CallSid;

  // "Something else" / nothing heard → skip the hold, handleLookup decides
  if (!spoken || digits === '2' || /\b(something else|other|otro|otra|2)\b/.test(speech)) {
    return handleLookup(req, res);
  }

  const entry = { done: false, promise: fetchListings() };
  entry.promise.then(() => { entry.done = true; }, () => { entry.done = true; });
  listingsCache.set(callSid, entry);
  setTimeout(() => listingsCache.delete(callSid), 10 * 60 * 1000).unref();

  const twiml = new VoiceResponse();
  say(twiml, lang, lang === 'es'
    ? 'Gracias. Un momento mientras busco esa propiedad.'
    : 'Thank you. One moment while I look that up.');
  if (process.env.HOLD_MUSIC_URL) twiml.play(process.env.HOLD_MUSIC_URL);
  twiml.redirect(`${process.env.BASE_URL}/lookup-property-run?lang=${lang}&type=${encodeURIComponent(callerType)}&callSid=${callSid}&spoken=${encodeURIComponent(spoken)}`);
  res.type('text/xml').send(twiml.toString());
});

app.post('/lookup-property-run', (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const attempt = parseInt(req.query.attempt || '0', 10);
  const entry   = listingsCache.get(callSid);
  // Search still running after the first hold → hold again (max 2 extra rounds) instead of dead air
  if (entry && !entry.done && attempt < 2) {
    const twiml = new VoiceResponse();
    if (process.env.HOLD_MUSIC_URL) twiml.play(process.env.HOLD_MUSIC_URL);
    else say(twiml, req.query.lang || 'en', (req.query.lang === 'es') ? 'Un momento mas.' : 'Just a moment more.');
    const qs = new URLSearchParams({ ...req.query, attempt: String(attempt + 1) }).toString();
    twiml.redirect(`${process.env.BASE_URL}/lookup-property-run?${qs}`);
    return res.type('text/xml').send(twiml.toString());
  }
  req.body.SpeechResult = req.query.spoken || '';
  req.body.Digits = '';
  return handleLookup(req, res);
});

async function handleLookup(req, res) {
  const speech        = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits        = (req.body.Digits || '').trim();
  const spokenAddress = (req.body.SpeechResult || '').trim();
  const lang          = req.query.lang || 'en';
  const callerType    = req.query.type || 'Buyer';
  const callSid       = req.query.callSid || req.body.CallSid;
  const callerNumber  = req.body.From || '';
  const twiml         = new VoiceResponse();

  // Press 2 / "something else" → attention voicemail
  const isSomethingElse = digits === '2' || /\b(something else|other|otro|otra|2)\b/.test(speech);
  if (isSomethingElse) {
    say(twiml, lang, lang === 'es'
      ? `${leaveMsg('es')} Le contactaremos prontamente.`
      : `${leaveMsg('en')} We will get back to you promptly.`
    );
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=&lang=${lang}&attention=true`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
    });
    return res.type('text/xml').send(twiml.toString());
  }

  // Nothing recognized (common when speech-to-text fails) → ask for the house number on the keypad
  if (!spokenAddress) {
    twiml.redirect(`${process.env.BASE_URL}/lookup-keypad?${lookupQS({ lang, type: callerType, callSid, spoken: '' })}`);
    return res.type('text/xml').send(twiml.toString());
  }

  try {
    const listings = await getListings(callSid);
    const match    = findBestMatch(listings, spokenAddress);

    if (!match) {   // couldn't pin the address down → keypad
      twiml.redirect(`${process.env.BASE_URL}/lookup-keypad?${lookupQS({ lang, type: callerType, callSid, spoken: spokenAddress })}`);
      return res.type('text/xml').send(twiml.toString());
    }
    if (!isLive(match)) {   // anything other than Active/Pending: don't say "no longer available", just "couldn't find it"
      return finishNotFound(res, { lang, callerType, callSid, callerNumber, spoken: spokenAddress,
        reason: `Matched ${match.fullAddress} but its Status is "${match.status || 'blank'}" — caller was told we couldn't find the property.` });
    }
    return startWithMatch(res, { match, spoken: spokenAddress, lang, callerType, callSid, callerNumber });
  } catch (err) {
    console.error('Lookup error — message:', err.message, '| statusCode:', err.statusCode);
    console.error('Env check — API_KEY set:', !!process.env.AIRTABLE_API_KEY, '| BASE_ID:', process.env.AIRTABLE_BASE_ID);
    twiml.redirect(`${process.env.BASE_URL}/universal-fallback?lang=${lang}&logId=&callSid=${callSid}`);
    res.type('text/xml').send(twiml.toString());
  }
}

// ─── Keypad fallback: house number → read candidates back → yes (1) / no (2) ───────────────────────
app.post('/lookup-keypad', (req, res) => {
  const lang = req.query.lang || 'en';
  const qs   = lookupQS({ lang, type: req.query.type || 'Buyer', callSid: req.query.callSid || req.body.CallSid, spoken: req.query.spoken || '' });
  const twiml  = new VoiceResponse();
  const gather = twiml.gather({
    input: 'dtmf', finishOnKey: '#', timeout: 10,
    action: `${process.env.BASE_URL}/lookup-number?${qs}`, method: 'POST',
  });
  gather.say(VOICE[lang], lang === 'es'
    ? 'No pude encontrar esa direccion. Por favor use el teclado para marcar la parte numerica de la direccion, el numero de la casa, y luego oprima la tecla de numeral.'
    : 'I couldn\'t find that address. Please use your keypad to enter the numeric portion of the address, the house number, and then press pound.'
  );
  twiml.redirect(`${process.env.BASE_URL}/lookup-number?${qs}`);   // nothing keyed
  res.type('text/xml').send(twiml.toString());
});

const keypadCandidates = (listings, digits) => listings
  .filter((l) => isLive(l) && l.nums.includes(digits))
  .sort((a, b) => (/^active$/i.test(b.status) - /^active$/i.test(a.status)) || a.address.localeCompare(b.address))
  .slice(0, 4);
const spokenListing = (l) => {
  const addr = speakableAddress(l.address);
  return l.city && !addr.toLowerCase().includes(l.city.toLowerCase()) ? `${addr}, ${l.city}` : addr;
};

app.post('/lookup-number', async (req, res) => {
  const lang = req.query.lang || 'en';
  const callerType = req.query.type || 'Buyer';
  const callSid = req.query.callSid || req.body.CallSid;
  const callerNumber = req.body.From || '';
  const spoken = req.query.spoken || '';
  const digits = (req.body.Digits || '').replace(/\D/g, '');
  const twiml  = new VoiceResponse();
  const ctx = { lang, callerType, callSid, callerNumber, spoken };
  try {
    if (!digits) return finishNotFound(res, { ...ctx, reason: 'Address not recognized and no house number was keyed.' });
    const cands = keypadCandidates(await getListings(callSid), digits);
    if (!cands.length) return finishNotFound(res, { ...ctx, spoken: spoken || `(keypad) ${digits}`, reason: `Caller keyed house number ${digits}; no Active/Pending listing has that number.` });
    twiml.redirect(`${process.env.BASE_URL}/lookup-confirm?${lookupQS({ lang, type: callerType, callSid, spoken, digits, idx: '0' })}`);
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('lookup-number error:', err.message);
    twiml.redirect(`${process.env.BASE_URL}/universal-fallback?lang=${lang}&logId=&callSid=${callSid}`);
    return res.type('text/xml').send(twiml.toString());
  }
});

app.post('/lookup-confirm', async (req, res) => {
  const lang = req.query.lang || 'en';
  const callerType = req.query.type || 'Buyer';
  const callSid = req.query.callSid || req.body.CallSid;
  const spoken = req.query.spoken || '';
  const digits = req.query.digits || '';
  const idx    = parseInt(req.query.idx || '0', 10);
  const twiml  = new VoiceResponse();
  try {
    const cands = keypadCandidates(await getListings(callSid), digits);
    if (idx >= cands.length) {
      return finishNotFound(res, { lang, callerType, callSid, callerNumber: req.body.From || '', spoken: spoken || `(keypad) ${digits}`,
        reason: `Caller keyed house number ${digits}; none of the ${cands.length} suggested properties was confirmed.` });
    }
    const qs = lookupQS({ lang, type: callerType, callSid, spoken, digits, idx: String(idx) });
    const gather = twiml.gather({
      input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto', language: VOICE[lang].language,
      hints: lang === 'es' ? 'si, no, uno, dos, 1, 2' : 'yes, no, one, two, 1, 2',
      action: `${process.env.BASE_URL}/lookup-confirm-answer?${qs}`, method: 'POST',
    });
    gather.say(VOICE[lang], lang === 'es'
      ? `Es esta la propiedad: ${spokenListing(cands[idx])}? Oprima 1 para si, o 2 para no.`
      : `Is this the property: ${spokenListing(cands[idx])}? Press 1 for yes, or press 2 for no.`
    );
    twiml.redirect(`${process.env.BASE_URL}/lookup-confirm-answer?${qs}&silent=1`);   // no answer = no
    return res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('lookup-confirm error:', err.message);
    twiml.redirect(`${process.env.BASE_URL}/universal-fallback?lang=${lang}&logId=&callSid=${callSid}`);
    return res.type('text/xml').send(twiml.toString());
  }
});

app.post('/lookup-confirm-answer', async (req, res) => {
  const lang = req.query.lang || 'en';
  const callerType = req.query.type || 'Buyer';
  const callSid = req.query.callSid || req.body.CallSid;
  const spoken = req.query.spoken || '';
  const digits = req.query.digits || '';
  const idx    = parseInt(req.query.idx || '0', 10);
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const key    = (req.body.Digits || '').trim();
  const twiml  = new VoiceResponse();
  const yes = key === '1' || /\b(yes|yeah|yep|si|sí|uno|one)\b/.test(speech);
  const no  = key === '2' || /\b(no|nope|dos|two)\b/.test(speech) || req.query.silent === '1';
  const next = (n) => { twiml.redirect(`${process.env.BASE_URL}/lookup-confirm?${lookupQS({ lang, type: callerType, callSid, spoken, digits, idx: String(n) })}`); return res.type('text/xml').send(twiml.toString()); };
  try {
    if (!yes && !no) return next(idx);       // some other key → ask again
    if (no) return next(idx + 1);            // next candidate, or "couldn't find it" when out of candidates
    const match = keypadCandidates(await getListings(callSid), digits)[idx];
    if (!match) return next(idx);
    return startWithMatch(res, { match, spoken: spoken || `(keypad) ${digits}`, lang, callerType, callSid, callerNumber: req.body.From || '',
      via: `Address confirmed by caller on the keypad (house number ${digits}).` });
  } catch (err) {
    console.error('lookup-confirm-answer error:', err.message);
    twiml.redirect(`${process.env.BASE_URL}/universal-fallback?lang=${lang}&logId=&callSid=${callSid}`);
    return res.type('text/xml').send(twiml.toString());
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4A — REALTOR FLOW
// ═══════════════════════════════════════════════════════════════════════════════
// Expand abbreviations so TTS reads "1198 SW 13th Ave" as words, not letters
function speakableAddress(a) {
  const dirs = { nw: 'northwest', ne: 'northeast', sw: 'southwest', se: 'southeast' };
  const sfx  = { ave: 'Avenue', st: 'Street', dr: 'Drive', blvd: 'Boulevard', ct: 'Court', ln: 'Lane',
                 rd: 'Road', ter: 'Terrace', cir: 'Circle', pl: 'Place' };
  return (a || '')
    .replace(/,?\s*\b\d{5}(-\d{4})?\s*$/, '')   // a ZIP code read aloud is "thirty-three thousand…"
    .replace(/\b(nw|ne|sw|se)\b\.?/gi, m => dirs[m.replace('.', '').toLowerCase()])
    .replace(/\b(ave|st|dr|blvd|ct|ln|rd|ter|cir|pl)\b\.?$/i, m => sfx[m.replace('.', '').toLowerCase()]);
}

function realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId }) {
  if (FCHB_EMAILS.includes((match.email || '').toLowerCase())) {
    return handleFCHB(res, twiml, { match, lang, logId });
  }
  const isRental = /rent|lease|alquil/i.test(match.type || '');
  say(twiml, lang, lang === 'es'
    ? `Perfecto, encontre ${speakableAddress(match.address)}.`
    : `Great, I found ${speakableAddress(match.address)}.`);

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es'
      ? 'visita, mostrar, uno, dos, otra, informacion, comision, 1, 2'
      : 'showing, show, schedule, tour, one, two, other, something else, information, commission, 1, 2',
    action: `${process.env.BASE_URL}/realtor-branch?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&callerNumber=${encodeURIComponent(callerNumber)}&isRental=${isRental}`,
    method: 'POST',
  });

  gather.say(VOICE[lang], lang === 'es'
    ? 'Oprima 1 o diga visita para programar una visita. Oprima 2 o diga otra cosa si necesita informacion adicional antes de programar.'
    : 'Press 1 or say showing to schedule a showing. Press 2 or say something else if you need additional information before scheduling.'
  );

  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=realtor_timeout&attention=true`);
  res.type('text/xml').send(twiml.toString());
}

// ─── REALTOR BRANCH ───────────────────────────────────────────────────────────
app.post('/realtor-branch', (req, res) => {
  const speech       = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits       = (req.body.Digits || '').trim();
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId;
  const matchId      = req.query.matchId;
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');
  const isRental     = req.query.isRental === 'true';
  const twiml        = new VoiceResponse();

  const wantsShow  = digits === '1' || /\b(show|showing|schedule|visit|tour|see|appointment|disponib|visita|mostrar|agendar|ver|si\b|yes|one|uno|1)\b/i.test(speech);
  const wantsOther = digits === '2' || /\b(other|something else|info|question|commission|compensation|otro|otra|informacion|comision|dos|two|2)\b/i.test(speech);

  if (wantsOther && !wantsShow) {
    // Ask what they need
    const gather = twiml.gather({
      input: 'speech', timeout: 10, speechTimeout: 'auto',
      language: VOICE[lang].language,
      hints: lang === 'es'
        ? 'comision, compensacion, honorarios, precio, disponible, informacion, cuanto'
        : 'commission, compensation, fee, BAC, buyer agent, price, details, how much, what do you offer',
      action: `${process.env.BASE_URL}/realtor-question?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&isRental=${isRental}`,
      method: 'POST',
    });
    gather.say(VOICE[lang], lang === 'es'
      ? 'Claro, con mucho gusto. Que informacion adicional necesita?'
      : 'Sure, I am happy to help. What additional information can I help you with?'
    );
    // Timeout → voicemail
    twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=realtor_question_timeout&attention=true`);
  } else {
    // Press 1, showing keywords, or default → transfer prompt
    playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber);
  }
  res.type('text/xml').send(twiml.toString());
});

// ─── REALTOR QUESTION (handles "something else" speech) ──────────────────────
app.post('/realtor-question', async (req, res) => {
  const speech       = (req.body.SpeechResult || '').trim();
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId;
  const matchId      = req.query.matchId;
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');
  const isRental     = req.query.isRental === 'true';
  const twiml        = new VoiceResponse();

  const isCommission = /commission|compensation|co.?broke|cobroke|cobrokerage|co.?brokerage|\bbac\b|buyer.?agent|fee|how much|what.*offer|what.*pay|cuanto|comision|compensacion|honorarios|pagan|ofrecen/i.test(speech);

  if (isCommission) {
    const scriptEN =
      'There is no blanket advance offer of compensation for this property. ' +
      'You will need to be compensated by your buyer as per your buyer-broker agreement. ' +
      'However, after showing the property, when preparing an offer, this can always be negotiated, ' +
      'and the seller might help your buyer pay your compensation depending on all terms of the offer and the net proceeds to the seller. ' +
      'Press 1 or say showing to schedule a showing. Press 2 or say message to leave a message for the broker.';

    const scriptES =
      'No hay una oferta anticipada de compensacion para esta propiedad. ' +
      'Usted debera ser compensado por su comprador segun su acuerdo de representacion. ' +
      'Sin embargo, al presentar una oferta, esto siempre puede negociarse, ' +
      'y el vendedor podria ayudar a su comprador a pagar su compensacion segun los terminos y las ganancias netas del vendedor. ' +
      'Oprima 1 o diga visita para programar una visita. Oprima 2 o diga mensaje para dejar un mensaje para el corredor.';

    // Played when the realtor leaves a message instead of scheduling a showing —
    // invites open feedback on the commission policy specifically, since that's
    // the context (Sherman Act evidence layer, see README). Recorded + routed to
    // snapflatfee2 ONLY, never the seller (see branch=commission below).
    const messagePromptEN =
      'Please leave a detailed message after the tone, including the property address. We value feedback from all our cooperating agents, ' +
      'including any comments about our commission policy, and will make sure it reaches the broker directly.';
    const messagePromptES =
      'Por favor deje un mensaje detallado despues del tono, incluyendo la direccion de la propiedad. Valoramos los comentarios de todos nuestros agentes cooperantes, ' +
      'incluyendo cualquier comentario sobre nuestra politica de comisiones, y nos aseguraremos de que llegue directamente al corredor.';

    // Steering evidence: we never offer compensation — the fixed policy message is played. BAC_Disclosed records that
    // it WAS played (the listing's "BAC Offered" value is deliberately never read or spoken).
    await base('CALL LOG').update(logId, { Transcript: `Realtor asked about commission. Response played.`, BAC_Disclosed: 'No offer - policy message played' }).catch(console.error);

    const gather = twiml.gather({
      input: 'speech dtmf', numDigits: 1, timeout: 6, speechTimeout: 'auto',
      language: VOICE[lang].language,
      hints: lang === 'es'
        ? 'visita, uno, 1, mostrar, si, mensaje, dos, 2'
        : 'showing, show, one, 1, schedule, yes, message, two, 2',
      action: `${process.env.BASE_URL}/realtor-commission-choice?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&isRental=${isRental}`,
      method: 'POST',
    });
    gather.say(VOICE[lang], lang === 'es' ? scriptES : scriptEN);

    // 6 sec timeout with no input → voicemail → snapflatfee2 ONLY (not seller — may contain complaints)
    say(twiml, lang, lang === 'es' ? messagePromptES : messagePromptEN);
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true&branch=commission`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
    });
  } else if (speech) {
    // Non-commission question → transfer to seller (seller will answer directly)
    await base('CALL LOG').update(logId, {
      Transcript: `Realtor question: "${speech}" — routed to seller.`,
    }).catch(console.error);
    playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber);
  } else {
    // No speech → voicemail
    twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=no_question&attention=true`);
  }
  res.type('text/xml').send(twiml.toString());
});

// ─── REALTOR COMMISSION CHOICE (after commission script, 6s timeout) ──────────
app.post('/realtor-commission-choice', (req, res) => {
  const speech       = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits       = (req.body.Digits || '').trim();
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId;
  const matchId      = req.query.matchId;
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');
  const isRental     = req.query.isRental === 'true';
  const twiml        = new VoiceResponse();

  const wantsShow = digits === '1' || /\b(show|showing|schedule|visita|mostrar|si\b|yes|one|uno|1)\b/i.test(speech);
  // For steering analysis: what did the Realtor do right after hearing the compensation policy message?
  appendNote(logId, `After the commission policy message the Realtor chose: ${wantsShow ? 'to schedule a showing' : (digits || speech) ? 'to leave a message for the broker' : 'nothing (no answer; sent to leave a message)'}.`);

  if (wantsShow) {
    playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber);
  } else {
    // Explicit "message" choice, or anything else recognized as speech/digits that
    // wasn't "showing" → voicemail → snapflatfee2 ONLY (not seller — may contain complaints)
    say(twiml, lang, lang === 'es'
      ? 'Por favor deje un mensaje detallado despues del tono, incluyendo la direccion de la propiedad. Valoramos los comentarios de todos nuestros agentes cooperantes, incluyendo cualquier comentario sobre nuestra politica de comisiones, y nos aseguraremos de que llegue directamente al corredor.'
      : 'Please leave a detailed message after the tone, including the property address. We value feedback from all our cooperating agents, including any comments about our commission policy, and will make sure it reaches the broker directly.'
    );
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true&branch=commission`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
    });
  }
  res.type('text/xml').send(twiml.toString());
});

// ─── FLAG SMS — caller opts in to receive contact info ───────────────────────
// Flags Caller_SMS_Requested in CALL LOG. SMS fires post-call via postCallSends.
app.post('/flag-sms', async (req, res) => {
  const speech       = (req.body.SpeechResult || '').toLowerCase();
  const digits       = (req.body.Digits || '').trim();
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId;
  const matchId      = decodeURIComponent(req.query.matchId || '');
  const twiml        = new VoiceResponse();

  // (No longer asked since 2026-11-10 — callers are always texted. Route kept for calls that were already
  //  mid-flow during the deploy; it just goes on to the transfer.)
  // Always proceed to transfer
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}&type=${encodeURIComponent(req.query.type || 'Buyer')}`);
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4B — BUYER / TENANT FLOW
// ═══════════════════════════════════════════════════════════════════════════════
function buyerTenantFlow(res, twiml, { match, lang, callerNumber, callerType, callSid, logId }) {
  if (FCHB_EMAILS.includes((match.email || '').toLowerCase())) {
    return handleFCHB(res, twiml, { match, lang, logId });
  }
  const isRental = /rent|lease|alquil/i.test(match.type || '');
  const partyEN  = isRental ? 'landlord' : 'seller';
  const partyES  = isRental ? 'el propietario' : 'el vendedor';
  say(twiml, lang, lang === 'es'
    ? `Perfecto, encontre ${speakableAddress(match.address)}.`
    : `Great, I found ${speakableAddress(match.address)}.`);

  // No "press 1 for a text" any more — every caller is texted after the call (see CALLER TEXT above).
  say(twiml, lang, lang === 'es'
    ? `${partyES.charAt(0).toUpperCase() + partyES.slice(1)} coordina las visitas directamente, le transfiero ahora mismo. Tambien le enviaremos un texto con los datos de contacto por si no podemos comunicarle ahora.`
    : `The ${partyEN} is handling showings directly. I will transfer your call right now. We will also text you the ${partyEN}'s contact information in case we can't connect you now.`
  );
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(match.id)}&logId=${logId}&type=${encodeURIComponent(callerType)}`);
  res.type('text/xml').send(twiml.toString());
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5 — TRANSFER TO SELLER (leg 2, dual-channel recording)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/transfer-seller', async (req, res) => {
  const lang    = req.query.lang || 'en';
  const matchId = decodeURIComponent(req.query.matchId || '');
  const logId   = req.query.logId;
  const twiml   = new VoiceResponse();

  try {
    const r           = await base('ALL LISTINGS').find(matchId);
    const sellerPhone = r.get('Phone') || '';
    const sellerEmail = r.get('Email') || '';
    const listingType = (r.get('Type') || '').toLowerCase();
    const isRental    = /rent|lease/.test(listingType);

    if (!sellerPhone) {
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_seller_phone&lang=${lang}&logId=${logId}`);
    } else {
      const partyEN = isRental ? 'the landlord' : 'the seller';
      const partyES = isRental ? 'el propietario' : 'el vendedor';
      say(twiml, lang, lang === 'es'
        ? `Le transferimos con ${partyES}. Si ${partyES} no contesta, puede dejar un mensaje en su buzon de voz despues del tono. Por favor mencione la direccion de la propiedad en su mensaje. Un momento por favor.`
        : `We are connecting you with ${partyEN} now. If ${partyEN} doesn't answer, you can leave a message on their voicemail after the tone. Please mention the property address in your message. One moment please.`
      );

      // Plain forward — no whisper/screening. If the seller's own voicemail picks up, the caller is
      // connected to it and leaves the message there (the call is recorded either way).
      // timeout: how long we let the seller's phone ring before giving up. It must be longer than the
      // seller's carrier takes to send a call to voicemail (usually 20-30s) or the caller never reaches it.
      // callerId: by default the seller's phone shows the ORIGINAL CALLER's number (Twilio's default for <Dial>),
      // so the seller can call back from the missed-call/voicemail entry. Set SELLER_CALLER_ID=twilio in
      // Railway to show SnapFlatFee's number instead.
      const ringSeconds = Math.min(120, Math.max(15, parseInt(process.env.SELLER_RING_SECONDS, 10) || 40));
      const showTwilioId = (process.env.SELLER_CALLER_ID || 'caller').toLowerCase() === 'twilio';
      const dial = twiml.dial({
        // MUST be one of Twilio's valid values: record-from-answer | record-from-ringing | record-from-answer-dual |
        // record-from-ringing-dual. The old value 'record-from-answer-dual-channel' is not valid; Twilio silently
        // ignored it, so seller calls were NEVER recorded until this was fixed on 2026-11-09.
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${process.env.BASE_URL}/second-leg-recording?logId=${logId}`,
        recordingStatusCallbackMethod: 'POST',
        action: `${process.env.BASE_URL}/seller-unavailable?lang=${lang}&logId=${logId}&sellerEmail=${encodeURIComponent(sellerEmail)}`,
        method: 'POST',
        timeout: ringSeconds,
        ...(showTwilioId && process.env.TWILIO_PHONE_NUMBER ? { callerId: process.env.TWILIO_PHONE_NUMBER } : {}),
      });
      dial.number({
        statusCallback: `${process.env.BASE_URL}/seller-status?logId=${logId}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: 'answered completed',
      }, sellerPhone);

      await base('CALL LOG').update(logId, {
        Call_Disposition: 'Transferred to Seller', Seller_Notified: true,
      }).catch(console.error);
    }
  } catch (err) {
    console.error('transfer-seller error:', err.message);
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=transfer_error&lang=${lang}&logId=${logId}`);
  }
  res.type('text/xml').send(twiml.toString());
});

// (Removed: /seller-whisper and /seller-consent — the seller is no longer screened with a press-1 prompt.
//  The call is forwarded straight to the seller's phone or their own voicemail. See /transfer-seller.)

// ─── SECOND LEG RECORDING ─────────────────────────────────────────────────────
app.post('/second-leg-recording', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || '';
  const logId        = req.query.logId || '';
  console.log(`second-leg-recording webhook: status=${req.body.RecordingStatus || '?'} duration=${req.body.RecordingDuration || '?'}s logId=${logId || '(none)'}`);
  res.sendStatus(200); // ack Twilio immediately; the save below can take a moment
  // Full call recording (not a 120s-capped voicemail): saved into the CALL LOG "MP3" field via a
  // short-lived link, so there is no file-size limit. Not emailed.
  await saveCallRecording(logId, recordingUrl, 'webhook', parseInt(req.body.RecordingDuration, 10));
});

// ─── SELLER STATUS ────────────────────────────────────────────────────────────
app.post('/seller-status', async (req, res) => {
  const callStatus = req.body.CallStatus || '';
  const logId      = req.query.logId || '';
  if (logId) {
    const answered = callStatus === 'completed' || callStatus === 'answered';
    await base('CALL LOG').update(logId, { Seller_Accepted_Call: answered }).catch(console.error);
    // The seller's leg is over: make sure its recording ends up in the "MP3" field even if Twilio's
    // own recording callback never arrives (see backfillCallRecordings).
    if (callStatus === 'completed') scheduleRecordingBackfill(logId, [req.body.ParentCallSid, req.body.CallSid]);
  }
  res.sendStatus(200);
});

// ─── SELLER UNAVAILABLE ───────────────────────────────────────────────────────
// Fires when <Dial> ends. A call that lasted >= 20s is either a live conversation OR the caller leaving a
// message on the seller's own voicemail (we can't tell which without screening) — either way nothing more to do.
// Anything shorter or unanswered means nobody took the call, so we offer our own voicemail.
app.post('/seller-unavailable', async (req, res) => {
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId || '';
  const sellerEmail  = req.query.sellerEmail || '';
  const sellerQS     = `&sellerEmail=${encodeURIComponent(sellerEmail)}&branch=seller`;
  const dialStatus   = req.body.DialCallStatus || '';
  const dialDuration = parseInt(req.body.DialCallDuration || '0', 10);
  const twiml        = new VoiceResponse();

  // Completed call (≥20s: live talk or a message left on the seller's voicemail) → silent hangup, recording saves async
  if (dialStatus === 'completed' && dialDuration >= 20) {
    // (No disposition write here: "Completed" isn't one of Airtable's Call_Disposition options, so it was always
    //  rejected. The row already says "Transferred to Seller"; Call_Duration_Sec is filled in by /call-status.)
    if (logId) setImmediate(() => postCallSends(logId)); // fire SMS/email after response
    return res.type('text/xml').send('<Response><Hangup/></Response>');
  }

  // No-answer / busy / failed / short completed (seller hung up, or their voicemail cut off) → our own voicemail
  if (logId) {
    // "Seller Unavailable (…)" isn't an Airtable option either; "Transferred to Voicemail" is, and the detail goes in Notes.
    await base('CALL LOG').update(logId, { Call_Disposition: 'Transferred to Voicemail', Seller_Accepted_Call: false }).catch(console.error);
    appendNote(logId, `Seller leg ended: ${dialStatus || 'unknown'} after ${dialDuration}s — caller offered our voicemail.`);
    setImmediate(() => postCallSends(logId)); // caller still gets their SMS
  }

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es' ? 'mensaje, uno, 1' : 'message, one, 1',
    action: `${process.env.BASE_URL}/unavailable-choice?lang=${lang}&logId=${logId}${sellerQS}`,
    method: 'POST',
  });
  if (lang === 'es') {
    gather.say(VOICE.es,
      'El vendedor no esta disponible en este momento. ' +
      'Oprima 1 o diga mensaje para dejar un mensaje que le haremos llegar directamente al vendedor. ' +
      'O simplemente cuelgue y contacte al vendedor con la informacion que le enviamos por texto.'
    );
  } else {
    gather.say(VOICE.en,
      'The seller is not available right now. ' +
      'Press 1 or say message to leave a message we will forward directly to the seller. ' +
      'Or simply hang up and contact the seller using the information we texted you.'
    );
  }
  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=seller_unavailable${sellerQS}`);
  res.type('text/xml').send(twiml.toString());
});

// ─── UNAVAILABLE CHOICE ───────────────────────────────────────────────────────
app.post('/unavailable-choice', (req, res) => {
  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const lang   = req.query.lang || 'en';
  const logId  = req.query.logId || '';
  const sellerQS = `&sellerEmail=${encodeURIComponent(req.query.sellerEmail || '')}&branch=seller`;
  const twiml  = new VoiceResponse();
  const wantsMsg = digits === '1' || /\b(one|uno|message|mensaje|1)\b/.test(speech);

  if (wantsMsg) {
    twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=seller_unavailable${sellerQS}`);
  } else {
    say(twiml, lang, lang === 'es'
      ? 'Tiene toda la informacion en su telefono. Que tenga un buen dia.'
      : 'You have all the information on your phone. Have a great day.'
    );
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
// VOICEMAIL
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/voicemail', async (req, res) => {
  const lang         = req.query.lang || 'en';
  const matchAddress = decodeURIComponent(req.query.matchAddress || '');
  let   logId        = req.query.logId || '';
  const attention    = req.query.attention || 'false';
  const callSid      = req.body.CallSid || req.query.callSid || '';
  const callerNumber = req.body.From || '';
  const reason       = req.query.reason || '';
  const twiml        = new VoiceResponse();

  // Create CALL LOG if none exists yet (no-address / timeout / other paths)
  if (!logId && callSid) {
    try {
      const logRecord = await base('CALL LOG').create({
        Name: `Call ${new Date().toISOString()}`, Call_ID: callSid,
        Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
        Caller_Type: req.query.type || 'Unknown',
        Language: lang === 'es' ? 'Spanish' : 'English',
        Property_Address: 'No Address', Call_Disposition: 'Voicemail Left',
        Notes: `Reason: ${reason}. Caller consented to recording (FL two-party notice at greeting).`,
        ...(callerNameFor(callSid) ? { Caller_Name: callerNameFor(callSid) } : {}),
      });
      logId = logRecord.id;
    } catch (err) { console.error('Voicemail log creation error:', err); }
  }

  const context = matchAddress
    ? (lang === 'es' ? ` Sobre: ${matchAddress}.` : ` Regarding: ${matchAddress}.`) : '';

  // Slightly different prompt when address wasn't captured
  const noAddressPrompt = reason === 'no_address';
  const promptEN = noAddressPrompt
    ? `We weren't able to capture the property address. Please leave your name, callback number and the full property address after the tone and we will get back to you shortly.`
    : `${MSG_EN}${context} We'll get back to you shortly.`;
  const promptES = noAddressPrompt
    ? `No pudimos capturar la direccion de la propiedad. Por favor deje su nombre, numero de telefono y la direccion completa despues del tono y le contactaremos a la brevedad.`
    : `${MSG_ES}${context} Le contactaremos a la brevedad.`;

  say(twiml, lang, lang === 'es' ? promptES : promptEN);
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=${attention}&branch=${req.query.branch || ''}&sellerEmail=${encodeURIComponent(req.query.sellerEmail || '')}`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  res.type('text/xml').send(twiml.toString());
});

app.post('/voicemail-done', (req, res) => {
  const lang  = req.query.lang || 'en';
  const twiml = new VoiceResponse();
  say(twiml, lang, lang === 'es' ? 'Gracias. Hasta pronto.' : 'Thank you. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
  setImmediate(() => markMessageRecorded(req.body || {}));
});

// The recording has just ended (Twilio calls this even if the caller hung up while talking). Mark the row right
// away — the transcript callback that normally does it can arrive minutes later, or never for a very short message.
async function markMessageRecorded(body) {
  const secs = parseInt(body.RecordingDuration, 10);
  if (!body.CallSid || !body.RecordingUrl || !(secs >= 3)) return;
  try {
    const found = await base('CALL LOG').select({ filterByFormula: `{Call_ID}=${airtableStr(body.CallSid)}`, maxRecords: 1 }).firstPage();
    if (found.length) await updateCallSummary(found[0].id, { messageRecorded: true });
  } catch (e) { console.error('markMessageRecorded failed:', e.message || e); }
}

// ─── VOICEMAIL TRANSCRIBED ────────────────────────────────────────────────────
app.post('/voicemail-transcribed', async (req, res) => {
  const transcript   = req.body.TranscriptionText || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const callSid      = req.body.CallSid || '';
  const logId        = req.query.logId || '';
  const lang         = req.query.lang || 'en';
  const sellerEmail  = req.query.sellerEmail ? decodeURIComponent(req.query.sellerEmail) : '';
  const isAttention  = req.query.attention === 'true';
  const isCommission = req.query.branch === 'commission'; // ← commission branch → snapflatfee2 ONLY

  // Twilio's built-in voicemail transcription only understands English (documented), so a Spanish message
  // comes out as nonsense. Say so, and point to the audio, instead of presenting the nonsense as a transcript.
  const spanishNote = lang === 'es' ? 'Spanish message — the automatic transcript is English-only and unreliable. Listen to the recording.' : '';
  if (logId) {
    await base('CALL LOG').update(logId, {
      Transcript: spanishNote ? `[${spanishNote}]\n${transcript}` : transcript,
      Voicemail_URL: recordingUrl, Call_Disposition: 'Voicemail Left',
    }).catch(console.error);
  }

  const ts          = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const attachments = await fetchRecordingAttachment(recordingUrl);
  if (logId && recordingUrl) saveRecordingToAirtable(logId, recordingUrl, AT_FIELDS.voicemail, 'voicemail.mp3', attachments && attachments[0].content);
  const recordingLine = attachments
    ? `<p><b>Recording:</b> attached to this email (voicemail.mp3)</p>`
    : `<p><b>Recording:</b> <a href="${recordingUrl}">Listen</a> (requires Twilio Console login — attachment failed to fetch, see Railway logs)</p>`;
  // Who called (number, carrier name, property) — from the CALL LOG row, so every voicemail email says who it is.
  let lf = {};
  if (logId) { try { lf = (await base('CALL LOG').find(logId)).fields || {}; } catch (e) { console.error('voicemail email: could not read CALL LOG:', e.message); } }
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const vmNumber = lf.Caller_Number || req.body.From || '';
  const vmName   = lf.Caller_Name || callerNameFor(callSid);
  const vmProp   = lf.Real_Address || (lf.Property_Address && lf.Property_Address !== 'No Address' ? lf.Property_Address : '');
  const callerLine = vmNumber ? `<p><b>Caller:</b> ${esc(vmNumber)}${vmName ? ` (${esc(vmName)})` : ''}</p>` : '';
  const propLine   = vmProp ? `<p><b>Property:</b> ${esc(vmProp)}</p>` : '';
  const html = (title, extra) => `<div style="font-family:Arial,sans-serif;max-width:600px;">
    <h2 style="color:#003087;">📞 ${title}</h2>
    <p><b>Time:</b> ${ts}</p>${callerLine}${propLine}${extra}
    ${recordingLine}
    ${spanishNote
      ? `<p style="background:#fff7e6;padding:10px 12px;border-left:4px solid #e35c21;"><b>Mensaje en español.</b> Listen to the recording — the automatic transcript only understands English, so it is left out.</p>`
      : `<h3>Transcript</h3>
    <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript || 'Pending...'}</p>`}
    <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p></div>`;

  let emailedTo = '';
  if (isCommission) {
    emailedTo = 'Office only (commission message)';
    // Commission branch → snapflatfee2 ONLY — do not email seller
    await sendEmail({
      from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
      subject: '⚠️ IVR Commission Branch Voicemail — Review Required',
      html: html('Commission Branch Voicemail', `<p><b>Call SID:</b> ${callSid}</p><p><b>Language:</b> ${lang === 'es' ? 'Spanish' : 'English'}</p>`),
      attachments,
    }).catch(console.error);
  } else if (req.query.branch === 'seller' && sellerEmail) {
    emailedTo = process.env.EMAIL_TO ? 'Seller + copy to Office' : 'Seller';
    // Seller unavailable/declined → message goes to the seller, copy to SnapFlatFee
    await sendEmail({
      to: sellerEmail,
      subject: 'You have a new message about your listing',
      html: html('Message for you — SnapFlatFee.com', `<p><b>Call SID:</b> ${callSid}</p>`),
      attachments,
    }).catch(console.error);
    if (process.env.EMAIL_TO) {
      await sendEmail({
        to: process.env.EMAIL_TO,
        subject: `📞 Seller-unavailable voicemail (copy) — ${ts}`,
        html: html('Seller-unavailable voicemail — copy', `<p><b>Sent to seller:</b> ${sellerEmail}</p><p><b>Call SID:</b> ${callSid}</p>`),
        attachments,
      }).catch(console.error);
    }
  } else if (sellerEmail) {
    emailedTo = 'FCHB seller';
    // FCHB: direct to seller
    await sendEmail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: 'Voicemail received for your listing',
      html: html('Voicemail — Blue Lighthouse Realty', `<p><b>Call SID:</b> ${callSid}</p>`),
      attachments,
    }).catch(console.error);
  } else {
    emailedTo = isAttention ? 'Office (needs attention)' : 'Office';
    // Normal flow
    await sendEmail({
      from: process.env.EMAIL_FROM,
      to: isAttention ? 'snapflatfee2@gmail.com' : process.env.EMAIL_TO,
      subject: isAttention ? 'IVR — Voicemail needs attention' : `📞 New Voicemail — ${ts}`,
      html: html('New Voicemail — Blue Lighthouse Realty', `<p><b>Language:</b> ${lang === 'es' ? 'Spanish' : 'English'}</p><p><b>Call SID:</b> ${callSid}</p>`),
      attachments,
    }).catch(console.error);
  }
  if (logId) await updateCallSummary(logId, { messageRecorded: !!recordingUrl, extra: { 'Voicemail emailed to': emailedTo } });
  res.sendStatus(200);
});

// ─── AFTER-HOURS TRANSCRIBED ──────────────────────────────────────────────────
app.post('/afterhours-transcribed', async (req, res) => {
  const transcript   = req.body.TranscriptionText || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const callSid      = req.body.CallSid || '';
  const callerNumber = req.body.From || '';
  const lang         = req.query.lang || 'en';
  const ts           = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  // Twilio's voicemail transcription is English-only, so a Spanish message is garbled (see /voicemail-transcribed).
  const spanishNote  = lang === 'es' ? 'Spanish message — the automatic transcript is English-only and unreliable. Listen to the recording.' : '';
  const noteHtml     = spanishNote ? `<p style="background:#fff7e6;padding:10px 12px;border-left:4px solid #e35c21;"><b>Mensaje en español.</b> ${spanishNote}</p>` : '';

  try {
    // Only trust an address match that passes the same strict checks as live calls (house number, direction…).
    // A loose fuzzy match here could email the wrong seller about someone else's call.
    const listings = (await fetchListings()).filter((l) => /^(active|pending|coming soon)$/i.test(String(l.status).trim()));
    const match    = findMatchInText(listings, transcript);
    const attachments   = await fetchRecordingAttachment(recordingUrl);
    const recordingLine = attachments
      ? `<p>Recording attached to this email (voicemail.mp3)</p>`
      : `<p><a href="${recordingUrl}">Listen</a> (requires Twilio Console login — attachment failed to fetch)</p>`;

    let afterHoursLogId = '';
    try {
      const logRecord = await base('CALL LOG').create({
        Name: `After-Hours ${new Date().toISOString()}`, Call_ID: callSid,
        Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
        Caller_Type: 'Unknown', Property_Address: transcript, Transcript: spanishNote ? `[${spanishNote}]\n${transcript}` : transcript,
        Voicemail_URL: recordingUrl, Call_Disposition: match ? 'Voicemail Left' : 'No Match Found',
        Real_Address: match ? match.fullAddress : '',
        Listing_Link: match ? [match.id] : undefined,
        ...(callerNameFor(callSid) ? { Caller_Name: callerNameFor(callSid) } : {}),
      });
      afterHoursLogId = logRecord.id;
    } catch (e) { console.error('After-hours log error:', e); }
    if (afterHoursLogId && recordingUrl) saveRecordingToAirtable(afterHoursLogId, recordingUrl, AT_FIELDS.voicemail, 'voicemail.mp3', attachments && attachments[0].content);

    if (afterHoursLogId) await updateCallSummary(afterHoursLogId, { messageRecorded: !!recordingUrl, extra: { 'Voicemail emailed to': match && match.email ? 'Seller (after hours)' : 'Office' } });
    if (match && match.email) {
      await sendEmail({
        from: process.env.EMAIL_FROM, to: match.email,
        subject: `After-hours lead call — ${match.fullAddress}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#003087;">📞 After-Hours Call — Blue Lighthouse Realty</h2>
          <p>Dear ${match.name || 'Seller'},</p>
          <p>We received an after-hours call about your property at <strong>${match.fullAddress}</strong>.</p>
          <p>Caller: <strong>${callerNumber}</strong>${callerNameFor(callSid) ? ` (${callerNameFor(callSid).replace(/</g, '&lt;')})` : ''}</p>
          ${recordingLine}
          ${noteHtml}
          <h3>${spanishNote ? 'Automatic transcript (English-only — unreliable for Spanish)' : 'Transcript'}</h3>
          <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript}</p>
          <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p>
        </div>`,
        attachments,
      }).catch(console.error);
    } else {
      await sendEmail({
        from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
        subject: 'IVR — After-hours call (no match)',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#003087;">📞 After-Hours Voicemail — No Match</h2>
          <p><b>Time:</b> ${ts}</p><p><b>Caller:</b> ${callerNumber}</p>
          ${recordingLine}
          ${noteHtml}
          <p>${transcript || '(no transcript)'}</p>
        </div>`,
        attachments,
      }).catch(console.error);
    }
  } catch (err) {
    console.error('After-hours processing error:', err);
    const attachments = await fetchRecordingAttachment(recordingUrl).catch(() => null);
    await sendEmail({
      from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
      subject: 'IVR — After-hours call (error)',
      html: `<p>Error processing. Caller: ${callerNumber}. ${attachments ? 'Recording attached.' : `<a href="${recordingUrl}">Listen</a> (requires Twilio Console login)`} Transcript: ${transcript}</p>`,
      attachments,
    }).catch(console.error);
  }
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL FALLBACK — any stuck / error state
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/universal-fallback', (req, res) => {
  const lang   = req.query.lang || 'en';
  const logId  = req.query.logId || '';
  const twiml  = new VoiceResponse();

  // No "can we text you? press 1/2" any more — every caller is texted after the call.
  say(twiml, lang, lang === 'es'
    ? 'Lo siento, no pude asistirle a traves de este servicio automatico. Le enviaremos un texto, y por favor deje un mensaje con su nombre y la direccion de la propiedad despues del tono y alguien le contactara pronto.'
    : 'I\'m sorry, I wasn\'t able to assist you through this automated service. We will also send you a text. Please leave a message with your name and the property address after the tone and someone will contact you shortly.'
  );
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  res.type('text/xml').send(twiml.toString());
});

app.post('/fallback-sms-choice', async (req, res) => {
  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const lang   = req.query.lang || 'en';
  const logId  = req.query.logId || '';
  const twiml  = new VoiceResponse();
  // (No longer asked since 2026-11-10 — callers are always texted. Route kept so a call that was already
  //  mid-flow during the deploy does not hit a 404; it just goes on to the voicemail.)
  say(twiml, lang, leaveMsg(lang));
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFY SELLER helper
// ═══════════════════════════════════════════════════════════════════════════════
async function notifySeller({ record, callerNumber, callerName = '', callerType, address, city }) {
  const sellerEmail    = record.get('Email');
  const sellerPhone    = record.get('Phone');
  const sellerName     = record.get('Name') || 'Seller';
  const airtableConsent = (record.get('SMS_Recording_Consent') || '').toString().trim() === 'Yes I Agree';
  const callerLabel    = callerType === 'Realtor' ? 'a Realtor' : 'a Direct Buyer';
  const callerLabelSMS = callerType === 'Realtor' ? 'Realtor' : 'Direct Buyer';

  let emailSent = false;
  if (sellerEmail) {
    await sendEmail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: `SnapFlatFee Lead Call Received. ${address}, ${city}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">Call Notification — Blue Lighthouse Realty</h2>
        <p>Dear ${sellerName},</p>
        <p>${callerLabel.charAt(0).toUpperCase() + callerLabel.slice(1)} called about your property at <strong>${address}, ${city}</strong>.</p>
        <p>Caller: <strong>${callerNumber}</strong>${callerName ? ` (${String(callerName).replace(/</g, '&lt;')})` : ''}</p>
        <p>Please feel free to follow up directly.</p>
        <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p>
      </div>`,
    }).then(() => { emailSent = true; }).catch(console.error);
  }

  if (sellerPhone && airtableConsent) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER, to: sellerPhone,
      body: `Lead alert from SnapFlatFee.com. Call received inquiring about your property: ${address}, ${city}. From a ${callerLabelSMS}. Caller's number: ${callerNumber}${callerName ? ` (${callerName})` : ''}.\n\nAttn: Jorge Zea - Broker - Realtor Msg & data rates may apply. Reply STOP to opt out.`,
    }).catch(console.error);
    return { sms: true, email: emailSent };
  }
  return { sms: false, email: emailSent };
}

function buildRealtorSystemPrompt(lang, listingContext) {
  return lang === 'es'
    ? `Eres el asistente de Jorge Zea, Corredor de Bienes Raices. Responde SIEMPRE en español.\nDATOS: ${listingContext}\nMaximo 2 oraciones. Tono profesional y amable.`
    : `You are the assistant for Jorge Zea, Real Estate Broker. Respond ONLY in English.\nDATA: ${listingContext}\nMax 2 sentences. Professional, warm tone.`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏠 Blue Lighthouse IVR v3.0 running on port ${PORT}`));

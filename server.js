/**
 * Jorge Zea | Blue Lighthouse Realty
 * Twilio IVR + Claude AI + Airtable Webhook Server
 * v2.0 — Dual voice, language selection, FL two-party consent
 */

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

// ─── Dashboard UI ────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ─── INBOUND SMS — replies from callers/sellers ──────────────────────────────
app.post('/sms-inbound', async (req, res) => {
  const from = req.body.From || '';
  const body = req.body.Body || '';

  console.log(`Inbound SMS from ${from}: ${body}`);

  // Log to CALL LOG if a recent record exists for this number, else just log to console
  try {
    const records = await base('CALL LOG').select({
      filterByFormula: `{Caller_Number} = '${from}'`,
      sort: [{ field: 'Call_Date', direction: 'desc' }],
      maxRecords: 1,
    }).firstPage();

    if (records.length > 0) {
      const existing = records[0].get('Notes') || '';
      await base('CALL LOG').update(records[0].id, {
        Notes: existing + `\n[SMS REPLY ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}]: ${body}`,
      }).catch(console.error);
    }
  } catch (err) {
    console.error('SMS inbound log error:', err);
  }

  // No auto-reply — message just gets logged and appears in /dashboard
  res.type('text/xml').send('<Response></Response>');
});

// ─── API: Get all conversations (from Twilio message history + CALL LOG context) ──
app.get('/api/conversations', async (req, res) => {
  try {
    // 1. Pull ALL real conversations from Twilio (both directions)
    const sent = await twilioClient.messages.list({ from: process.env.TWILIO_PHONE_NUMBER, limit: 200 });
    const received = await twilioClient.messages.list({ to: process.env.TWILIO_PHONE_NUMBER, limit: 200 });
    const allMsgs = [...sent, ...received];

    // 2. Pull CALL LOG for context (caller type, property) — best-effort match
    const records = await base('CALL LOG').select({
      sort: [{ field: 'Call_Date', direction: 'desc' }],
      maxRecords: 300,
      fields: ['Call_Date','Caller_Number','Caller_Type','Real_Address','Property_Address'],
    }).all();

    const contextByNumber = new Map();
    records.forEach(r => {
      const num = r.get('Caller_Number') || '';
      if (num && !contextByNumber.has(num)) {
        contextByNumber.set(num, {
          type:     r.get('Caller_Type') || 'unknown',
          property: r.get('Real_Address') || r.get('Property_Address') || '',
        });
      }
    });

    // 3. Build conversation list keyed by the OTHER party's number
    const convMap = new Map();
    allMsgs.forEach(m => {
      const isOutbound = m.direction && m.direction.startsWith('outbound');
      const otherNumber = isOutbound ? m.to : m.from;
      if (!otherNumber || otherNumber === process.env.TWILIO_PHONE_NUMBER) return;

      const existing = convMap.get(otherNumber);
      const msgTime = new Date(m.dateSent || m.dateCreated);

      if (!existing || msgTime > new Date(existing.lastTime)) {
        const ctx = contextByNumber.get(otherNumber) || {};
        convMap.set(otherNumber, {
          number:      otherNumber,
          type:        ctx.type || 'unknown',
          property:    ctx.property || '',
          lastMessage: (m.body || '').slice(0, 80),
          lastTime:    msgTime.toISOString(),
          unread:      false,
        });
      }
    });

    const conversations = Array.from(convMap.values())
      .sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));

    res.json({ conversations });
  } catch (err) {
    console.error('Conversations API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Delete (hide) a conversation thread ────────────────────────────────
// Note: Twilio does not support deleting message history via this approach in
// a way that removes it from the carrier record. This endpoint is a no-op
// placeholder; actual hiding is handled client-side via localStorage.
app.post('/api/hide-conversation', (req, res) => {
  res.json({ success: true });
});

// ─── API: Get messages for a specific number (Twilio) ───────────────────────
app.get('/api/messages', async (req, res) => {
  try {
    const number = req.query.number;
    if (!number) return res.status(400).json({ error: 'number required' });

    const messages = await twilioClient.messages.list({
      to:   number,
      from: process.env.TWILIO_PHONE_NUMBER,
      limit: 50,
    });

    const inbound = await twilioClient.messages.list({
      from: number,
      to:   process.env.TWILIO_PHONE_NUMBER,
      limit: 50,
    });

    const all = [...messages, ...inbound]
      .sort((a, b) => new Date(a.dateSent) - new Date(b.dateSent));

    res.json({ messages: all.map(m => ({
      sid:       m.sid,
      direction: m.direction,
      body:      m.body,
      dateSent:  m.dateSent,
      status:    m.status,
    }))});
  } catch (err) {
    console.error('Messages API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Send a message ─────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });

    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body,
    });

    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error('Send API error:', err);
    res.status(500).json({ error: err.message });
  }
});

const twilioClient  = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const base          = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const claude        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Email via Resend (Railway blocks SMTP port 587 — use HTTP API instead) ──
// Sign up free at resend.com, get API key, add RESEND_API_KEY to Railway env vars
// Sends FROM noreply@snapflatfee.com, replies go to snapflatfee@gmail.com
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
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
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

const VOICE = {
  en: { voice: process.env.VOICE_EN || 'Google.en-US-Chirp3-HD-Aoede',  language: 'en-US' },
  es: { voice: process.env.VOICE_ES || 'Google.es-US-Chirp3-HD-Zephyr', language: 'es-US' },
};

function say(twiml, lang, text) {
  twiml.say(VOICE[lang], text);
}

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
async function postCallSends(logId) {
  if (!logId) return;
  try {
    const logRecord          = await base('CALL LOG').find(logId);
    const callerSMSRequested = logRecord.get('Caller_SMS_Requested') || false;
    const callerNumber       = logRecord.get('Caller_Number') || '';
    const callerType         = logRecord.get('Caller_Type')   || 'Buyer';
    const lang               = logRecord.get('Language') === 'Spanish' ? 'es' : 'en';
    // Try Listing_Link first — Airtable sometimes silently drops linked record
    // writes on create, so fall back to Prop_ID search if link is empty
    let listing = null;
    const listingLinks = logRecord.get('Listing_Link') || [];
    if (listingLinks.length) {
      listing = await base('ALL LISTINGS').find(listingLinks[0]).catch(() => null);
    }
    if (!listing) {
      const propId = (logRecord.get('Prop_ID') || '').toString().trim();
      if (!propId) {
        console.log(`postCallSends: no Listing_Link or Prop_ID on logId ${logId} — nothing to send`);
        return;
      }
      const recs = await base('ALL LISTINGS').select({
        filterByFormula: `{prop_id}="${propId}"`,
        maxRecords: 1,
        fields: ['Address','Street Address','City','Phone','Email','Name','SMS_Recording_Consent'],
      }).firstPage();
      if (!recs.length) {
        console.log(`postCallSends: no listing found for prop_id ${propId}`);
        return;
      }
      listing = recs[0];
      console.log(`postCallSends: Listing_Link was empty — used Prop_ID fallback (${propId})`);
    }

    const address = listing.get('Address') || listing.get('Street Address') || '';
    const city    = listing.get('City') || '';

    // SMS to caller (only if they opted in during call)
    if (callerSMSRequested && callerNumber) {
      const isBuyer   = callerType !== 'Realtor';
      const buyerAdEN = isBuyer ? ' If you ever need to sell your property and save the entire commission, visit www.SnapFlatFee.com®' : '';
      const buyerAdES = isBuyer ? ' Para vender su propiedad y ahorrar la comision visitenos en www.SnapFlatFee.com®' : '';
      const msgBody   = lang === 'es'
        ? `La informacion solicitada: Propiedad: ${address}, ${city}. Telefono: ${listing.get('Phone') || ''}. Email: ${listing.get('Email') || ''}. Attn: Jorge Zea - Broker - Realtor®.${buyerAdES} Tarifas pueden aplicar. Responda STOP para cancelar.`
        : `The info you requested: Property: ${address}, ${city}. Phone: ${listing.get('Phone') || ''}. Email: ${listing.get('Email') || ''}. Attn: Jorge Zea - Broker - Realtor®.${buyerAdEN} Msg & data rates may apply. Reply STOP to opt out.`;
      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER, to: callerNumber, body: msgBody,
      }).catch(e => console.error('Caller SMS error:', e.message));
      await base('CALL LOG').update(logId, { SMS_Sent: true }).catch(console.error);
    }

    // Seller notification (email always + SMS if consent)
    const sellerSmsSent = await notifySeller({ record: listing, callerNumber, callerType, address, city });
    if (sellerSmsSent) {
      await base('CALL LOG').update(logId, { Seller_SMS_Sent: true }).catch(console.error);
    }
  } catch (err) {
    console.error('postCallSends error:', err.message || err);
  }
}

// ─── REALTOR TRANSFER PROMPT helper ──────────────────────────────────────────
// Shared by ALL Realtor transfer paths (showing, anything-else, post-commission)
function playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber) {
  const partyEN = isRental ? 'landlord' : 'seller';
  const partyES = isRental ? 'el propietario' : 'el vendedor';
  const gather  = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 5, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints:    lang === 'es' ? 'si, texto, uno, 1' : 'yes, text, one, 1',
    action:   `${process.env.BASE_URL}/flag-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&type=Realtor`,
    method: 'POST',
  });
  gather.say(VOICE[lang], lang === 'es'
    ? `${partyES.charAt(0).toUpperCase() + partyES.slice(1)} coordina las visitas y respondera sus preguntas directamente. Le transfiero ahora mismo. Oprima 1 o diga texto y le envio la informacion de contacto por si no podemos comunicarle ahora.`
    : `The ${partyEN} handles showings and will answer any questions directly. Transferring your call right now. Press 1 or say text and I will also send you the ${partyEN}'s contact information in case we can't connect you now.`
  );
  // Always transfer even without SMS opt-in
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}`);
}

// ─── FCHB SPECIAL CASE ───────────────────────────────────────────────────────
const FCHB_EMAILS = ['kevin@floridacashhomebuyers.com', 'alejandro@floridacashhomebuyers.com'];
async function handleFCHB(res, twiml, { match, lang, logId }) {
  await base('CALL LOG').update(logId, {
    Call_Disposition: 'FCHB - Voicemail',
    Notes: 'FCHB property — routed directly to voicemail per account rule.',
  }).catch(console.error);
  say(twiml, lang, lang === 'es'
    ? 'Gracias. Por favor deje su mensaje detallado despues del tono y se lo haremos llegar al propietario.'
    : 'Thank you. Please leave a detailed message after the tone and we will forward it to the property owner right away.'
  );
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=false&sellerEmail=${encodeURIComponent(match.email)}`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  return res.type('text/xml').send(twiml.toString());
}

// ─── AIRTABLE TEST ────────────────────────────────────────────────────────────
app.get('/test-airtable', async (req, res) => {
  const result = {
    AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY ? `set (${process.env.AIRTABLE_API_KEY.slice(0,12)}...)` : 'MISSING',
    AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID || 'MISSING',
    BASE_URL:         process.env.BASE_URL || 'MISSING',
  };
  try {
    const recs = await base('ALL LISTINGS').select({ maxRecords: 2, fields: ['prop_id','Status'] }).firstPage();
    result.all_listings_ok = true;
    result.sample = recs.map(r => ({ id: r.id, prop_id: r.get('prop_id'), status: r.get('Status') }));
  } catch (err) { result.all_listings_ok = false; result.all_listings_error = err.message; result.status_code = err.statusCode; }
  try {
    await base('CALL LOG').select({ maxRecords: 1, fields: ['Name'] }).firstPage();
    result.call_log_ok = true;
  } catch (err) { result.call_log_ok = false; result.call_log_error = err.message; }
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
        filterByFormula: `{Call_ID}="${callSid}"`, maxRecords: 1,
      }).firstPage();
      if (records.length) setImmediate(() => postCallSends(records[0].id));
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
      'Por favor deje un mensaje con su nombre, su numero de telefono y la direccion de la propiedad despues del tono y le contactaremos prontamente.'
    : 'Unfortunately you reached us outside our working schedule, which is from 7 AM to 9 PM every day. ' +
      'Please leave a message with your name, callback number and the property address after the tone and we will get back to you shortly.'
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
      ? 'Por favor deje un mensaje detallado despues del tono y le contactaremos prontamente.'
      : 'Please leave a detailed message after the tone and we will get back to you promptly.'
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

  // Address request — force en-US STT even for Spanish callers
  // because all Airtable addresses are in English format
  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 10, speechTimeout: 'auto',
    language: 'en-US',   // ← ALWAYS en-US for address recognition
    hints: 'street, avenue, boulevard, drive, court, lane, circle, road, way, place, terrace, trail, NW, NE, SW, SE, north, south, east, west, two, other, 2',
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
app.post('/lookup-property', async (req, res) => {
  const speech        = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits        = (req.body.Digits || '').trim();
  const spokenAddress = req.body.SpeechResult || '';
  const lang          = req.query.lang || 'en';
  const callerType    = req.query.type || 'Buyer';
  const callSid       = req.query.callSid || req.body.CallSid;
  const callerNumber  = req.body.From || '';
  const twiml         = new VoiceResponse();

  // Press 2 / "something else" → attention voicemail
  const isSomethingElse = digits === '2' || /\b(something else|other|otro|otra|2)\b/.test(speech);
  if (isSomethingElse) {
    say(twiml, lang, lang === 'es'
      ? 'Por favor deje un mensaje detallado despues del tono y le contactaremos prontamente.'
      : 'Please leave a detailed message after the tone and we will get back to you promptly.'
    );
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=&lang=${lang}&attention=true`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
    });
    return res.type('text/xml').send(twiml.toString());
  }

  // No address spoken — route through /voicemail so CALL LOG is always created
  // This also handles Spanish callers whose en-US STT returns empty
  if (!spokenAddress.trim()) {
    twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_address&type=${callerType}&callSid=${callSid}&attention=true`);
    return res.type('text/xml').send(twiml.toString());
  }

  let logId = '';

  try {
    const records = await base('ALL LISTINGS').select({
      fields: ['Address','Street Address','City','State','Zip code','Name','Phone','Email',
               'BAC Offered','Commission NOTES','Type','List Price','Notes','prop_id','Status','SMS_Recording_Consent'],
    }).all();

    const listings = records.map(r => ({
      id: r.id, prop_id: r.get('prop_id') || '',
      address:     r.get('Address') || r.get('Street Address') || '',
      city:        r.get('City') || '',
      fullAddress: [r.get('Address') || r.get('Street Address'), r.get('City'), r.get('State'), r.get('Zip code')].filter(Boolean).join(', '),
      name: r.get('Name') || '', phone: r.get('Phone') || '', email: r.get('Email') || '',
      bac: r.get('BAC Offered') || '', commNotes: r.get('Commission NOTES') || '',
      type: r.get('Type') || '', price: r.get('List Price') || '', notes: r.get('Notes') || '',
      status: (r.get('Status') || '').toString(),
    }));

    const fuse    = new Fuse(listings, { keys: ['address','fullAddress','city'], threshold: 0.45, includeScore: true });
    const results = fuse.search(spokenAddress.trim());
    const match   = results.length > 0 ? results[0].item : null;

    // ── CREATE CALL LOG (isolated — failure never blocks call flow) ───────────
    try {
      const logFields = {
        Name: `Call ${new Date().toISOString()}`, Call_ID: callSid,
        Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
        Caller_Type: callerType, Language: lang === 'es' ? 'Spanish' : 'English',
        Property_Address: spokenAddress.trim(),
        Notes: 'Caller consented to recording by continuing on the line (FL two-party notice at greeting).',
      };
      if (match) {
        logFields.Real_Address  = match.fullAddress;
        logFields.Prop_ID       = match.prop_id;
        logFields.BAC_Disclosed = callerType === 'Realtor' ? match.bac : '';
        logFields.Listing_Link  = [match.id];  // Airtable JS client expects string IDs, not objects
      } else {
        logFields.Call_Disposition = 'No Match Found';
      }
      const logRecord = await base('CALL LOG').create(logFields);
      logId = logRecord.id;
    } catch (logErr) {
      console.error('CALL LOG create (non-fatal):', logErr.message || logErr);
    }

    if (!match) {
      say(twiml, lang, lang === 'es'
        ? 'Lo sentimos, no encontramos esa propiedad en nuestro sistema. Por favor deje un mensaje y le contactaremos a la brevedad.'
        : 'I\'m sorry, I couldn\'t find that property in our system. Please leave a message and someone will follow up with you shortly.'
      );
      twiml.record({
        maxLength: 120, transcribe: true,
        transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true`,
        action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
      });
      return res.type('text/xml').send(twiml.toString());
    }

    // Status filter
    const statusOk = /^active$|^pending$/i.test(match.status.trim());
    if (!statusOk) {
      if (logId) await base('CALL LOG').update(logId, { Call_Disposition: 'Inactive Property', Notes: `Status: "${match.status}"` }).catch(console.error);
      say(twiml, lang, lang === 'es'
        ? 'Desafortunadamente esta propiedad ya no se encuentra disponible. Si desea dejar un mensaje, puede hacerlo despues del tono.'
        : 'Unfortunately this property is no longer available. You may leave a message after the tone if you would like.'
      );
      twiml.record({
        maxLength: 120, transcribe: true,
        transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true`,
        action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
      });
      return res.type('text/xml').send(twiml.toString());
    }

    // Route by caller type
    if (callerType === 'Realtor') {
      return realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId });
    } else {
      return buyerTenantFlow(res, twiml, { match, lang, callerNumber, callerType, callSid, logId });
    }

  } catch (err) {
    console.error('Lookup error — message:', err.message, '| statusCode:', err.statusCode);
    console.error('Env check — API_KEY set:', !!process.env.AIRTABLE_API_KEY, '| BASE_ID:', process.env.AIRTABLE_BASE_ID);
    twiml.redirect(`${process.env.BASE_URL}/universal-fallback?lang=${lang}&logId=${logId}&callSid=${callSid}`);
    res.type('text/xml').send(twiml.toString());
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4A — REALTOR FLOW
// ═══════════════════════════════════════════════════════════════════════════════
function realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId }) {
  if (FCHB_EMAILS.includes((match.email || '').toLowerCase())) {
    return handleFCHB(res, twiml, { match, lang, logId });
  }
  const isRental = /rent|lease|alquil/i.test(match.type || '');

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
      'Press 1 or say showing to schedule a showing, or leave a message after the tone.';

    const scriptES =
      'No hay una oferta anticipada de compensacion para esta propiedad. ' +
      'Usted debera ser compensado por su comprador segun su acuerdo de representacion. ' +
      'Sin embargo, al presentar una oferta, esto siempre puede negociarse, ' +
      'y el vendedor podria ayudar a su comprador a pagar su compensacion segun los terminos y las ganancias netas del vendedor. ' +
      'Oprima 1 o diga visita para programar una visita, o deje un mensaje despues del tono.';

    await base('CALL LOG').update(logId, { Transcript: `Realtor asked about commission. Response played.` }).catch(console.error);

    const gather = twiml.gather({
      input: 'speech dtmf', numDigits: 1, timeout: 4, speechTimeout: 'auto',
      language: VOICE[lang].language,
      hints: lang === 'es' ? 'visita, uno, 1, mostrar, si' : 'showing, show, one, 1, schedule, yes',
      action: `${process.env.BASE_URL}/realtor-commission-choice?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&isRental=${isRental}`,
      method: 'POST',
    });
    gather.say(VOICE[lang], lang === 'es' ? scriptES : scriptEN);

    // 4 sec timeout → voicemail → snapflatfee2 ONLY (not seller — may contain complaints)
    say(twiml, lang, lang === 'es'
      ? 'Por favor deje un mensaje detallado despues del tono y alguien le contactara prontamente.'
      : 'Please leave a detailed message after the tone and someone will contact you promptly.'
    );
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

// ─── REALTOR COMMISSION CHOICE (after commission script, 4s timeout) ──────────
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

  if (wantsShow) {
    playTransferPrompt(twiml, lang, isRental, logId, matchId, callerNumber);
  } else {
    // No choice → voicemail → snapflatfee2 ONLY
    say(twiml, lang, lang === 'es'
      ? 'Por favor deje un mensaje despues del tono y alguien le contactara prontamente.'
      : 'Please leave a message after the tone and someone will contact you promptly.'
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

  const wantsText = digits === '1' || /\b(yes|si|text|texto|one|uno|1)\b/i.test(speech);
  if (wantsText && logId) {
    await base('CALL LOG').update(logId, { Caller_SMS_Requested: true }).catch(console.error);
  }
  // Always proceed to transfer
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}`);
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

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 5, language: VOICE[lang].language,
    hints: lang === 'es' ? 'si, texto, uno, 1' : 'yes, text, one, 1',
    action: `${process.env.BASE_URL}/flag-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&callerNumber=${encodeURIComponent(callerNumber)}&type=${callerType}`,
    method: 'POST',
  });

  gather.say(VOICE[lang], lang === 'es'
    ? `${partyES.charAt(0).toUpperCase() + partyES.slice(1)} coordina las visitas directamente, le transfiero ahora mismo. Oprima 1 o diga texto y le envio los datos de contacto por si no podemos comunicarle ahora.`
    : `The ${partyEN} is handling showings directly. I will transfer your call right now. Press 1 or say text and I will also send you the ${partyEN}'s contact information in case we can't connect you now.`
  );
  // Transfer even without SMS opt-in
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(match.id)}&logId=${logId}`);
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
    const listingType = (r.get('Type') || '').toLowerCase();
    const isRental    = /rent|lease/.test(listingType);

    if (!sellerPhone) {
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_seller_phone&lang=${lang}&logId=${logId}`);
    } else {
      const partyEN = isRental ? 'the landlord' : 'the seller';
      const partyES = isRental ? 'el propietario' : 'el vendedor';
      say(twiml, lang, lang === 'es'
        ? `Le transferimos con ${partyES}. Un momento por favor.`
        : `We are connecting you with ${partyEN} now. One moment please.`
      );

      const dial = twiml.dial({
        record: 'record-from-answer-dual-channel',
        recordingStatusCallback: `${process.env.BASE_URL}/second-leg-recording?logId=${logId}`,
        recordingStatusCallbackMethod: 'POST',
        action: `${process.env.BASE_URL}/seller-unavailable?lang=${lang}&logId=${logId}`,
        method: 'POST',
      });
      dial.number({
        url: `${process.env.BASE_URL}/seller-whisper?isRental=${isRental}`,
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

// ─── SELLER WHISPER — always English ─────────────────────────────────────────
app.post('/seller-whisper', (req, res) => {
  const isRental = req.query.isRental === 'true';
  const party    = isRental ? 'a potential tenant' : 'a potential buyer or Realtor';
  const twiml    = new VoiceResponse();
  const gather   = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: 'en-US', hints: 'yes, accept, ok, 1',
    action: `${process.env.BASE_URL}/seller-consent`, method: 'POST',
  });
  gather.say(VOICE.en,
    `Press 1 or say yes to accept an incoming lead call from SnapFlatFee.com about your listing. ` +
    `The caller is ${party}. This call will be recorded for compliance purposes.`
  );
  say(twiml, 'en', 'No response received. The caller will be notified.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ─── SELLER CONSENT ───────────────────────────────────────────────────────────
app.post('/seller-consent', (req, res) => {
  const speech   = (req.body.SpeechResult || '').toLowerCase();
  const digits   = (req.body.Digits || '').trim();
  const accepted = digits === '1' || /yes|ok|si|sí|aceptar|accept/.test(speech);
  const twiml    = new VoiceResponse();
  if (accepted) {
    res.type('text/xml').send('<Response></Response>'); // connect the call
  } else {
    twiml.say(VOICE.en, 'Call not accepted. Thank you.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ─── SECOND LEG RECORDING ─────────────────────────────────────────────────────
app.post('/second-leg-recording', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || '';
  const logId        = req.query.logId || '';
  if (logId && recordingUrl) {
    await base('CALL LOG').update(logId, { Second_Leg_Recording_URL: recordingUrl }).catch(console.error);
  }
  res.sendStatus(200);
});

// ─── SELLER STATUS ────────────────────────────────────────────────────────────
app.post('/seller-status', async (req, res) => {
  const callStatus = req.body.CallStatus || '';
  const logId      = req.query.logId || '';
  if (logId) {
    const answered = callStatus === 'completed' || callStatus === 'answered';
    await base('CALL LOG').update(logId, { Seller_Accepted_Call: answered }).catch(console.error);
  }
  res.sendStatus(200);
});

// ─── SELLER UNAVAILABLE ───────────────────────────────────────────────────────
// Fires when <Dial> ends. Detects real call vs voicemail via duration.
app.post('/seller-unavailable', async (req, res) => {
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId || '';
  const dialStatus   = req.body.DialCallStatus || '';
  const dialDuration = parseInt(req.body.DialCallDuration || '0', 10);
  const twiml        = new VoiceResponse();

  // Real completed call (≥20s) → silent hangup, recording saves async
  if (dialStatus === 'completed' && dialDuration >= 20) {
    if (logId) {
      await base('CALL LOG').update(logId, { Call_Disposition: 'Completed' }).catch(console.error);
      setImmediate(() => postCallSends(logId)); // fire SMS/email after response
    }
    return res.type('text/xml').send('<Response><Hangup/></Response>');
  }

  // No-answer / busy / failed / short completed (seller VM likely) → our voicemail
  if (logId) {
    await base('CALL LOG').update(logId, {
      Call_Disposition: `Seller Unavailable (${dialStatus || 'unknown'})`,
      Seller_Accepted_Call: false,
    }).catch(console.error);
    setImmediate(() => postCallSends(logId)); // caller still gets their SMS
  }

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es' ? 'mensaje, uno, 1' : 'message, one, 1',
    action: `${process.env.BASE_URL}/unavailable-choice?lang=${lang}&logId=${logId}`,
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
  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=seller_unavailable`);
  res.type('text/xml').send(twiml.toString());
});

// ─── UNAVAILABLE CHOICE ───────────────────────────────────────────────────────
app.post('/unavailable-choice', (req, res) => {
  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const lang   = req.query.lang || 'en';
  const logId  = req.query.logId || '';
  const twiml  = new VoiceResponse();
  const wantsMsg = digits === '1' || /\b(one|uno|message|mensaje|1)\b/.test(speech);

  if (wantsMsg) {
    twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=seller_unavailable`);
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
    : `Please leave your message with your name and callback number after the tone.${context} We'll get back to you shortly.`;
  const promptES = noAddressPrompt
    ? `No pudimos capturar la direccion de la propiedad. Por favor deje su nombre, numero de telefono y la direccion completa despues del tono y le contactaremos a la brevedad.`
    : `Por favor deje su mensaje con su nombre y numero de telefono despues del tono.${context} Le contactaremos a la brevedad.`;

  say(twiml, lang, lang === 'es' ? promptES : promptEN);
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=${attention}&branch=${req.query.branch || ''}`,
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
});

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

  if (logId) {
    await base('CALL LOG').update(logId, {
      Transcript: transcript, Voicemail_URL: recordingUrl, Call_Disposition: 'Voicemail Left',
    }).catch(console.error);
  }

  const ts  = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const html = (title, extra) => `<div style="font-family:Arial,sans-serif;max-width:600px;">
    <h2 style="color:#003087;">📞 ${title}</h2>
    <p><b>Time:</b> ${ts}</p>${extra}
    <p><b>Recording:</b> <a href="${recordingUrl}">Listen</a></p>
    <h3>Transcript</h3>
    <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript || 'Pending...'}</p>
    <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p></div>`;

  if (isCommission) {
    // Commission branch → snapflatfee2 ONLY — do not email seller
    await sendEmail({
      from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
      subject: '⚠️ IVR Commission Branch Voicemail — Review Required',
      html: html('Commission Branch Voicemail', `<p><b>Call SID:</b> ${callSid}</p><p><b>Language:</b> ${lang === 'es' ? 'Spanish' : 'English'}</p>`),
    }).catch(console.error);
  } else if (sellerEmail) {
    // FCHB: direct to seller
    await sendEmail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: 'Voicemail received for your listing',
      html: html('Voicemail — Blue Lighthouse Realty', `<p><b>Call SID:</b> ${callSid}</p>`),
    }).catch(console.error);
  } else {
    // Normal flow
    await sendEmail({
      from: process.env.EMAIL_FROM,
      to: isAttention ? 'snapflatfee2@gmail.com' : process.env.EMAIL_TO,
      subject: isAttention ? 'IVR — Voicemail needs attention' : `📞 New Voicemail — ${ts}`,
      html: html('New Voicemail — Blue Lighthouse Realty', `<p><b>Language:</b> ${lang === 'es' ? 'Spanish' : 'English'}</p><p><b>Call SID:</b> ${callSid}</p>`),
    }).catch(console.error);
  }
  res.sendStatus(200);
});

// ─── AFTER-HOURS TRANSCRIBED ──────────────────────────────────────────────────
app.post('/afterhours-transcribed', async (req, res) => {
  const transcript   = req.body.TranscriptionText || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const callSid      = req.body.CallSid || '';
  const callerNumber = req.body.From || '';
  const ts           = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  try {
    const records = await base('ALL LISTINGS').select({
      filterByFormula: `OR({Status}='Active',{Status}='Pending',{Status}='Coming Soon')`,
      fields: ['Address','Street Address','City','State','Zip code','Name','Phone','Email'],
    }).all();
    const listings = records.map(r => ({
      id: r.id,
      address: r.get('Address') || r.get('Street Address') || '',
      city: r.get('City') || '',
      fullAddress: [r.get('Address') || r.get('Street Address'), r.get('City'), r.get('State'), r.get('Zip code')].filter(Boolean).join(', '),
      name: r.get('Name') || '', phone: r.get('Phone') || '', email: r.get('Email') || '',
    }));
    const fuse    = new Fuse(listings, { keys: ['address','fullAddress','city'], threshold: 0.45 });
    const results = fuse.search(transcript);
    const match   = results.length > 0 ? results[0].item : null;

    await base('CALL LOG').create({
      Name: `After-Hours ${new Date().toISOString()}`, Call_ID: callSid,
      Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
      Caller_Type: 'Unknown', Property_Address: transcript, Transcript: transcript,
      Voicemail_URL: recordingUrl, Call_Disposition: match ? 'Voicemail Left' : 'No Match Found',
      Real_Address: match ? match.fullAddress : '',
      Listing_Link: match ? [match.id] : undefined,
    }).catch(e => console.error('After-hours log error:', e));

    if (match && match.email) {
      await sendEmail({
        from: process.env.EMAIL_FROM, to: match.email,
        subject: `After-hours lead call — ${match.fullAddress}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#003087;">📞 After-Hours Call — Blue Lighthouse Realty</h2>
          <p>Dear ${match.name || 'Seller'},</p>
          <p>We received an after-hours call about your property at <strong>${match.fullAddress}</strong>.</p>
          <p>Caller: <strong>${callerNumber}</strong></p>
          <p><a href="${recordingUrl}">Listen to voicemail</a></p>
          <h3>Transcript</h3>
          <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript}</p>
          <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p>
        </div>`,
      }).catch(console.error);
    } else {
      await sendEmail({
        from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
        subject: 'IVR — After-hours call (no match)',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#003087;">📞 After-Hours Voicemail — No Match</h2>
          <p><b>Time:</b> ${ts}</p><p><b>Caller:</b> ${callerNumber}</p>
          <p><a href="${recordingUrl}">Listen</a></p>
          <p>${transcript || '(no transcript)'}</p>
        </div>`,
      }).catch(console.error);
    }
  } catch (err) {
    console.error('After-hours processing error:', err);
    await sendEmail({
      from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
      subject: 'IVR — After-hours call (error)',
      html: `<p>Error processing. Caller: ${callerNumber}. <a href="${recordingUrl}">Listen</a>. Transcript: ${transcript}</p>`,
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

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 6, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es' ? 'si, uno, 1, no, dos, 2' : 'yes, one, 1, no, two, 2',
    action: `${process.env.BASE_URL}/fallback-sms-choice?lang=${lang}&logId=${logId}`,
    method: 'POST',
  });
  if (lang === 'es') {
    gather.say(VOICE.es,
      'Lo siento, no pude asistirle a traves de este servicio automatico. ' +
      'Por favor deje un mensaje con su nombre y la direccion de la propiedad despues del tono y alguien le contactara pronto. ' +
      'Podemos contactarle tambien por mensaje de texto? Oprima 1 para si o oprima 2 para no.'
    );
  } else {
    gather.say(VOICE.en,
      'I\'m sorry, I wasn\'t able to assist you through this automated service. ' +
      'Please leave a message with your name and the property address after the tone and someone will contact you shortly. ' +
      'Can we also reach you by text? Press 1 for yes or press 2 for no.'
    );
  }
  say(twiml, lang, lang === 'es'
    ? 'Por favor deje su mensaje despues del tono.'
    : 'Please leave your message after the tone.'
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
  if ((digits === '1' || /\b(yes|si|one|uno|1)\b/.test(speech)) && logId) {
    await base('CALL LOG').update(logId, { Caller_SMS_Requested: true }).catch(console.error);
  }
  say(twiml, lang, lang === 'es'
    ? 'Por favor deje su mensaje con su nombre y la direccion de la propiedad despues del tono.'
    : 'Please leave your message with your name and the property address after the tone.'
  );
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
async function notifySeller({ record, callerNumber, callerType, address, city }) {
  const sellerEmail    = record.get('Email');
  const sellerPhone    = record.get('Phone');
  const sellerName     = record.get('Name') || 'Seller';
  const airtableConsent = (record.get('SMS_Recording_Consent') || '').toString().trim() === 'Yes I Agree';
  const callerLabel    = callerType === 'Realtor' ? 'a Realtor' : 'a Direct Buyer';
  const callerLabelSMS = callerType === 'Realtor' ? 'Realtor' : 'Direct Buyer';

  if (sellerEmail) {
    await sendEmail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: `SnapFlatFee Lead Call Received. ${address}, ${city}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">Call Notification — Blue Lighthouse Realty</h2>
        <p>Dear ${sellerName},</p>
        <p>${callerLabel.charAt(0).toUpperCase() + callerLabel.slice(1)} called about your property at <strong>${address}, ${city}</strong>.</p>
        <p>Caller: <strong>${callerNumber}</strong></p>
        <p>Please feel free to follow up directly.</p>
        <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p>
      </div>`,
    }).catch(console.error);
  }

  if (sellerPhone && airtableConsent) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER, to: sellerPhone,
      body: `Lead alert from www.SnapFlatFee.com®. Call received about your property: ${address}, ${city}. From a ${callerLabelSMS}. Caller's number: ${callerNumber}. Attn: Jorge Zea - Broker - Realtor® Msg & data rates may apply. Reply STOP to opt out.`,
    }).catch(console.error);
    return true;
  }
  return false;
}

function buildRealtorSystemPrompt(lang, listingContext) {
  return lang === 'es'
    ? `Eres el asistente de Jorge Zea, Corredor de Bienes Raices. Responde SIEMPRE en español.\nDATOS: ${listingContext}\nMaximo 2 oraciones. Tono profesional y amable.`
    : `You are the assistant for Jorge Zea, Real Estate Broker. Respond ONLY in English.\nDATA: ${listingContext}\nMax 2 sentences. Professional, warm tone.`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏠 Blue Lighthouse IVR v3.0 running on port ${PORT}`));

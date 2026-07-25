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

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_APP_PASSWORD },
});

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

// STEP 1 — INBOUND: FL two-party consent + dual-language greeting
app.post('/inbound', (req, res) => {
  const twiml = new VoiceResponse();

  // After-hours check — bypass entire IVR and go straight to bilingual voicemail
  if (!isWithinBusinessHours()) {
    say(twiml, 'en',
      'Thank you for calling Jorge Zea, Real Estate Broker. ' +
      'Unfortunately you reached us outside of our working schedule, ' +
      'which is from 7 AM to 9 PM every day. Please leave us a message ' +
      'with the property address you are calling about after the tone.'
    );
    say(twiml, 'es',
      'Gracias por llamar a Jorge Zea, Real Estate Broker. ' +
      'Desafortunadamente estamos fuera de nuestro horario de atencion ' +
      'de 7 AM a 9 PM todos los dias. Por favor deje un mensaje con la ' +
      'direccion de la propiedad despues del tono.'
    );
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/afterhours-transcribed`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=en`, method: 'POST',
    });
    return res.type('text/xml').send(twiml.toString());
  }

  // All prompts inside gather so audio plays fully before input is accepted
  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: 'en-US',
    hints: 'English, Spanish, espanol, one, two, uno, dos, 1, 2',
    action: `${process.env.BASE_URL}/select-language`, method: 'POST',
  });

  // English consent + selection — Aoede
  gather.say(VOICE.en,
    'Thank you for calling Jorge Zea, Real Estate Broker. ' +
    'This call may be recorded for quality and compliance purposes. ' +
    'By continuing on the line, you consent to being recorded. ' +
    'For English, press 1 or say English.'
  );

  // Spanish consent + selection — Zephyr
  gather.say(VOICE.es,
    'Gracias por llamar a Jorge Zea, Real Estate Broker. ' +
    'Esta llamada puede ser grabada con fines de calidad y cumplimiento. ' +
    'Al continuar en la linea, usted consiente ser grabado. ' +
    'Para espanol, oprima 2 o diga espanol.'
  );

  twiml.redirect(`${process.env.BASE_URL}/select-language`);
  res.type('text/xml').send(twiml.toString());
});

// STEP 2 — LANGUAGE SELECTION → CALLER TYPE → ADDRESS (consolidated)
app.post('/select-language', (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const callSid = req.body.CallSid;
  const lang    = (digits === '2' || /espa|spanish|dos|2/.test(speech)) ? 'es' : 'en';
  const twiml   = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 6, speechTimeout: 'auto',
    language: VOICE[lang].language,
    // hints include both old and new words so recognition stays sharp
    hints: lang === 'es'
      ? 'Realtor, agente, cliente, comprador, inquilino, otro, uno, dos, tres, 1, 2, 3'
      : 'Realtor, agent, customer, buyer, tenant, other, one, two, three, 1, 2, 3',
    action: `${process.env.BASE_URL}/caller-type?lang=${lang}&callSid=${callSid}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say(VOICE.es,
      'Es usted un Realtor o agente de bienes raices? Oprima 1 o diga Realtor. ' +
      'Es usted un cliente interesado en la propiedad? Oprima 2 o diga cliente. ' +
      'Para cualquier otra consulta, oprima 3 o diga otro.'
    );
  } else {
    gather.say(VOICE.en,
      'Are you a Realtor or real estate agent? Press 1 or say Realtor. ' +
      'Are you an interested customer? Press 2 or say customer. ' +
      'For anything else, press 3 or say other.'
    );
  }

  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_input&callSid=${callSid}`);
  res.type('text/xml').send(twiml.toString());
});

// STEP 3 — CALLER TYPE → CONSOLIDATED address request (property gate removed)
app.post('/caller-type', (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const lang    = req.query.lang || 'en';
  const callSid = req.query.callSid || req.body.CallSid;
  const twiml   = new VoiceResponse();

  // Option 3 / "other" → attention voicemail in caller's language
  const isOther = digits === '3' || /other|otro|else|otra|3/.test(speech);
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

  // Detect caller type — voice says buyer/tenant/comprador/inquilino all map to Buyer
  const isRealtor  = digits === '1' || /realtor|agent|agente|broker|1/.test(speech);
  const isTenant   = /tenant|inquilino|rent|alquil/.test(speech);
  // "customer", "cliente", "buyer", "comprador" all resolve to Buyer
  const callerType = isRealtor ? 'Realtor' : (isTenant ? 'Tenant' : 'Buyer');

  // Consolidated Step 3+4: ask for address directly — one prompt, no gate
  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 10, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es'
      ? 'calle, avenida, dos, otro, 2'
      : 'street, avenue, boulevard, drive, two, other, 2',
    action: `${process.env.BASE_URL}/lookup-property?lang=${lang}&type=${callerType}&callSid=${callSid}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say(VOICE.es,
      'Sobre que propiedad nos llama? Por favor diga la direccion completa. ' +
      'Para cualquier otra consulta, oprima 2 o diga otra cosa.'
    );
  } else {
    gather.say(VOICE.en,
      'Are you calling about a specific property? Just say the address. ' +
      'For something else, press 2 or say something else.'
    );
  }

  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_input&type=${callerType}&callSid=${callSid}&attention=true`);
  res.type('text/xml').send(twiml.toString());
});

// STEP 4 — AIRTABLE LOOKUP
app.post('/lookup-property', async (req, res) => {
  const speech        = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits        = (req.body.Digits || '').trim();
  const spokenAddress = req.body.SpeechResult || '';
  const lang          = req.query.lang || 'en';
  const callerType    = req.query.type || 'Buyer';
  const callSid       = req.query.callSid || req.body.CallSid;
  const callerNumber  = req.body.From || '';
  const twiml         = new VoiceResponse();

  // If caller pressed 2 / said "something else" at address prompt → attention voicemail
  const isSomethingElse = digits === '2' || /something else|other|otro|otra|no|2/.test(speech) && speech.length < 30;
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

  try {
    // Search ALL listings regardless of status so we can distinguish
    // "no such property" from "property exists but is no longer available"
    const records = await base('ALL LISTINGS').select({
      fields: ['Address','Street Address','City','State','Zip code','Name','Phone','Email','BAC Offered','Commission NOTES','Type','List Price','Notes','prop_id','Status'],
    }).all();

    const listings = records.map(r => ({
      id: r.id, prop_id: r.get('prop_id') || '',
      address: r.get('Address') || r.get('Street Address') || '',
      city: r.get('City') || '',
      fullAddress: [r.get('Address') || r.get('Street Address'), r.get('City'), r.get('State'), r.get('Zip code')].filter(Boolean).join(', '),
      name: r.get('Name') || '', phone: r.get('Phone') || '', email: r.get('Email') || '',
      bac: r.get('BAC Offered') || '', commNotes: r.get('Commission NOTES') || '',
      type: r.get('Type') || '', price: r.get('List Price') || '', notes: r.get('Notes') || '',
      status: r.get('Status') || '',
    }));

    const fuse    = new Fuse(listings, { keys: ['address','fullAddress','city'], threshold: 0.45, includeScore: true });
    const results = fuse.search(spokenAddress);
    const match   = results.length > 0 ? results[0].item : null;

    const logFields = {
      Name: `Call ${new Date().toISOString()}`, Call_ID: callSid,
      Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
      Caller_Type: callerType, Language: lang === 'es' ? 'Spanish' : 'English',
      Property_Address: spokenAddress.trim(),
      // Caller consented by staying on the line past the FL two-party notice
      Notes: 'Caller consented to recording by continuing on the line (FL two-party notice played at greeting).',
    };

    if (match) {
      logFields.Real_Address  = match.fullAddress;
      logFields.Prop_ID       = match.prop_id;
      logFields.BAC_Disclosed = callerType === 'Realtor' ? match.bac : '';
      logFields.Listing_Link  = [{ id: match.id }];
    } else {
      logFields.Call_Disposition = 'No Match Found';
    }

    const logRecord = await base('CALL LOG').create(logFields);
    const logId     = logRecord.id;

    if (!match) {
      say(twiml, lang, lang === 'es'
        ? 'Lo sentimos, no encontramos esa propiedad. Por favor deje un mensaje.'
        : 'I\'m sorry, I couldn\'t find that property. Please leave a message and we\'ll follow up.');
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_match&lang=${lang}&callSid=${callSid}&logId=${logId}&attention=true`);
      return res.type('text/xml').send(twiml.toString());
    }

    // Status filter — only Active or Pending listings proceed to full flow
    const statusOk = /^active$|^pending$/i.test((match.status || '').trim());
    if (!statusOk) {
      await base('CALL LOG').update(logId, { Call_Disposition: 'No Match Found', Notes: `Property found but Status = "${match.status}" (not Active/Pending)` }).catch(console.error);

      say(twiml, lang, lang === 'es'
        ? 'Desafortunadamente esta propiedad ya no se encuentra disponible. Si desea dejar un mensaje, por favor hagalo despues del tono.'
        : 'Unfortunately this property is no longer available. If you want, you may leave a message after the tone.'
      );
      twiml.record({
        maxLength: 120, transcribe: true,
        transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=true`,
        action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
      });
      return res.type('text/xml').send(twiml.toString());
    }

    if (callerType === 'Realtor') {
      return realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId });
    } else {
      return buyerTenantFlow(res, twiml, { match, lang, callerNumber, callerType, callSid, logId });
    }
  } catch (err) {
    console.error('Lookup error:', err);
    say(twiml, lang, lang === 'es' ? 'Tenemos un problema tecnico. Por favor deje un mensaje.' : 'We\'re experiencing a technical issue. Please leave a message.');
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=error&lang=${lang}&callSid=${callSid}`);
    res.type('text/xml').send(twiml.toString());
  }
});

// ── FCHB SPECIAL CASE helper ─────────────────────────────────────────────────
const FCHB_EMAILS = ['kevin@floridacashhomebuyers.com', 'alejandro@floridacashhomebuyers.com'];

async function handleFCHB(res, twiml, { match, lang, logId }) {
  await base('CALL LOG').update(logId, {
    Call_Disposition: 'FCHB - Voicemail',
    Notes: 'FCHB property — routed directly to voicemail per account rule.',
  }).catch(console.error);

  say(twiml, lang, lang === 'es'
    ? 'Gracias. Por favor deje su mensaje detallado despues del tono y se lo haremos llegar al propietario de inmediato.'
    : 'Thank you. Please leave a detailed message after the tone and we will forward it to the property owner right away.'
  );
  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=false&sellerEmail=${encodeURIComponent(match.email)}`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  return res.type('text/xml').send(twiml.toString());
}
// ─────────────────────────────────────────────────────────────────────────────

// REALTOR FLOW — called after Realtor branch decision
function realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId }) {
  // FCHB check happens here — AFTER Realtor/Buyer branch, AFTER address is matched
  if (FCHB_EMAILS.includes((match.email || '').toLowerCase())) {
    return handleFCHB(res, twiml, { match, lang, logId });
  }

  const isRental = /rent|lease|alquil/i.test(match.type || '');

  // Sale: ask about showing to buyers. Rental: ask about showing to prospects.
  const prompt = lang === 'es'
    ? (isRental
        ? 'Encontre la propiedad. Tiene interes en mostrarla a sus posibles inquilinos, o en que le puedo ayudar?'
        : 'Encontre la propiedad. Tiene interes en mostrarla a sus compradores, o en que le puedo ayudar?')
    : (isRental
        ? 'Great, I found the property. Are you interested in showing it to your prospects, or how can I assist you?'
        : 'Great, I found the property. Are you interested in showing it to your buyers, or how can I assist you?');

  const gather = twiml.gather({
    input: 'speech', timeout: 10, speechTimeout: 'auto',
    language: VOICE[lang].language,
    action: `${process.env.BASE_URL}/realtor-response?lang=${lang}&callSid=${callSid}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&matchAddress=${encodeURIComponent(match.fullAddress)}&callerNumber=${encodeURIComponent(callerNumber)}&isRental=${isRental}`,
    method: 'POST',
  });

  gather.say(VOICE[lang], prompt);

  twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_response&lang=${lang}&callSid=${callSid}&logId=${logId}&matchAddress=${encodeURIComponent(match.fullAddress)}`);
  res.type('text/xml').send(twiml.toString());
}

// REALTOR RESPONSE — Claude AI
app.post('/realtor-response', async (req, res) => {
  const speech       = (req.body.SpeechResult || '').trim();
  const lang         = req.query.lang || 'en';
  const callSid      = req.query.callSid;
  const logId        = req.query.logId;
  const matchId      = req.query.matchId;
  const matchAddress = decodeURIComponent(req.query.matchAddress || '');
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');
  const isRental     = req.query.isRental === 'true';
  const twiml        = new VoiceResponse();

  const partyEN = isRental ? 'landlord' : 'seller';
  const partyES = isRental ? 'el propietario' : 'el vendedor';

  let listingContext = `{"address":"${matchAddress}"}`;
  try {
    const r = await base('ALL LISTINGS').find(matchId);
    listingContext = JSON.stringify({ address: r.get('Address') || r.get('Street Address'), city: r.get('City'), price: r.get('List Price'), type: r.get('Type'), bac: r.get('BAC Offered'), commNotes: r.get('Commission NOTES'), notes: r.get('Notes'), sellerName: r.get('Name') });
  } catch (e) {}

  try {
    const aiResp    = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 200, system: buildRealtorSystemPrompt(lang, listingContext), messages: [{ role: 'user', content: speech }] });
    const aiText    = aiResp.content[0].text.trim();
    const wantsShow = /show|showing|schedule|tuesday|monday|wednesday|thursday|friday|saturday|sunday|lunes|martes|jueves|viernes|sabado|domingo|\d+(am|pm)|disponible|mostrar/i.test(speech);

    await base('CALL LOG').update(logId, { Transcript: `Realtor: "${speech}"\nClaude: "${aiText}"`, Call_Disposition: wantsShow ? 'Transferred to Seller' : 'Voicemail Left' }).catch(console.error);

    say(twiml, lang, aiText);

    // Always offer SMS before transferring, whether showing or other seller question
    const smsGather = twiml.gather({
      input: 'speech dtmf', numDigits: 1, timeout: 5, language: VOICE[lang].language,
      action: `${process.env.BASE_URL}/send-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&type=Realtor&wantsShow=${wantsShow}`,
      method: 'POST',
    });
    smsGather.say(VOICE[lang], lang === 'es'
      ? `Le voy a transferir con ${partyES}, pero para que tenga la informacion a la mano, le puedo enviar la informacion de contacto por mensaje de texto? Oprima 1 o diga si.`
      : `I will transfer the call to the ${partyEN}, but just to make sure you have the information on hand, may I also text you the ${partyEN}'s contact information? Press 1 or say yes.`
    );

    // Always proceed to transfer
    twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}`);
  } catch (err) {
    console.error('Claude error:', err);
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=ai_error&lang=${lang}&callSid=${callSid}&logId=${logId}&attention=true`);
    // Also for no_match

  }
  res.type('text/xml').send(twiml.toString());
});

// BUYER / TENANT FLOW — called after Buyer branch decision
function buyerTenantFlow(res, twiml, { match, lang, callerNumber, callerType, callSid, logId }) {
  // FCHB check happens here — AFTER Realtor/Buyer branch, AFTER address is matched
  if (FCHB_EMAILS.includes((match.email || '').toLowerCase())) {
    return handleFCHB(res, twiml, { match, lang, logId });
  }

  const isRental = /rent|lease|alquil/i.test(match.type || '');
  const partyEN  = isRental ? 'landlord' : 'seller';
  const partyES  = isRental ? 'el propietario' : 'el vendedor';

  // Sale: connect with seller / Rental: connect with landlord
  // Both include "who handles showings scheduling directly"
  const prompt = lang === 'es'
    ? (isRental
        ? `Excelente, encontre la propiedad. Le voy a conectar directamente con ${partyES}, quien coordina las visitas directamente. Le puedo enviar los datos de contacto por mensaje de texto para tenerlos a la mano? Oprima 1 o diga si.`
        : `Excelente, encontre la propiedad. Le voy a conectar directamente con ${partyES}, quien coordina las visitas directamente. Le puedo enviar los datos de contacto por mensaje de texto para tenerlos a la mano? Oprima 1 o diga si.`)
    : (isRental
        ? `Great, I found the property. I will connect you directly with the ${partyEN}, who handles showing scheduling directly. May I also text you their contact information to have it on hand? Press 1 or say yes.`
        : `Great, I found the property. I will connect you directly with the ${partyEN}, who handles showing scheduling directly. May I also text you their contact information to have it on hand? Press 1 or say yes.`);

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 5, language: VOICE[lang].language,
    action: `${process.env.BASE_URL}/send-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&callerNumber=${encodeURIComponent(callerNumber)}&type=${callerType}&wantsShow=true`,
    method: 'POST',
  });

  gather.say(VOICE[lang], prompt);

  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(match.id)}&logId=${logId}`);
  res.type('text/xml').send(twiml.toString());
}

// SEND SMS
app.post('/send-sms', async (req, res) => {
  const speech       = (req.body.SpeechResult || '').toLowerCase();
  const digits       = (req.body.Digits || '').trim();
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId;
  const matchId      = decodeURIComponent(req.query.matchId || '');
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');
  const callerType   = req.query.type || 'Buyer';
  const wantsShow    = req.query.wantsShow === 'true';
  const twiml        = new VoiceResponse();
  const wantsText    = digits === '1' || /yes|si|yeah|sure|ok|claro/.test(speech);

  if (wantsText && callerNumber) {
    try {
      const r           = await base('ALL LISTINGS').find(matchId);
      const address     = r.get('Address') || r.get('Street Address') || '';
      const city        = r.get('City') || '';
      const sellerName  = r.get('Name') || '';
      const sellerPhone = r.get('Phone') || '';
      const sellerEmail = r.get('Email') || '';

      // Build message with optional buyer ad
      const isBuyer = callerType === 'Buyer' || callerType === 'Tenant';
      const buyerAdEN = isBuyer ? ' If you ever need to sell your property and potentially save the entire commission, visit us at www.SnapFlatFee.com ®' : '';
      const buyerAdES = isBuyer ? ' Para vender su propiedad y potencialmente ahorrar toda la comision visitenos en www.SnapFlatFee.com ®' : '';
      const msgBody = lang === 'es'
        ? 'La informacion solicitada: Propiedad: ' + address + ', ' + city + '. Telefono: ' + sellerPhone + '. Email: ' + sellerEmail + '. Attn: Jorge Zea - Broker - Realtor®.' + buyerAdES + ' Pueden aplicar tarifas de mensajes y datos. Responda STOP para cancelar. HELP para ayuda.'
        : 'The info you requested: Property: ' + address + ', ' + city + '. Phone: ' + sellerPhone + '. Email: ' + sellerEmail + '. Attn: Jorge Zea - Broker - Realtor®.' + buyerAdEN + ' Msg and data rates may apply. Reply STOP to opt out. HELP for help.';
      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER, to: callerNumber, body: msgBody,
      });

      await base('CALL LOG').update(logId, { SMS_Sent: true }).catch(console.error);
      const sellerSmsSent = await notifySeller({ record: r, callerNumber, callerType, address, city });
      if (sellerSmsSent && logId) {
        await base('CALL LOG').update(logId, { Seller_SMS_Sent: true }).catch(console.error);
      }

      say(twiml, lang, lang === 'es' ? 'Perfecto, le acabo de enviar la informacion por mensaje de texto.' : 'Perfect, I just sent the information to your phone.');
    } catch (err) { console.error('SMS error:', err); }
  }

  twiml.redirect(wantsShow
    ? `${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}&smsSent=${wantsText}`
    : `${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=realtor_other`
  );
  res.type('text/xml').send(twiml.toString());
});

// TRANSFER TO SELLER — with 2nd leg recording + seller whisper consent
app.post('/transfer-seller', async (req, res) => {
  const lang    = req.query.lang || 'en';
  const matchId = decodeURIComponent(req.query.matchId || '');
  const logId   = req.query.logId;
  const smsSent = req.query.smsSent === 'true';
  const twiml   = new VoiceResponse();

  try {
    const r           = await base('ALL LISTINGS').find(matchId);
    const sellerPhone = r.get('Phone') || '';
    const listingType = (r.get('Type') || '').toLowerCase();
    const isRental    = listingType.includes('rent') || listingType.includes('lease');

    if (sellerPhone) {
      // Handover message to caller
      if (lang === 'es') {
        const party   = isRental ? 'el propietario' : 'el vendedor';
        const Party   = isRental ? 'El propietario' : 'El vendedor';
        const smsPart = smsSent ? ' Por favor revise sus mensajes de texto tambien.' : '';
        say(twiml, 'es',
          `Le transferimos ahora con ${party}. ${Party} coordina las visitas directamente y puede proveerle informacion adicional.${smsPart} Un momento por favor.`
        );
      } else {
        const party   = isRental ? 'the landlord' : 'the seller';
        const Party   = isRental ? 'The landlord' : 'The seller';
        const smsPart = smsSent ? ' Please check your text messages as well.' : '';
        say(twiml, 'en',
          `We are now transferring your call to ${party}. ${Party} is coordinating showings directly and can provide additional information.${smsPart} One moment please.`
        );
      }

      // Dial with 2nd leg recording + seller whisper for consent
      // action fires when dial ends (seller unavailable, no answer, voicemail detected)
      const dial = twiml.dial({
        record: 'record-from-answer-dual-channel',
        recordingStatusCallback: `${process.env.BASE_URL}/second-leg-recording?logId=${logId}`,
        recordingStatusCallbackMethod: 'POST',
        action: `${process.env.BASE_URL}/seller-unavailable?lang=${lang}&logId=${logId}`,
        method: 'POST',
      });

      dial.number({
        url: `${process.env.BASE_URL}/seller-whisper?lang=${lang}&isRental=${isRental}`,
        statusCallback: `${process.env.BASE_URL}/seller-status?logId=${logId}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: 'answered completed',
      }, sellerPhone);

      await base('CALL LOG').update(logId, {
        Call_Disposition: 'Transferred to Seller',
        Seller_Notified: true,
      }).catch(console.error);

    } else {
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_seller_phone&lang=${lang}&logId=${logId}`);
    }
  } catch (err) {
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=transfer_error&lang=${lang}&logId=${logId}`);
  }
  res.type('text/xml').send(twiml.toString());
});

// SELLER WHISPER — plays to seller only before connecting — always English
app.post('/seller-whisper', (req, res) => {
  const isRental = req.query.isRental === 'true';
  const twiml    = new VoiceResponse();

  const party = isRental ? 'a potential tenant' : 'a potential buyer or Realtor';

  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 8,
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'yes, accept, ok, 1',
    action: `${process.env.BASE_URL}/seller-consent`,
    method: 'POST',
  });

  gather.say(VOICE.en,
    `You have an incoming call from SnapFlatFee.com regarding your listing. ` +
    `You will be connected with ${party}. ` +
    `This call will be recorded for quality and compliance purposes. ` +
    `Say OK or press 1 to accept and connect.`
  );

  // If seller doesn't respond → hang up, dial action fires seller-unavailable
  say(twiml, 'en', 'No response received. The caller will be notified.');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

// SELLER UNAVAILABLE — fires when dial ends (action on <Dial>)
// Uses DialCallStatus + DialCallDuration for smart routing:
//   completed ≥20s → real conversation ended normally → say goodbye
//   no-answer/busy/failed/canceled → definite no answer → our voicemail
//   completed <20s → seller voicemail likely answered whisper → our voicemail
app.post('/seller-unavailable', async (req, res) => {
  const lang         = req.query.lang || 'en';
  const logId        = req.query.logId || '';
  const dialStatus   = req.body.DialCallStatus || '';
  const dialDuration = parseInt(req.body.DialCallDuration || '0', 10);
  const twiml        = new VoiceResponse();

  // Real completed call (≥20s) — recording already captured by dual-channel recorder
  // and second-leg-recording callback. Just hang up silently; nothing more needed.
  if (dialStatus === 'completed' && dialDuration >= 20) {
    if (logId) await base('CALL LOG').update(logId, { Call_Disposition: 'Completed' }).catch(console.error);
    // Empty response — call is already over, recording saves async via recordingStatusCallback
    return res.type('text/xml').send('<Response><Hangup/></Response>');
  }

  // No-answer, busy, failed, canceled, OR short completed (seller VM answered whisper)
  // → Route caller into OUR voicemail so message reaches seller properly
  if (logId) {
    await base('CALL LOG').update(logId, {
      Call_Disposition: `Seller Unavailable (${dialStatus || 'unknown'})`,
      Seller_Accepted_Call: false,
    }).catch(console.error);
  }

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 8, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es' ? 'uno, dos, 1, 2, mensaje' : 'one, two, 1, 2, message',
    action: `${process.env.BASE_URL}/unavailable-choice?lang=${lang}&logId=${logId}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say(VOICE.es,
      'El vendedor no esta disponible en este momento. ' +
      'Para dejar un mensaje que le haremos llegar directamente, oprima 1. ' +
      'O puede contactar al vendedor con la informacion que le enviamos por mensaje de texto, oprima 2.'
    );
  } else {
    gather.say(VOICE.en,
      'The seller is not available at this moment. ' +
      'To leave a message that we will forward directly to the seller, press 1. ' +
      'Or you can contact the seller using the information we texted you, press 2.'
    );
  }

  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=seller_unavailable`);
  res.type('text/xml').send(twiml.toString());
});

// UNAVAILABLE CHOICE — voicemail or hang up
app.post('/unavailable-choice', (req, res) => {
  const digits = (req.body.Digits || '').trim();
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const lang   = req.query.lang || 'en';
  const logId  = req.query.logId || '';
  const twiml  = new VoiceResponse();

  const wantsHangup = digits === '2' || /two|dos|direct|contact|text|2/.test(speech);

  if (wantsHangup) {
    say(twiml, lang, lang === 'es'
      ? 'Perfecto. Tiene toda la informacion en su telefono. Que tenga un buen dia.'
      : 'Perfect. You have all the information on your phone. Have a great day.'
    );
    twiml.hangup();
  } else {
    // Press 1 or default → voicemail for seller
    twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&logId=${logId}&reason=seller_unavailable`);
  }

  res.type('text/xml').send(twiml.toString());
});

// SELLER CONSENT — confirmed, connect the call
app.post('/seller-consent', (req, res) => {
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const digits = (req.body.Digits || '').trim();
  const lang   = req.query.lang || 'en';
  const twiml  = new VoiceResponse();

  const accepted = digits === '1' || /yes|ok|si|sí|aceptar|accept/.test(speech);

  if (accepted) {
    // Empty response = connect the call
    res.type('text/xml').send('<Response></Response>');
  } else {
    say(twiml, lang, lang === 'es'
      ? 'Llamada no aceptada. Gracias.'
      : 'Call not accepted. Thank you.'
    );
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// SECOND LEG RECORDING STATUS — saves recording URL to Airtable
app.post('/second-leg-recording', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || '';
  const duration     = req.body.RecordingDuration || 0;
  const logId        = req.query.logId || '';

  if (logId && recordingUrl) {
    await base('CALL LOG').update(logId, {
      Second_Leg_Recording_URL: recordingUrl,
    }).catch(console.error);
  }
  res.sendStatus(200);
});

// SELLER STATUS — tracks if seller answered or declined
app.post('/seller-status', async (req, res) => {
  const callStatus = req.body.CallStatus || '';
  const logId      = req.query.logId || '';

  if (logId) {
    const answered = callStatus === 'completed' || callStatus === 'answered';
    await base('CALL LOG').update(logId, {
      Seller_Accepted_Call: answered,
    }).catch(console.error);
  }
  res.sendStatus(200);
});

// VOICEMAIL — creates a CALL LOG record if one doesn't exist yet (no-address / other paths)
app.post('/voicemail', async (req, res) => {
  const lang         = req.query.lang || 'en';
  const matchAddress = decodeURIComponent(req.query.matchAddress || '');
  let   logId        = req.query.logId || '';
  const attention    = req.query.attention || 'false';
  const callSid      = req.body.CallSid || req.query.callSid || '';
  const callerNumber = req.body.From || '';
  const reason       = req.query.reason || '';
  const twiml        = new VoiceResponse();

  // Create a CALL LOG record if we don't have one yet (no-address / other / timeout paths)
  if (!logId && callSid) {
    try {
      const logRecord = await base('CALL LOG').create({
        Name:             `Call ${new Date().toISOString()}`,
        Call_ID:          callSid,
        Call_Date:        new Date().toISOString(),
        Caller_Number:    callerNumber,
        Caller_Type:      req.query.type || 'Unknown',
        Language:         lang === 'es' ? 'Spanish' : 'English',
        Property_Address: 'No Address',
        Call_Disposition: 'Voicemail Left',
        Notes:            `Reason: ${reason}. Caller consented to recording by continuing on the line (FL two-party notice played at greeting).`,
      });
      logId = logRecord.id;
    } catch (err) {
      console.error('Voicemail log creation error:', err);
    }
  }

  const context = matchAddress ? (lang === 'es' ? ` Sobre: ${matchAddress}.` : ` Regarding: ${matchAddress}.`) : '';

  say(twiml, lang, lang === 'es'
    ? `Por favor deje su mensaje despues del tono.${context} Le contactaremos a la brevedad.`
    : `Please leave your message after the tone.${context} We'll get back to you shortly.`
  );

  twiml.record({
    maxLength: 120, transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}&lang=${lang}&attention=${attention}`,
    action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
  });
  res.type('text/xml').send(twiml.toString());
});

app.post('/voicemail-transcribed', async (req, res) => {
  const transcript   = req.body.TranscriptionText || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const callSid      = req.body.CallSid || '';
  const logId        = req.query.logId || '';
  const lang         = req.query.lang || 'en';
  const sellerEmail  = req.query.sellerEmail ? decodeURIComponent(req.query.sellerEmail) : '';
  const isAttention  = req.query.attention === 'true';

  // Update CALL LOG with transcript + recording
  if (logId) {
    await base('CALL LOG').update(logId, {
      Transcript:        transcript,
      Voicemail_URL:     recordingUrl,
      Call_Disposition:  'Voicemail Left',
    }).catch(console.error);
  }

  // If FCHB: email directly to seller (not snapflatfee2)
  if (sellerEmail) {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: `Voicemail received for your listing`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">📞 Voicemail — Blue Lighthouse Realty</h2>
        <p><b>Time:</b> ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}</p>
        <p><b>Call SID:</b> ${callSid}</p>
        <p><b>Recording:</b> <a href="${recordingUrl}">Listen</a></p>
        <h3>Transcript</h3>
        <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript || 'Pending...'}</p>
        <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p>
      </div>`,
    }).catch(console.error);
  } else {
    // Normal flow: attention flag decides inbox
    await mailer.sendMail({
      from: process.env.EMAIL_FROM,
      to:   isAttention ? 'snapflatfee2@gmail.com' : process.env.EMAIL_TO,
      subject: isAttention
        ? 'Call from IVR - needs attention'
        : `📞 New Voicemail — ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">📞 New Voicemail — Blue Lighthouse Realty</h2>
        <p><b>Time:</b> ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}</p>
        <p><b>Language:</b> ${lang === 'es' ? 'Spanish' : 'English'}</p>
        <p><b>Call SID:</b> ${callSid}</p>
        <p><b>Recording:</b> <a href="${recordingUrl}">Listen</a></p>
        <h3>Transcript</h3>
        <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript || 'Pending...'}</p>
      </div>`,
    }).catch(console.error);
  }

  res.sendStatus(200);
});

app.post('/voicemail-done', (req, res) => {
  const lang  = req.query.lang || 'en';
  const twiml = new VoiceResponse();
  say(twiml, lang, lang === 'es' ? 'Gracias. Hasta pronto.' : 'Thank you. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ─── AFTER-HOURS VOICEMAIL TRANSCRIBED ───────────────────────────────────────
// Tries to detect a property address from the transcript. If found, emails
// the seller only (no SMS, per after-hours policy). If not found, routes
// the lead to your attention inbox instead.
app.post('/afterhours-transcribed', async (req, res) => {
  const transcript   = req.body.TranscriptionText || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const callSid      = req.body.CallSid || '';
  const callerNumber = req.body.From || '';

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

    const fuse = new Fuse(listings, { keys: ['address','fullAddress','city'], threshold: 0.45, includeScore: true });
    const results = fuse.search(transcript);
    const match = results.length > 0 ? results[0].item : null;

    // Log to CALL LOG regardless of match
    const logRecord = await base('CALL LOG').create({
      Name: `After-Hours Call ${new Date().toISOString()}`,
      Call_ID: callSid,
      Call_Date: new Date().toISOString(),
      Caller_Number: callerNumber,
      Caller_Type: 'Unknown',
      Property_Address: transcript,
      Transcript: transcript,
      Voicemail_URL: recordingUrl,
      Call_Disposition: match ? 'Voicemail Left' : 'No Match Found',
      Real_Address: match ? match.fullAddress : '',
      Listing_Link: match ? [{ id: match.id }] : undefined,
    }).catch(err => { console.error('After-hours log error:', err); return null; });

    if (match && match.email) {
      // Email seller only — no SMS for after-hours leads
      await mailer.sendMail({
        from: process.env.EMAIL_FROM, to: match.email,
        subject: `Lead call received after hours. Ref: ${match.fullAddress}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#003087;">Call Notification — Blue Lighthouse Realty</h2>
          <p>Dear ${match.name || 'Seller'},</p>
          <p>We received an after-hours call about your property at <strong>${match.fullAddress}</strong>.</p>
          <p>Caller number: <strong>${callerNumber}</strong></p>
          <p><i>Received after hours.</i></p>
          <h3>Voicemail Transcript</h3>
          <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript}</p>
          <br/><p>Attn: Jorge Zea at SnapFlatFee.com</p>
        </div>`,
      }).catch(console.error);
    } else {
      // No address match — route to attention inbox
      await mailer.sendMail({
        from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
        subject: 'IVR - After hours call',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#003087;">📞 After-Hours Voicemail — No Property Match</h2>
          <p><b>Time:</b> ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}</p>
          <p><b>Caller:</b> ${callerNumber}</p>
          <p><b>Recording:</b> <a href="${recordingUrl}">Listen</a></p>
          <h3>Transcript</h3>
          <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript || 'Pending...'}</p>
        </div>`,
      }).catch(console.error);
    }
  } catch (err) {
    console.error('After-hours processing error:', err);
    await mailer.sendMail({
      from: process.env.EMAIL_FROM, to: 'snapflatfee2@gmail.com',
      subject: 'IVR - After hours call',
      html: `<p>After-hours voicemail received. Error processing address match.</p>
        <p>Caller: ${callerNumber}</p>
        <p>Recording: <a href="${recordingUrl}">Listen</a></p>
        <p>Transcript: ${transcript}</p>`,
    }).catch(console.error);
  }

  res.sendStatus(200);
});

async function notifySeller({ record, callerNumber, callerType, address, city }) {
  const sellerEmail  = record.get('Email');
  const sellerPhone  = record.get('Phone');
  const sellerName   = record.get('Name') || 'Seller';

  // Consent check: Airtable SMS_Recording_Consent = YES only
  const airtableConsent = (record.get('SMS_Recording_Consent') || '').toString().toUpperCase() === 'YES';
  const smsConsent = airtableConsent;

  // Caller label for email and SMS
  const callerLabel    = callerType === 'Realtor' ? 'a Realtor' : 'a Direct Buyer';
  const callerLabelSMS = callerType === 'Realtor' ? 'Realtor' : 'Direct Buyer';

  // Always send email to seller (English only)
  if (sellerEmail) {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: `Lead call received. Ref: ${address}, ${city}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">Call Notification — Blue Lighthouse Realty</h2>
        <p>Dear ${sellerName},</p>
        <p>${callerLabel.charAt(0).toUpperCase() + callerLabel.slice(1)} called asking about your property at <strong>${address}, ${city}</strong>.</p>
        <p>Caller number: <strong>${callerNumber}</strong></p>
        <p>Please feel free to follow up directly at your convenience.</p>
        <br/><p>Attn: Jorge Zea at SnapFlatFee.com®</p>
      </div>`,
    }).catch(console.error);
  }

  // SMS to seller only if consented (Jotform OR Airtable SMS_Recording_Consent = YES)
  if (sellerPhone && smsConsent) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   sellerPhone,
      body: `Lead alert from www.SnapFlatFee.com®. We received the following call about your property: ${address}, ${city}. From a ${callerLabelSMS}. Caller's phone number: ${callerNumber}. Attn: Jorge Zea - Broker - Realtor® Msg and data rates may apply. Reply STOP to opt out. HELP for help.`,
    }).catch(console.error);
    return true; // seller SMS was sent
  }
  return false; // no seller SMS
}

function buildRealtorSystemPrompt(lang, listingContext) {
  const rules = `
PROPERTY DATA: ${listingContext}

ONLY discuss: (1) this specific property, (2) showing scheduling, (3) commission policy as defined below.
NEVER: discuss other properties, negotiate commission amounts, give legal/financial advice, comment on NAR/MLS/competitors, go off-topic.

If showing intent: confirm warmly and say you will transfer to the seller.
If commission asked: say exactly — "The seller is not offering compensation in advance of an offer. The seller might consider helping the buyer pay your agreed fee, but it will depend on the strength and all terms of the offer. When would you like to show the property?"
If Realtor asks about property details not in the data: say — "All details should be in the MLS. If there is something additional you need about the property, I can transfer you to the seller directly."
For anything else: transfer to seller.
Maximum 2 sentences per response. Professional, warm, neutral.`;

  return lang === 'es'
    ? `Eres el asistente de Jorge Zea, Corredor de Bienes Raices. Responde SIEMPRE en español.\n${rules}`
    : `You are the assistant for Jorge Zea, Real Estate Broker. Respond ONLY in English.\n${rules}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏠 Blue Lighthouse IVR v2.0 running on port ${PORT}`));

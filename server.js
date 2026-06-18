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

// ─── API: Get all conversations (unique numbers from CALL LOG) ───────────────
app.get('/api/conversations', async (req, res) => {
  try {
    const records = await base('CALL LOG').select({
      sort: [{ field: 'Call_Date', direction: 'desc' }],
      maxRecords: 200,
      fields: ['Call_Date','Caller_Number','Caller_Type','Language',
               'Real_Address','Property_Address','Transcript','SMS_Sent'],
    }).all();

    // Group by caller number — one entry per unique number
    const seen = new Map();
    records.forEach(r => {
      const num = r.get('Caller_Number') || '';
      if (!num) return;
      if (!seen.has(num)) {
        seen.set(num, {
          number:      num,
          type:        r.get('Caller_Type') || 'unknown',
          property:    r.get('Real_Address') || r.get('Property_Address') || '',
          lastMessage: r.get('Transcript') ? r.get('Transcript').slice(0, 80) : 'Call received',
          lastTime:    r.get('Call_Date') || new Date().toISOString(),
          unread:      false,
        });
      }
    });

    res.json({ conversations: Array.from(seen.values()) });
  } catch (err) {
    console.error('Conversations API error:', err);
    res.status(500).json({ error: err.message });
  }
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

// STEP 1 — INBOUND: FL two-party consent + dual-language greeting
app.post('/inbound', (req, res) => {
  const twiml = new VoiceResponse();

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

// STEP 2 — LANGUAGE SELECTION
app.post('/select-language', (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const callSid = req.body.CallSid;
  const lang    = (digits === '2' || /espa|spanish|dos|2/.test(speech)) ? 'es' : 'en';
  const twiml   = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 6, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es'
      ? 'Realtor, agente, comprador, inquilino, otro, uno, dos, tres, 1, 2, 3'
      : 'Realtor, agent, buyer, tenant, other, one, two, three, 1, 2, 3',
    action: `${process.env.BASE_URL}/caller-type?lang=${lang}&callSid=${callSid}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say(VOICE.es,
      'Es usted un Realtor o agente de bienes raices? Oprima 1 o diga Realtor. ' +
      'Es usted un posible comprador o inquilino? Oprima 2 o diga comprador. ' +
      'Para cualquier otra consulta, oprima 3 o diga otro.'
    );
  } else {
    gather.say(VOICE.en,
      'Are you a Realtor or real estate agent? Press 1 or say Realtor. ' +
      'Are you an interested buyer or tenant? Press 2 or say buyer. ' +
      'For anything else, press 3 or say other.'
    );
  }

  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_input&callSid=${callSid}`);
  res.type('text/xml').send(twiml.toString());
});

// STEP 3 — CALLER TYPE → ASK FOR ADDRESS
app.post('/caller-type', (req, res) => {
  const speech     = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits     = (req.body.Digits || '').trim();
  const lang       = req.query.lang || 'en';
  const callSid    = req.query.callSid || req.body.CallSid;
  const twiml      = new VoiceResponse();

  // Option 3 — anything else → attention voicemail
  const isOther = digits === '3' || /other|otro|else|otra|3/.test(speech);
  if (isOther) {
    say(twiml, lang, lang === 'es'
      ? 'Por favor deje su mensaje despues del tono y le contactaremos a la brevedad.'
      : 'Please leave your message after the tone and we will get back to you shortly.'
    );
    twiml.record({
      maxLength: 120, transcribe: true,
      transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=&lang=${lang}&attention=true`,
      action: `${process.env.BASE_URL}/voicemail-done?lang=${lang}`, method: 'POST',
    });
    return res.type('text/xml').send(twiml.toString());
  }

  const isRealtor  = digits === '1' || /realtor|agent|agente|broker|1/.test(speech);
  const isTenant   = /tenant|inquilino|rent|alquil/.test(speech);
  const callerType = isRealtor ? 'Realtor' : (isTenant ? 'Tenant' : 'Buyer');

  const gather = twiml.gather({
    input: 'speech', timeout: 8, speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: 'street, avenue, boulevard, drive, court, calle, avenida',
    action: `${process.env.BASE_URL}/lookup-property?lang=${lang}&type=${callerType}&callSid=${callSid}`,
    method: 'POST',
  });

  gather.say(VOICE[lang],
    lang === 'es'
      ? 'Gracias. Sobre que propiedad nos llama? Por favor diga la direccion completa.'
      : 'Thank you. What property are you calling about? Please say the full address.'
  );

  twiml.redirect(`${process.env.BASE_URL}/voicemail?lang=${lang}&reason=no_address&type=${callerType}&callSid=${callSid}`);
  res.type('text/xml').send(twiml.toString());
});

// STEP 4 — AIRTABLE LOOKUP
app.post('/lookup-property', async (req, res) => {
  const spokenAddress = (req.body.SpeechResult || '').trim();
  const lang          = req.query.lang || 'en';
  const callerType    = req.query.type || 'Buyer';
  const callSid       = req.query.callSid || req.body.CallSid;
  const callerNumber  = req.body.From || '';
  const twiml         = new VoiceResponse();

  try {
    const records = await base('ALL LISTINGS').select({
      filterByFormula: `OR({Status}='Active',{Status}='Coming Soon')`,
      fields: ['Address','Street Address','City','State','Zip code','Name','Phone','Email','BAC Offered','Commission NOTES','Type','List Price','Notes','prop_id'],
    }).all();

    const listings = records.map(r => ({
      id: r.id, prop_id: r.get('prop_id') || '',
      address: r.get('Address') || r.get('Street Address') || '',
      city: r.get('City') || '',
      fullAddress: [r.get('Address') || r.get('Street Address'), r.get('City'), r.get('State'), r.get('Zip code')].filter(Boolean).join(', '),
      name: r.get('Name') || '', phone: r.get('Phone') || '', email: r.get('Email') || '',
      bac: r.get('BAC Offered') || '', commNotes: r.get('Commission NOTES') || '',
      type: r.get('Type') || '', price: r.get('List Price') || '', notes: r.get('Notes') || '',
    }));

    const fuse    = new Fuse(listings, { keys: ['address','fullAddress','city'], threshold: 0.45, includeScore: true });
    const results = fuse.search(spokenAddress);
    const match   = results.length > 0 ? results[0].item : null;

    const logFields = {
      Name: `Call ${new Date().toISOString()}`, Call_ID: callSid,
      Call_Date: new Date().toISOString(), Caller_Number: callerNumber,
      Caller_Type: callerType, Language: lang === 'es' ? 'Spanish' : 'English',
      Property_Address: spokenAddress,
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

// REALTOR FLOW
function realtorFlow(res, twiml, { match, lang, callerNumber, callSid, logId }) {
  const commNote = match.commNotes ? ` ${match.commNotes}` : '';
  const gather = twiml.gather({
    input: 'speech', timeout: 10, speechTimeout: 'auto',
    language: VOICE[lang].language,
    action: `${process.env.BASE_URL}/realtor-response?lang=${lang}&callSid=${callSid}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&matchAddress=${encodeURIComponent(match.fullAddress)}&callerNumber=${encodeURIComponent(callerNumber)}`,
    method: 'POST',
  });

  gather.say(VOICE[lang], lang === 'es'
    ? `Encontre la propiedad en ${match.fullAddress}. El vendedor no esta ofreciendo una comision antes de recibir una oferta.${commNote} Le gustaria mostrar esta propiedad a sus compradores? Cuando estaria disponible?`
    : `I found the property at ${match.fullAddress}. The seller is not offering a commission in advance of an offer.${commNote} Would you like to show this property to your buyers? When would you be available?`
  );

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
  const twiml        = new VoiceResponse();

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

    const smsGather = twiml.gather({
      input: 'speech dtmf', numDigits: 1, timeout: 5, language: VOICE[lang].language,
      action: `${process.env.BASE_URL}/send-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&type=Realtor&wantsShow=${wantsShow}`,
      method: 'POST',
    });
    smsGather.say(VOICE[lang], lang === 'es' ? 'Le envio la informacion de contacto por mensaje de texto? Oprima 1 o diga si.' : 'May I text you the seller\'s contact information? Press 1 or say yes.');

    twiml.redirect(wantsShow
      ? `${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}`
      : `${process.env.BASE_URL}/voicemail?reason=realtor_other&lang=${lang}&callSid=${callSid}&logId=${logId}&matchAddress=${encodeURIComponent(matchAddress)}`
    );
  } catch (err) {
    console.error('Claude error:', err);
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=ai_error&lang=${lang}&callSid=${callSid}&logId=${logId}&attention=true`);
    // Also for no_match

  }
  res.type('text/xml').send(twiml.toString());
});

// BUYER / TENANT FLOW
function buyerTenantFlow(res, twiml, { match, lang, callerNumber, callerType, callSid, logId }) {
  const gather = twiml.gather({
    input: 'speech dtmf', numDigits: 1, timeout: 5, language: VOICE[lang].language,
    action: `${process.env.BASE_URL}/send-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&callerNumber=${encodeURIComponent(callerNumber)}&type=${callerType}&wantsShow=true`,
    method: 'POST',
  });

  gather.say(VOICE[lang], lang === 'es'
    ? `Encontre la propiedad en ${match.fullAddress}. Voy a transferirle con el vendedor. Le envio tambien la informacion de contacto por mensaje de texto? Oprima 1 o diga si.`
    : `I found the property at ${match.fullAddress}. I'll connect you with the seller directly. May I also text you their contact information in case the line is busy? Press 1 or say yes.`
  );

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
      await notifySeller({ record: r, callerNumber, callerType, address, city });

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
      const dial = twiml.dial({
        record: 'record-from-answer-dual-channel',
        recordingStatusCallback: `${process.env.BASE_URL}/second-leg-recording?logId=${logId}`,
        recordingStatusCallbackMethod: 'POST',
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

// SELLER WHISPER — plays to seller only before connecting, captures consent
app.post('/seller-whisper', (req, res) => {
  const lang     = req.query.lang || 'en';
  const isRental = req.query.isRental === 'true';
  const twiml    = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 8,
    speechTimeout: 'auto',
    language: VOICE[lang].language,
    hints: lang === 'es' ? 'si, aceptar, ok, 1' : 'yes, accept, ok, 1',
    action: `${process.env.BASE_URL}/seller-consent?lang=${lang}`,
    method: 'POST',
  });

  if (lang === 'es') {
    const party = isRental ? 'su inquilino potencial' : 'un posible comprador o Realtor';
    gather.say(VOICE.es,
      `Tiene una llamada entrante de SnapFlatFee.com sobre su propiedad. ` +
      `Se conectara con ${party}. ` +
      `Esta llamada sera grabada con fines de calidad y cumplimiento. ` +
      `Diga OK o oprima 1 para aceptar y conectarse.`
    );
  } else {
    const party = isRental ? 'a potential tenant' : 'a potential buyer or Realtor';
    gather.say(VOICE.en,
      `You have an incoming call from SnapFlatFee.com regarding your listing. ` +
      `You will be connected with ${party}. ` +
      `This call will be recorded for quality and compliance purposes. ` +
      `Say OK or press 1 to accept and connect.`
    );
  }

  // If no response — hang up gracefully
  say(twiml, lang, lang === 'es'
    ? 'No recibimos respuesta. La llamada sera enviada al buzon de voz.'
    : 'No response received. The call will be sent to voicemail.'
  );
  twiml.hangup();

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

// VOICEMAIL
app.post('/voicemail', (req, res) => {
  const lang         = req.query.lang || 'en';
  const matchAddress = decodeURIComponent(req.query.matchAddress || '');
  const logId        = req.query.logId || '';
  const attention    = req.query.attention || 'false';
  const twiml        = new VoiceResponse();
  const context      = matchAddress ? (lang === 'es' ? ` Sobre: ${matchAddress}.` : ` Regarding: ${matchAddress}.`) : '';

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

  if (logId) await base('CALL LOG').update(logId, { Transcript: transcript, Voicemail_URL: recordingUrl, Call_Disposition: 'Voicemail Left' }).catch(console.error);

  await mailer.sendMail({
    from: process.env.EMAIL_FROM, to: req.query.attention === 'true' ? 'snapflatfee2@gmail.com' : process.env.EMAIL_TO,
    subject: req.query.attention === 'true' ? 'Call from IVR - needs attention' : `📞 New Voicemail — ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})}`,
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
  res.sendStatus(200);
});

app.post('/voicemail-done', (req, res) => {
  const lang  = req.query.lang || 'en';
  const twiml = new VoiceResponse();
  say(twiml, lang, lang === 'es' ? 'Gracias. Hasta pronto.' : 'Thank you. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

async function notifySeller({ record, callerNumber, callerType, address, city }) {
  const sellerEmail  = record.get('Email');
  const sellerPhone  = record.get('Phone');
  const sellerName   = record.get('Name') || 'Seller';
  const smsConsent   = (record.get('SMS') || '').toString().toLowerCase().includes('agree (yes'); // Jotform value
  const callerLabel  = callerType === 'Realtor' ? 'a Realtor' : `a potential ${callerType.toLowerCase()}`;

  // Always send email to seller
  if (sellerEmail) {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM, to: sellerEmail,
      subject: `Lead call received. Ref: ${address}, ${city}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">Call Notification — Blue Lighthouse Realty</h2>
        <p>Dear ${sellerName},</p>
        <p>A ${callerLabel} called asking about your property at <strong>${address}, ${city}</strong>.</p>
        <p>Caller number: <strong>${callerNumber}</strong></p>
        <p>Please feel free to follow up directly at your convenience.</p>
        <br/><p>Attn: Jorge Zea at SnapFlatFee.com</p>
      </div>`,
    }).catch(console.error);
  }

  // SMS to seller only if they consented via form (SMS checkbox = true)
  if (sellerPhone && smsConsent) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   sellerPhone,
      body: `Lead alert from www.SnapFlatFee.com. We received the following call about your property: ${address}, ${city}. Caller's phone number: ${callerNumber}. Attn: Jorge Zea - Broker - Realtor® Msg and data rates may apply. Reply STOP to opt out. HELP for help.`,
    }).catch(console.error);
  }
}

function buildRealtorSystemPrompt(lang, listingContext) {
  const rules = `
PROPERTY DATA: ${listingContext}

ONLY discuss: (1) this specific property, (2) showing scheduling, (3) commission policy: seller NOT offering commission in advance of an offer.
NEVER: discuss other properties, negotiate commission, give legal/financial advice, comment on NAR/MLS/competitors, go off-topic.
If showing intent: confirm warmly, say you will transfer to the seller.
If commission asked: say exactly "The seller is not offering a commission in advance of an offer."
If anything else: "For that I'll transfer you to Jorge Zea's voicemail."
Maximum 2 sentences. Professional, warm, neutral.`;

  return lang === 'es'
    ? `Eres el asistente de Jorge Zea, Corredor de Bienes Raices. Responde SIEMPRE en español.\n${rules}`
    : `You are the assistant for Jorge Zea, Real Estate Broker. Respond ONLY in English.\n${rules}`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏠 Blue Lighthouse IVR v2.0 running on port ${PORT}`));

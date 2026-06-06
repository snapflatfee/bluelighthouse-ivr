/**
 * Jorge Zea | Blue Lighthouse Realty
 * Twilio IVR + Claude AI + Airtable Webhook Server
 * ─────────────────────────────────────────────────
 * Handles: Inbound calls, language detection, Realtor/Buyer routing,
 *          Airtable lookup, Claude AI responses, SMS, voicemail,
 *          call logging, seller notifications.
 */

const express = require('express');
const twilio  = require('twilio');
const Airtable = require('airtable');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const Fuse = require('fuse.js');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─── Clients ────────────────────────────────────────────────────────────────
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Email (Gmail SMTP via App Password) ────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 1 — INBOUND CALL GREETING
// ════════════════════════════════════════════════════════════════════════════
app.post('/inbound', (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech dtmf',
    timeout: 5,
    speechTimeout: 'auto',
    language: 'en-US',           // Detect English first; Spanish handled in /caller-type
    hints: 'Realtor, buyer, tenant, comprador, inquilino, agente',
    action: `${process.env.BASE_URL}/caller-type`,
    method: 'POST',
  });

  gather.say({
    voice: process.env.VOICE_EN || 'Polly.Matthew-Neural',
    language: 'en-US',
  },
    'Thank you for calling Jorge Zea, Licensed Real Estate Broker. ' +
    'This call will be recorded. ' +
    'Puede hablar en español si lo prefiere. ' +
    'Are you a Realtor — or an interested buyer or tenant? ' +
    '¿Es usted un Realtor, o un posible comprador o inquilino?'
  );

  // Fallback if no input
  twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_input`);

  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 2 — DETECT CALLER TYPE (Realtor vs Buyer/Tenant) + LANGUAGE
// ════════════════════════════════════════════════════════════════════════════
app.post('/caller-type', async (req, res) => {
  const speech  = (req.body.SpeechResult || '').toLowerCase().trim();
  const digits  = (req.body.Digits || '').trim();
  const callSid = req.body.CallSid;

  // Detect language from speech
  const isSpanish = /comprador|inquilino|agente|soy|quiero|busco|tengo|español/.test(speech);
  const lang      = isSpanish ? 'es' : 'en';

  // Detect caller type
  const isRealtor = /realtor|agent|agente|broker|realty|realtors|1/.test(speech + digits);
  const isTenant  = /tenant|renter|rent|inquilino|arrendar|alquil/.test(speech);
  const callerType = isRealtor ? 'Realtor' : (isTenant ? 'Tenant' : 'Buyer');

  // Store in session via URL params
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    timeout: 6,
    speechTimeout: 'auto',
    language: isSpanish ? 'es-US' : 'en-US',
    hints: 'street, avenue, boulevard, drive, court, way, calle, avenida',
    action: `${process.env.BASE_URL}/lookup-property?lang=${lang}&type=${callerType}&callSid=${callSid}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say({ voice: process.env.VOICE_ES || 'Polly.Lupe-Neural', language: 'es-US' },
      `Gracias. ¿Sobre qué propiedad nos llama? Por favor diga la dirección completa.`
    );
  } else {
    gather.say({ voice: process.env.VOICE_EN || 'Polly.Matthew-Neural', language: 'en-US' },
      `Thank you. What property are you calling about? Please say the full address.`
    );
  }

  twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_address&lang=${lang}&type=${callerType}&callSid=${callSid}`);

  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 3 — AIRTABLE LOOKUP + FUZZY ADDRESS MATCH
// ════════════════════════════════════════════════════════════════════════════
app.post('/lookup-property', async (req, res) => {
  const spokenAddress = (req.body.SpeechResult || '').trim();
  const lang          = req.query.lang || 'en';
  const callerType    = req.query.type || 'Buyer';
  const callSid       = req.query.callSid || req.body.CallSid;
  const callerNumber  = req.body.From || '';

  const twiml = new VoiceResponse();
  const voiceEN = process.env.VOICE_EN || 'Polly.Matthew-Neural';
  const voiceES = process.env.VOICE_ES || 'Polly.Lupe-Neural';
  const voice   = lang === 'es' ? voiceES : voiceEN;
  const locale  = lang === 'es' ? 'es-US' : 'en-US';

  try {
    // ── Fetch all active listings from Airtable ──
    const records = await base('ALL LISTINGS').select({
      filterByFormula: `OR({Status} = 'Active', {Status} = 'Coming Soon')`,
      fields: ['Address', 'Street Address', 'City', 'State', 'Zip code',
               'Name', 'Phone', 'Email', 'BAC Offered', 'Commission NOTES',
               'Type', 'List Price', 'Notes', 'prop_id'],
    }).all();

    // ── Build searchable list ──
    const listings = records.map(r => ({
      id:         r.id,
      prop_id:    r.get('prop_id') || '',
      address:    r.get('Address') || r.get('Street Address') || '',
      city:       r.get('City') || '',
      state:      r.get('State') || '',
      zip:        r.get('Zip code') || '',
      fullAddress: [
        r.get('Address') || r.get('Street Address'),
        r.get('City'),
        r.get('State'),
        r.get('Zip code')
      ].filter(Boolean).join(', '),
      name:       r.get('Name') || '',
      phone:      r.get('Phone') || '',
      email:      r.get('Email') || '',
      bac:        r.get('BAC Offered') || '',
      commNotes:  r.get('Commission NOTES') || '',
      type:       r.get('Type') || '',
      price:      r.get('List Price') || '',
      notes:      r.get('Notes') || '',
    }));

    // ── Fuzzy match spoken address ──
    const fuse = new Fuse(listings, {
      keys: ['address', 'fullAddress', 'city'],
      threshold: 0.45,
      includeScore: true,
    });

    const results = fuse.search(spokenAddress);
    const match   = results.length > 0 ? results[0].item : null;

    // ── Log call to Airtable CALL LOG ──
    const logFields = {
      Name:             `Call ${new Date().toISOString()}`,
      Call_ID:          callSid,
      Call_Date:        new Date().toISOString(),
      Caller_Number:    callerNumber,
      Caller_Type:      callerType,
      Language:         lang === 'es' ? 'Spanish' : 'English',
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

    // ── No match found ──
    if (!match) {
      twiml.say({ voice, language: locale },
        lang === 'es'
          ? 'Lo sentimos, no encontramos esa propiedad en nuestro sistema. Por favor deje un mensaje.'
          : 'I\'m sorry, I couldn\'t find that property in our system. Please leave a message and we\'ll follow up.'
      );
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_match&lang=${lang}&type=${callerType}&callSid=${callSid}&logId=${logId}`);
      return res.type('text/xml').send(twiml.toString());
    }

    // ── Route by caller type ──
    if (callerType === 'Realtor') {
      return realtorFlow(res, twiml, { match, lang, voice, locale, callerNumber, callSid, logId, spokenAddress });
    } else {
      return buyerTenantFlow(res, twiml, { match, lang, voice, locale, callerNumber, callerType, callSid, logId });
    }

  } catch (err) {
    console.error('Lookup error:', err);
    twiml.say({ voice: voiceEN, language: 'en-US' },
      'We\'re experiencing a technical issue. Please leave a message.'
    );
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=error&lang=${lang}&callSid=${callSid}`);
    res.type('text/xml').send(twiml.toString());
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REALTOR FLOW
// ════════════════════════════════════════════════════════════════════════════
function realtorFlow(res, twiml, { match, lang, voice, locale, callerNumber, callSid, logId, spokenAddress }) {
  const bac      = match.bac || 'not specified';
  const commNote = match.commNotes ? ` ${match.commNotes}` : '';

  const gather = twiml.gather({
    input: 'speech',
    timeout: 8,
    speechTimeout: 'auto',
    language: locale,
    action: `${process.env.BASE_URL}/realtor-response?lang=${lang}&callSid=${callSid}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&matchAddress=${encodeURIComponent(match.fullAddress)}&callerNumber=${encodeURIComponent(callerNumber)}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say({ voice, language: locale },
      `Encontré la propiedad en ${match.fullAddress}. ` +
      `El vendedor no está ofreciendo una comisión antes de recibir una oferta.${commNote} ` +
      `¿Le gustaría mostrar esta propiedad a sus compradores? ¿Cuándo estaría disponible?`
    );
  } else {
    gather.say({ voice, language: locale },
      `I found the property at ${match.fullAddress}. ` +
      `The seller is not offering a commission in advance of an offer.${commNote} ` +
      `Would you like to show this property to your buyers? When would you be available?`
    );
  }

  // Fallback to voicemail
  twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_response&lang=${lang}&callSid=${callSid}&logId=${logId}&matchAddress=${encodeURIComponent(match.fullAddress)}`);

  res.type('text/xml').send(twiml.toString());
}

// ════════════════════════════════════════════════════════════════════════════
// REALTOR RESPONSE — Claude AI handles their reply
// ════════════════════════════════════════════════════════════════════════════
app.post('/realtor-response', async (req, res) => {
  const speech      = (req.body.SpeechResult || '').trim();
  const lang        = req.query.lang || 'en';
  const callSid     = req.query.callSid;
  const logId       = req.query.logId;
  const matchId     = req.query.matchId;
  const matchAddress = decodeURIComponent(req.query.matchAddress || '');
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');

  const voice  = lang === 'es' ? (process.env.VOICE_ES || 'Polly.Lupe-Neural') : (process.env.VOICE_EN || 'Polly.Matthew-Neural');
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const twiml  = new VoiceResponse();

  // ── Fetch listing details for Claude context ──
  let listingContext = '';
  try {
    const record = await base('ALL LISTINGS').find(matchId);
    listingContext = JSON.stringify({
      address:    record.get('Address') || record.get('Street Address'),
      city:       record.get('City'),
      price:      record.get('List Price'),
      type:       record.get('Type'),
      bac:        record.get('BAC Offered'),
      commNotes:  record.get('Commission NOTES'),
      notes:      record.get('Notes'),
      sellerName: record.get('Name'),
    });
  } catch (e) { listingContext = `{ "address": "${matchAddress}" }`; }

  // ── Ask Claude ──
  try {
    const aiResponse = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      system: buildRealtorSystemPrompt(lang, listingContext),
      messages: [{ role: 'user', content: speech }],
    });

    const aiText  = aiResponse.content[0].text.trim();
    const wantsShow = /show|showing|schedule|disponible|mostrar|cuando|tuesday|monday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miércoles|jueves|viernes|sábado|domingo|\d+(am|pm)/.test(speech.toLowerCase());
    const wantsSMS  = true; // Always offer SMS

    // Log transcript
    await base('CALL LOG').update(logId, {
      Transcript:       `Realtor said: "${speech}"\nClaude responded: "${aiText}"`,
      Call_Disposition: wantsShow ? 'Transferred to Seller' : 'Voicemail Left',
    });

    // Say Claude's response
    twiml.say({ voice, language: locale }, aiText);

    // Offer SMS
    const smsGather = twiml.gather({
      input: 'speech dtmf',
      numDigits: 1,
      timeout: 5,
      language: locale,
      action: `${process.env.BASE_URL}/send-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(matchId)}&callerNumber=${encodeURIComponent(callerNumber)}&type=Realtor`,
      method: 'POST',
    });

    smsGather.say({ voice, language: locale },
      lang === 'es'
        ? '¿Le envío la información de contacto del vendedor por mensaje de texto? Oprima 1 o diga sí.'
        : 'May I text you the seller\'s contact information? Press 1 or say yes.'
    );

    // If they want to show → transfer to seller after SMS prompt
    if (wantsShow) {
      twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}`);
    } else {
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=realtor_other&lang=${lang}&callSid=${callSid}&logId=${logId}&matchAddress=${encodeURIComponent(matchAddress)}`);
    }

  } catch (err) {
    console.error('Claude error:', err);
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=ai_error&lang=${lang}&callSid=${callSid}&logId=${logId}&matchAddress=${encodeURIComponent(matchAddress)}`);
  }

  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// BUYER / TENANT FLOW
// ════════════════════════════════════════════════════════════════════════════
function buyerTenantFlow(res, twiml, { match, lang, voice, locale, callerNumber, callerType, callSid, logId }) {
  const gather = twiml.gather({
    input: 'speech dtmf',
    numDigits: 1,
    timeout: 5,
    language: locale,
    action: `${process.env.BASE_URL}/send-sms?lang=${lang}&logId=${logId}&matchId=${encodeURIComponent(match.id)}&callerNumber=${encodeURIComponent(callerNumber)}&type=${callerType}`,
    method: 'POST',
  });

  if (lang === 'es') {
    gather.say({ voice, language: locale },
      `Encontré la propiedad en ${match.fullAddress}. ` +
      `Voy a transferirle directamente con el vendedor. ` +
      `¿Le envío la información de contacto por mensaje de texto por si la línea está ocupada? ` +
      `Oprima 1 o diga sí.`
    );
  } else {
    gather.say({ voice, language: locale },
      `I found the property at ${match.fullAddress}. ` +
      `I'll connect you with the seller directly. ` +
      `May I also text you their contact information in case the line is busy? ` +
      `Press 1 or say yes.`
    );
  }

  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(match.id)}&logId=${logId}`);

  res.type('text/xml').send(twiml.toString());
}

// ════════════════════════════════════════════════════════════════════════════
// SEND SMS
// ════════════════════════════════════════════════════════════════════════════
app.post('/send-sms', async (req, res) => {
  const speech      = (req.body.SpeechResult || '').toLowerCase();
  const digits      = (req.body.Digits || '').trim();
  const lang        = req.query.lang || 'en';
  const logId       = req.query.logId;
  const matchId     = decodeURIComponent(req.query.matchId || '');
  const callerNumber = decodeURIComponent(req.query.callerNumber || '');
  const callerType  = req.query.type || 'Buyer';

  const twiml = new VoiceResponse();
  const voice  = lang === 'es' ? (process.env.VOICE_ES || 'Polly.Lupe-Neural') : (process.env.VOICE_EN || 'Polly.Matthew-Neural');
  const locale = lang === 'es' ? 'es-US' : 'en-US';

  const wantsText = digits === '1' || /yes|si|sí|yeah|sure|ok|claro|por favor/.test(speech);

  if (wantsText && callerNumber) {
    try {
      const record = await base('ALL LISTINGS').find(matchId);
      const address  = record.get('Address') || record.get('Street Address') || '';
      const city     = record.get('City') || '';
      const sellerName  = record.get('Name') || '';
      const sellerPhone = record.get('Phone') || '';
      const sellerEmail = record.get('Email') || '';

      const smsBody = lang === 'es'
        ? `Jorge Zea | Blue Lighthouse Realty\nPropiedad: ${address}, ${city}\nVendedor: ${sellerName}\n📞 ${sellerPhone}\n✉ ${sellerEmail}\n\nResponda STOP para cancelar.`
        : `Jorge Zea | Blue Lighthouse Realty\nProperty: ${address}, ${city}\nSeller: ${sellerName}\n📞 ${sellerPhone}\n✉ ${sellerEmail}\n\nReply STOP to opt out.`;

      await twilioClient.messages.create({
        body: smsBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   callerNumber,
      });

      // Update log
      await base('CALL LOG').update(logId, { SMS_Sent: true });

      // Notify seller
      await notifySeller({ record, callerNumber, callerType, address, city });

      twiml.say({ voice, language: locale },
        lang === 'es'
          ? 'Perfecto, le acabo de enviar la información por mensaje de texto.'
          : 'Perfect, I just sent the information to your phone.'
      );

    } catch (err) {
      console.error('SMS error:', err);
    }
  }

  // Transfer to seller
  twiml.redirect(`${process.env.BASE_URL}/transfer-seller?lang=${lang}&matchId=${encodeURIComponent(matchId)}&logId=${logId}`);
  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// TRANSFER TO SELLER
// ════════════════════════════════════════════════════════════════════════════
app.post('/transfer-seller', async (req, res) => {
  const lang    = req.query.lang || 'en';
  const matchId = decodeURIComponent(req.query.matchId || '');
  const logId   = req.query.logId;

  const twiml = new VoiceResponse();
  const voice  = lang === 'es' ? (process.env.VOICE_ES || 'Polly.Lupe-Neural') : (process.env.VOICE_EN || 'Polly.Matthew-Neural');
  const locale = lang === 'es' ? 'es-US' : 'en-US';

  try {
    const record      = await base('ALL LISTINGS').find(matchId);
    const sellerPhone = record.get('Phone') || '';

    if (sellerPhone) {
      twiml.say({ voice, language: locale },
        lang === 'es'
          ? 'Le transfiero ahora con el vendedor. Un momento por favor.'
          : 'Transferring you to the seller now. One moment please.'
      );
      twiml.dial(sellerPhone);

      await base('CALL LOG').update(logId, {
        Call_Disposition: 'Transferred to Seller',
        Seller_Notified: true,
      });
    } else {
      twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=no_seller_phone&lang=${lang}&logId=${logId}`);
    }
  } catch (err) {
    twiml.redirect(`${process.env.BASE_URL}/voicemail?reason=transfer_error&lang=${lang}&logId=${logId}`);
  }

  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// VOICEMAIL
// ════════════════════════════════════════════════════════════════════════════
app.post('/voicemail', (req, res) => {
  const lang         = req.query.lang || 'en';
  const matchAddress = decodeURIComponent(req.query.matchAddress || '');
  const logId        = req.query.logId || '';

  const twiml = new VoiceResponse();
  const voice  = lang === 'es' ? (process.env.VOICE_ES || 'Polly.Lupe-Neural') : (process.env.VOICE_EN || 'Polly.Matthew-Neural');
  const locale = lang === 'es' ? 'es-US' : 'en-US';

  const context = matchAddress
    ? (lang === 'es' ? ` Tomaré nota de que su consulta es sobre ${matchAddress}.` : ` I'll note this is regarding ${matchAddress}.`)
    : '';

  twiml.say({ voice, language: locale },
    lang === 'es'
      ? `Por favor deje su mensaje después del tono.${context} Le contactaremos a la brevedad.`
      : `Please leave your message after the tone.${context} We'll get back to you shortly.`
  );

  twiml.record({
    maxLength: 120,
    transcribe: true,
    transcribeCallback: `${process.env.BASE_URL}/voicemail-transcribed?logId=${logId}`,
    action: `${process.env.BASE_URL}/voicemail-done?logId=${logId}`,
    method: 'POST',
  });

  res.type('text/xml').send(twiml.toString());
});

// ── Voicemail transcription callback ────────────────────────────────────────
app.post('/voicemail-transcribed', async (req, res) => {
  const transcript   = req.body.TranscriptionText || '';
  const recordingUrl = req.body.RecordingUrl || '';
  const callSid      = req.body.CallSid || '';
  const logId        = req.query.logId || '';

  // Update CALL LOG
  if (logId) {
    await base('CALL LOG').update(logId, {
      Transcript:       transcript,
      Voicemail_URL:    recordingUrl,
      Call_Disposition: 'Voicemail Left',
    }).catch(console.error);
  }

  // Email Jorge
  await mailer.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      process.env.EMAIL_TO,
    subject: `📞 New Voicemail — ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">📞 New Voicemail — Blue Lighthouse Realty IVR</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px;font-weight:bold;">Call SID</td><td style="padding:8px;">${callSid}</td></tr>
          <tr style="background:#f5f5f5;"><td style="padding:8px;font-weight:bold;">Time</td><td style="padding:8px;">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Recording</td><td style="padding:8px;"><a href="${recordingUrl}">▶ Listen</a></td></tr>
        </table>
        <h3 style="color:#003087;">Transcript</h3>
        <p style="background:#f9f9f9;padding:12px;border-left:4px solid #003087;">${transcript || 'Transcription pending...'}</p>
        <p style="color:#999;font-size:12px;">Blue Lighthouse Realty IVR System</p>
      </div>
    `,
  }).catch(console.error);

  res.sendStatus(200);
});

app.post('/voicemail-done', (req, res) => {
  const twiml = new VoiceResponse();
  const lang  = req.query.lang || 'en';
  const voice = lang === 'es' ? (process.env.VOICE_ES || 'Polly.Lupe-Neural') : (process.env.VOICE_EN || 'Polly.Matthew-Neural');
  twiml.say({ voice, language: lang === 'es' ? 'es-US' : 'en-US' },
    lang === 'es' ? 'Gracias. Hasta pronto.' : 'Thank you. Goodbye.'
  );
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ════════════════════════════════════════════════════════════════════════════
// RECORDING STATUS CALLBACK
// ════════════════════════════════════════════════════════════════════════════
app.post('/recording-status', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl;
  const callSid      = req.body.CallSid;
  const duration     = req.body.RecordingDuration;

  // Find call log by Call_ID and update
  const records = await base('CALL LOG').select({
    filterByFormula: `{Call_ID} = '${callSid}'`,
    maxRecords: 1,
  }).firstPage().catch(() => []);

  if (records.length > 0) {
    await base('CALL LOG').update(records[0].id, {
      Voicemail_URL:     recordingUrl,
      Call_Duration_Sec: parseInt(duration) || 0,
    }).catch(console.error);
  }

  res.sendStatus(200);
});

// ════════════════════════════════════════════════════════════════════════════
// SELLER NOTIFICATION EMAIL
// ════════════════════════════════════════════════════════════════════════════
async function notifySeller({ record, callerNumber, callerType, address, city }) {
  const sellerEmail = record.get('Email');
  const sellerName  = record.get('Name') || 'Seller';
  if (!sellerEmail) return;

  const callerLabel = callerType === 'Realtor' ? 'a Realtor' : `a potential ${callerType.toLowerCase()}`;

  await mailer.sendMail({
    from:    process.env.EMAIL_FROM,
    to:      sellerEmail,
    subject: `📞 Call received re: ${address}, ${city}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;">
        <h2 style="color:#003087;">Call Notification — Blue Lighthouse Realty</h2>
        <p>Dear ${sellerName},</p>
        <p>We received a call from <strong>${callerNumber}</strong> from ${callerLabel} asking about your property at <strong>${address}, ${city}</strong>.</p>
        <p>We provided your contact information. Please feel free to follow up directly at: <strong>${callerNumber}</strong>.</p>
        <br/>
        <p style="color:#555;">Jorge Zea<br/>Licensed Real Estate Broker<br/>Blue Lighthouse Realty | SnapFlatFee.com</p>
        <p style="color:#999;font-size:12px;">This is an automated notification from your listing management system.</p>
      </div>
    `,
  }).catch(console.error);
}

// ════════════════════════════════════════════════════════════════════════════
// CLAUDE SYSTEM PROMPT — REALTOR (Constrained)
// ════════════════════════════════════════════════════════════════════════════
function buildRealtorSystemPrompt(lang, listingContext) {
  const listingData = JSON.parse(listingContext);

  if (lang === 'es') {
    return `Eres el asistente automatizado de Jorge Zea, Corredor de Bienes Raíces Licenciado, Blue Lighthouse Realty.

DATOS DE LA PROPIEDAD:
${JSON.stringify(listingData, null, 2)}

SOLO puedes hablar sobre:
1. Esta propiedad específica
2. Disponibilidad para mostrarla y coordinación
3. Política de comisión: el vendedor NO ofrece comisión antes de recibir una oferta

NUNCA:
- Discutas otras propiedades
- Negocies la comisión
- Des consejos legales o financieros
- Hagas comentarios sobre competidores o la MLS
- Especules más allá de los datos de la propiedad
- Respondas preguntas fuera del tema de esta llamada

Si el agente quiere mostrar la propiedad, confirma con entusiasmo profesional y di que lo transferirás al vendedor.
Si pregunta sobre comisión, repite: "El vendedor no ofrece comisión antes de recibir una oferta."
Si pregunta algo fuera de tu alcance, di: "Para eso le transfiero al buzón de voz de Jorge Zea."

Responde en español. Sé profesional, cálido y conciso. Máximo 2 oraciones.`;
  }

  return `You are the automated assistant for Jorge Zea, Licensed Real Estate Broker, Blue Lighthouse Realty.

PROPERTY DATA:
${JSON.stringify(listingData, null, 2)}

You MAY ONLY discuss:
1. This specific property
2. Showing availability and scheduling
3. Commission policy: seller is NOT offering a commission in advance of an offer

NEVER:
- Discuss other properties
- Negotiate commission
- Give legal or financial advice
- Comment on competitors, NAR, MLS, or industry matters
- Speculate beyond the listing data
- Engage any topic outside this property inquiry

If the agent wants to show: confirm warmly and professionally, say you'll transfer to the seller.
If they ask about commission: "The seller is not offering a commission in advance of an offer."
If they ask anything outside scope: "For that I'll transfer you to Jorge Zea's voicemail."

Respond in English. Professional, warm, concise. Maximum 2 sentences.`;
}

// ════════════════════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🏠 Blue Lighthouse IVR running on port ${PORT}`);
});

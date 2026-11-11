// callSummary.js — turns a CALL LOG row into the plain-language fields people read.
// One pure function, no I/O, so the IVR (live calls), the one-time backfill and the tests all use the same rules.
//
//   summarizeCall(fields, { messageRecorded }) -> {
//     'What happened', Outcome, Attention, 'Action needed',
//     'Caller texted', 'Seller texted', 'Seller phone answered', 'Message recorded'
//   }
//
// `fields` is the row as Airtable returns it (single selects are plain strings, attachments are arrays).
// 'Seller emailed', 'Recording emailed' and 'Voicemail emailed to' are written at the moment the email is sent,
// not derived here.

const OUTCOME = {
  TALKED:        'Talked to seller (or their voicemail)',
  UNREACH_MSG:   'Seller unreachable - message left with us',
  UNREACH_NONE:  'Seller unreachable - no message',
  MESSAGE:       'Message left with us',
  FCHB:          'Message sent to FCHB',
  NOT_FOUND:     'Address not found',
  HUNG_UP:       'Hung up - no message',
};

const has = (v) => Array.isArray(v) ? v.length > 0 : !!v;
const str = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.name : v) || '';

// "6249 Barry Dr W,  Jacksonville,  FL  32208, Jacksonville, FL, 32208" -> "6249 Barry Dr W, Jacksonville"
function shortAddress(a) {
  const parts = String(a || '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, 2).join(', ');
}

function mmss(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
}

function summarizeCall(f, opts = {}) {
  f = f || {};
  const notes      = String(f.Notes || '');
  const heard      = String(f.Property_Address || '').trim();
  const matched    = !!(f.Real_Address || f.Prop_ID || has(f.Listing_Link));
  const message    = opts.messageRecorded != null
    ? !!opts.messageRecorded
    : !!(f.Voicemail_URL || has(f.Voicemail_File) || f['Message recorded']);
  const spanish    = str(f.Language) === 'Spanish';
  const type       = str(f.Caller_Type);
  const disp       = str(f.Call_Disposition);
  const afterHours = /^after-hours/i.test(String(f.Name || ''));
  const fchb       = /FCHB property/i.test(notes);
  const unreachable = /caller offered our voicemail/i.test(notes);
  const talked     = !unreachable && (disp === 'Transferred to Seller' || has(f.MP3));
  const commission = /policy message played/i.test(String(f.BAC_Disclosed || ''));
  const chose      = (/After the commission policy message the Realtor chose: ([^.]*)\./.exec(notes) || [])[1] || '';
  const textedBack = /\[SMS REPLY/.test(notes) && !f.Handled;

  // ── Outcome / Attention / Action ──────────────────────────────────────────
  let outcome, attention = 'None', action = '';
  if (fchb) {
    outcome = message ? OUTCOME.FCHB : OUTCOME.HUNG_UP;
  } else if (unreachable) {
    outcome   = message ? OUTCOME.UNREACH_MSG : OUTCOME.UNREACH_NONE;
    attention = 'FYI';
    action    = message ? 'Seller never answered - the message was emailed to the seller (copy to you)'
                        : 'Seller never answered and the caller left no message';
  } else if (talked) {
    outcome = OUTCOME.TALKED;
  } else if (message) {
    outcome = OUTCOME.MESSAGE;
    if (afterHours && matched) {
      attention = 'FYI';
      action = 'After-hours message was emailed to the seller';
    } else {
      attention = 'Needs you';
      action = commission ? 'Listen - message left after the commission policy message'
             : matched    ? 'Listen and call back'
                          : 'Listen and call back - address not found';
    }
  } else if (!matched && (disp === 'No Match Found') && !/Reason: no_input/i.test(notes)) {
    outcome = OUTCOME.NOT_FOUND;
  } else {
    outcome = OUTCOME.HUNG_UP;
  }
  if (spanish && attention === 'Needs you') action += ' (Spanish)';
  if (textedBack) {
    attention = 'Needs you';
    action = action ? `${action}; caller also texted back` : 'Caller texted back - read and reply';
  }

  // ── One plain sentence ────────────────────────────────────────────────────
  const who  = [type && type !== 'Unknown' ? type : 'Caller', f.Caller_Name ? `(${f.Caller_Name})` : ''].filter(Boolean).join(' ');
  const lang = spanish ? ' in Spanish' : '';
  let about = '';
  if (matched) about = ` about ${shortAddress(f.Real_Address) || 'a listed property'}`;
  else if (heard && heard !== 'No Address') about = /^\(keypad\)/.test(heard) ? ` and keyed ${heard.replace(/^\(keypad\)\s*/, '')}` : ` and said "${heard.replace(/[.\s]+$/, '').slice(0, 60)}"`;

  const bits = [];
  switch (outcome) {
    case OUTCOME.TALKED:       bits.push(`Connected to the seller${mmss(f.Call_Duration_Sec) ? ` (${mmss(f.Call_Duration_Sec)})` : ''}.`); break;
    case OUTCOME.UNREACH_MSG:  bits.push("The seller's phone never answered; the caller left a message with us (emailed to the seller)."); break;
    case OUTCOME.UNREACH_NONE: bits.push("The seller's phone never answered and the caller left no message."); break;
    case OUTCOME.FCHB:         bits.push('FCHB listing: sent straight to voicemail, message emailed to FCHB.'); break;
    case OUTCOME.NOT_FOUND:    bits.push('Property not found; no message left.'); break;
    case OUTCOME.MESSAGE:
      bits.push(afterHours ? 'Called after hours and left a message.' : commission ? 'Left a message for the broker.' : 'Left a message with us.'); break;
    default:                   bits.push(matched ? 'Hung up before connecting.' : 'Hung up before giving a property.');
  }
  if (commission) bits.unshift(`Heard the commission policy message${chose ? ` and chose ${chose}` : ''}.`);
  if (f.SMS_Sent) bits.push('Caller texted.');
  if (f.Seller_SMS_Sent) bits.push('Seller texted.');
  if (textedBack) bits.push('Caller texted back.');
  const sentence = `${who} called${lang}${about}. ${bits.join(' ')}`.replace(/\s+/g, ' ').trim();

  return {
    'What happened': sentence,
    Outcome: outcome,
    Attention: attention,
    'Action needed': action,
    'Caller texted': !!f.SMS_Sent,
    'Seller texted': !!f.Seller_SMS_Sent,
    'Seller phone answered': !!f.Seller_Accepted_Call,
    'Message recorded': message,
  };
}

// Only the keys whose value differs from what is already on the row (so a re-run writes nothing).
function changedFields(current, summary) {
  const out = {};
  for (const [k, v] of Object.entries(summary)) {
    const cur = current[k];
    const same = typeof v === 'boolean' ? !!cur === v : (cur == null ? '' : str(cur)) === v;
    if (!same) out[k] = v;
  }
  return out;
}

module.exports = { summarizeCall, changedFields, OUTCOME };

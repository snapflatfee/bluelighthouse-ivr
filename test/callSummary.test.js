// Run: node --test test/        (no network, no Airtable)
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeCall, changedFields, OUTCOME } = require('../lib/callSummary');

const ATT = [{ filename: 'x.mp3' }];
const KP  = 'Caller consented to recording by continuing on the line (FL two-party notice at greeting).';

test('Realtor keyed a bogus number, then left a message with us (the +17864867446 call) → Needs you', () => {
  const s = summarizeCall({ Caller_Type: 'Realtor', Language: 'Spanish', Caller_Name: 'Floresta Enterp', Property_Address: '(keypad) 27501831801',
    Notes: `${KP} Caller keyed house number 27501831801; no Active/Pending listing has that number.`, Call_Disposition: 'Voicemail Left', Voicemail_File: ATT, SMS_Sent: true });
  assert.equal(s.Outcome, OUTCOME.MESSAGE); assert.equal(s.Attention, 'Needs you');
  assert.match(s['Action needed'], /address not found.*\(Spanish\)/);
  assert.match(s['What happened'], /^Realtor \(Floresta Enterp\) called in Spanish and keyed 27501831801\. Left a message with us\. Caller texted\.$/);
  assert.equal(s['Message recorded'], true); assert.equal(s['Caller texted'], true);
});

test('FCHB listing: message goes to FCHB, nothing for Jorge (the +19045243811 call)', () => {
  const s = summarizeCall({ Caller_Type: 'Buyer', Language: 'English', Real_Address: '6249 Barry Dr W,  Jacksonville,  FL  32208, Jacksonville, FL, 32208', Prop_ID: 'X',
    Notes: `${KP}\nFCHB property — routed directly to voicemail per account rule.`, Call_Disposition: 'Voicemail Left', Voicemail_File: ATT, SMS_Sent: true, Seller_SMS_Sent: true });
  assert.equal(s.Outcome, OUTCOME.FCHB); assert.equal(s.Attention, 'None'); assert.equal(s['Action needed'], '');
  assert.match(s['What happened'], /about 6249 Barry Dr W, Jacksonville\. FCHB listing/);
});

test('FCHB listing, caller left nothing → hung up, no action', () => {
  const s = summarizeCall({ Real_Address: 'A', Notes: 'FCHB property — routed directly to voicemail per account rule.', Call_Disposition: 'Voicemail Left' });
  assert.equal(s.Outcome, OUTCOME.HUNG_UP); assert.equal(s.Attention, 'None');
});

test('connected to the seller (live or their voicemail) → no action, shows the length', () => {
  const s = summarizeCall({ Caller_Type: 'Buyer', Real_Address: '1039 Scriven Street,  jacksonville,  FL  32209', Call_Disposition: 'Transferred to Seller', Seller_Notified: true, Seller_Accepted_Call: true, MP3: ATT, Call_Duration_Sec: 242, Seller_SMS_Sent: true });
  assert.equal(s.Outcome, OUTCOME.TALKED); assert.equal(s.Attention, 'None'); assert.equal(s['Seller phone answered'], true);
  assert.match(s['What happened'], /Connected to the seller \(4:02\)\. Seller texted\./);
});

test('seller never answered → FYI (not Needs you), with or without a message — even after the disposition was overwritten', () => {
  const notes = `${KP}\nSeller leg ended: no-answer after 0s — caller offered our voicemail.`;
  const none = summarizeCall({ Real_Address: 'A', Call_Disposition: 'Transferred to Voicemail', Seller_Notified: true, Seller_Accepted_Call: false, Notes: notes });
  assert.equal(none.Outcome, OUTCOME.UNREACH_NONE); assert.equal(none.Attention, 'FYI');
  const msg = summarizeCall({ Real_Address: 'A', Call_Disposition: 'Voicemail Left', Seller_Notified: true, Notes: notes, Voicemail_URL: 'https://x' });
  assert.equal(msg.Outcome, OUTCOME.UNREACH_MSG); assert.equal(msg.Attention, 'FYI');
});

test('address not found and no message → "Address not found", nothing to do', () => {
  const s = summarizeCall({ Caller_Type: 'Buyer', Property_Address: 'convención', Call_Disposition: 'No Match Found', Notes: `${KP} Caller keyed house number 980; no Active/Pending listing has that number.` });
  assert.equal(s.Outcome, OUTCOME.NOT_FOUND); assert.equal(s.Attention, 'None');
  assert.match(s['What happened'], /said "convención"/);
});

test('silent caller (no_input) marked "Voicemail Left" without any recording → Hung up, not a voicemail', () => {
  const s = summarizeCall({ Caller_Type: 'Unknown', Property_Address: 'No Address', Call_Disposition: 'Voicemail Left', Notes: 'Reason: no_input. Caller consented to recording (FL two-party notice at greeting).' });
  assert.equal(s.Outcome, OUTCOME.HUNG_UP); assert.equal(s['Message recorded'], false); assert.equal(s.Attention, 'None');
  assert.match(s['What happened'], /^Caller called\. Hung up before giving a property\./);
});

test('a message recorded just now counts even before the file is on the row', () => {
  const s = summarizeCall({ Property_Address: 'No Address', Call_Disposition: 'Voicemail Left', Notes: 'Reason: no_input.' }, { messageRecorded: true });
  assert.equal(s.Outcome, OUTCOME.MESSAGE); assert.equal(s.Attention, 'Needs you'); assert.match(s['Action needed'], /^Listen and call back - address not found/);
});

test('commission policy: heard it, then left a message for the broker → Needs you; records what the Realtor chose', () => {
  const s = summarizeCall({ Caller_Type: 'Realtor', Real_Address: '1198 SW 13th Ave,  Boca Raton', Prop_ID: 'T', BAC_Disclosed: 'No offer - policy message played', Voicemail_URL: 'u',
    Notes: 'After the commission policy message the Realtor chose: to leave a message for the broker.' });
  assert.equal(s.Attention, 'Needs you'); assert.match(s['Action needed'], /commission policy/);
  assert.match(s['What happened'], /Heard the commission policy message and chose to leave a message for the broker\. Left a message for the broker\./);
});

test('after-hours message for a matched listing → FYI (it went to the seller); unmatched → Needs you', () => {
  const m = summarizeCall({ Name: 'After-Hours 2026-11-10', Real_Address: 'A', Voicemail_URL: 'u' });
  assert.equal(m.Attention, 'FYI'); assert.match(m['What happened'], /after hours/);
  const u = summarizeCall({ Name: 'After-Hours 2026-11-10', Voicemail_URL: 'u', Call_Disposition: 'No Match Found' });
  assert.equal(u.Attention, 'Needs you');
});

test('a text reply re-opens a call until it is marked Handled', () => {
  const base = { Real_Address: 'A', Call_Disposition: 'Transferred to Seller', MP3: ATT, Notes: '[SMS REPLY 11/11/2026, 8:35:47 AM]: please call me' };
  const open = summarizeCall(base);
  assert.equal(open.Attention, 'Needs you'); assert.match(open['Action needed'], /texted back/); assert.match(open['What happened'], /Caller texted back\./);
  assert.equal(summarizeCall({ ...base, Handled: true }).Attention, 'None');
});

test('changedFields writes only what is different (a re-run writes nothing)', () => {
  const row = { Call_Disposition: 'Voicemail Left', Voicemail_File: ATT };
  const s = summarizeCall(row);
  assert.deepEqual(changedFields({ ...row, ...s }, s), {});
  assert.deepEqual(Object.keys(changedFields({ ...row, ...s, Attention: 'None' }, { ...s, Attention: 'Needs you' })), ['Attention']);
});

test('never throws on an empty or odd row', () => {
  assert.doesNotThrow(() => summarizeCall({}));
  assert.doesNotThrow(() => summarizeCall(undefined));
  assert.equal(summarizeCall({}).Outcome, OUTCOME.HUNG_UP);
});

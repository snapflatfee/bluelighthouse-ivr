// smsErrors.js — plain-language meaning of the Twilio error codes that matter for our texts.
// Pure, no I/O. (The Manager Dashboard keeps its own copy of this list in lib/smsErrors.js.)
const SMS_ERRORS = {
  21610: 'the person replied STOP',
  21614: 'not a mobile number',
  21211: 'invalid phone number',
  30001: 'Twilio queue was full',
  30003: 'phone off or unreachable',
  30004: 'blocked by the recipient or carrier',
  30005: 'unknown or inactive number',
  30006: 'landline or unreachable carrier',
  30007: 'filtered by the carrier',
  30008: 'unknown carrier error',
  30032: 'our toll-free number is not verified',
  30034: 'our number is not registered for texting (A2P)',
};

// 30006 -> "landline or unreachable carrier"; unknown/missing codes still give something readable.
function smsErrorText(code) {
  const n = String(code == null ? '' : code).replace(/\D/g, '');
  if (!n) return 'reason not given';
  return SMS_ERRORS[n] || `Twilio error ${n}`;
}

module.exports = { smsErrorText, SMS_ERRORS };

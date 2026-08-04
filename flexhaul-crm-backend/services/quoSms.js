// services/quoSms.js
//
// Sends a text message through Quo (formerly OpenPhone). Quo's API is a
// plain REST endpoint with an API key — no SDK needed, just fetch.
//
// Real API shape, confirmed against Quo's own docs:
//   POST https://api.quo.com/v1/messages
//   Header: Authorization: YOUR_API_KEY   (the raw key, no "Bearer" prefix)
//   Body:   { content, from, to: ["+15555555555"] }
//   Success: HTTP 202
//
// Same optional pattern as everything else here: if it isn't configured,
// every function just returns null/false rather than breaking anything
// that calls it.
//
// ENVIRONMENT VARIABLES REQUIRED TO ACTIVATE THIS:
//   QUO_API_KEY        - Quo dashboard → Settings → API → Generate API Key
//   QUO_FROM_NUMBER     - your Quo number. Any reasonable format works —
//                         it's normalized to E.164 automatically below —
//                         but the cleanest is +17658856317.
//
// One thing worth knowing: Quo requires US Carrier Registration (their
// version of A2P 10DLC) before the API can send to US numbers — same
// underlying requirement as Twilio, just handled through Quo's own
// dashboard instead. If messages aren't arriving, that's the first
// thing to check in your Quo account.

// Normalizes a US phone number into E.164 ("+17658856317"), regardless
// of how it was typed — with or without the leading "+", with dashes,
// parentheses, spaces, whatever. Applied to BOTH the recipient's number
// (pulled from the database) and QUO_FROM_NUMBER (typed once by a human
// into an environment variable) — a number typed by hand into a
// settings panel is, if anything, more likely to have a typo than one
// that came from a form field, so it gets the same safety net.
// Returns null if it doesn't look like a real 10-digit US number.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function isConfigured() {
  return !!process.env.QUO_API_KEY && !!toE164(process.env.QUO_FROM_NUMBER);
}

// Never throws — a text failing to send should never break whatever
// triggered it. Returns true/false.
async function sendSms(toE164Number, body) {
  const from = toE164(process.env.QUO_FROM_NUMBER);
  if (!process.env.QUO_API_KEY || !from) {
    if (process.env.QUO_FROM_NUMBER && !from) {
      console.error(
        `Quo misconfigured — QUO_FROM_NUMBER ("${process.env.QUO_FROM_NUMBER}") doesn't look like a valid 10-digit US number.`
      );
    }
    return false;
  }

  try {
    const res = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: process.env.QUO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: body,
        from,
        to: [toE164Number],
      }),
    });

    if (res.status === 202 || res.ok) return true;

    const errText = await res.text().catch(() => "");
    console.error(`Quo SMS to ${toE164Number} failed (HTTP ${res.status}):`, errText.slice(0, 300));
    return false;
  } catch (err) {
    console.error(`Quo SMS to ${toE164Number} failed:`, err.message);
    return false;
  }
}

module.exports = { isConfigured, sendSms };

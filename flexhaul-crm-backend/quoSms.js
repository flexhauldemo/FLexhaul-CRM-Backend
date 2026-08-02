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
//   QUO_FROM_NUMBER     - your Quo number in E.164 format, e.g. +17658856317
//
// One thing worth knowing: Quo requires US Carrier Registration (their
// version of A2P 10DLC) before the API can send to US numbers — same
// underlying requirement as Twilio, just handled through Quo's own
// dashboard instead. If messages aren't arriving, that's the first
// thing to check in your Quo account.

function isConfigured() {
  return !!process.env.QUO_API_KEY && !!process.env.QUO_FROM_NUMBER;
}

// Never throws — a text failing to send should never break whatever
// triggered it. Returns true/false.
async function sendSms(toE164, body) {
  if (!isConfigured()) return false;

  try {
    const res = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: process.env.QUO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: body,
        from: process.env.QUO_FROM_NUMBER,
        to: [toE164],
      }),
    });

    if (res.status === 202 || res.ok) return true;

    const errText = await res.text().catch(() => "");
    console.error(`Quo SMS to ${toE164} failed (HTTP ${res.status}):`, errText.slice(0, 300));
    return false;
  } catch (err) {
    console.error(`Quo SMS to ${toE164} failed:`, err.message);
    return false;
  }
}

module.exports = { isConfigured, sendSms };

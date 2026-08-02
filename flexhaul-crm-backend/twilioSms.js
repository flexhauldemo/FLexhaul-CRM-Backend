// services/twilioSms.js
//
// Sends a text message through Twilio. Kept separate from Quo's sender
// (services/quoSms.js) so smsNotifications.js can try one, fall back to
// the other — same pattern as Square/Stripe elsewhere in this app.
//
// ENVIRONMENT VARIABLES REQUIRED TO ACTIVATE THIS:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER      - e.g. +17658856317

let twilioClient = null;
let attempted = false;

function getClient() {
  if (attempted) return twilioClient;
  attempted = true;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    const twilio = require("twilio");
    twilioClient = twilio(sid, token);
    return twilioClient;
  } catch (err) {
    console.error("Twilio misconfigured — check TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN:", err.message);
    return null;
  }
}

function isConfigured() {
  return !!getClient() && !!process.env.TWILIO_FROM_NUMBER;
}

async function sendSms(toE164, body) {
  const client = getClient();
  if (!client || !process.env.TWILIO_FROM_NUMBER) return false;

  try {
    await client.messages.create({ to: toE164, from: process.env.TWILIO_FROM_NUMBER, body });
    return true;
  } catch (err) {
    console.error(`Twilio SMS to ${toE164} failed:`, err.message);
    return false;
  }
}

module.exports = { isConfigured, sendSms };

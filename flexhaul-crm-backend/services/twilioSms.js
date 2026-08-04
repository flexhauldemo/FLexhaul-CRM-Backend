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
    console.error("Twilio misconfigured:", err.message);
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

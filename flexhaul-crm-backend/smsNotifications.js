// services/smsNotifications.js
//
// The provider-agnostic layer: builds the actual message text for two
// things — appointment confirmations and day-before reminders — and
// hands off the real sending to whichever provider is configured.
//
// Tries Quo first (services/quoSms.js), falls back to Twilio
// (services/twilioSms.js) if only that's set up. You only need ONE
// configured, not both. See routes/smsReminders.js for the day-before
// reminder trigger — Render doesn't run background cron jobs on its
// own, so that one needs an outside trigger (see README "Connect Text
// Messaging" for the free way to set that up).

const quoSms = require("./quoSms");
const twilioSms = require("./twilioSms");

function isConfigured() {
  return quoSms.isConfigured() || twilioSms.isConfigured();
}

// Turns whatever a customer's phone number looks like in the database
// ("(765) 885-6317", "765-885-6317", "7658856317"...) into the E.164
// format both Quo and Twilio require ("+17658856317"). Returns null if
// it doesn't look like a real 10-digit US number, rather than guessing —
// better to silently skip a text than send one to a garbled number.
function toE164(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function fmtDate(dateStr) {
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  } catch (e) {
    return dateStr;
  }
}

// See constants/timeSlots.js — same key format ("09:00-11:00").
function fmtTimeSlot(slotKey) {
  if (!slotKey) return null;
  const [start] = slotKey.split("-");
  let [h, m] = start.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Never throws — a text failing to send should never break the job save
// that triggered it. Returns true/false so the caller can log it either
// way without needing a try/catch of their own.
async function sendSms(toRaw, body) {
  const to = toE164(toRaw);
  if (!to) return false;

  if (quoSms.isConfigured()) return quoSms.sendSms(to, body);
  if (twilioSms.isConfigured()) return twilioSms.sendSms(to, body);
  return false;
}

async function sendAppointmentConfirmation(job, phone) {
  const dateStr = job.scheduled_date ? fmtDate(job.scheduled_date) : null;
  const timeStr = fmtTimeSlot(job.scheduled_time_slot);
  if (!dateStr) return false; // nothing to confirm without a real date

  const body =
    `FlexHaul & Demolition: You're confirmed for ${dateStr}` +
    (timeStr ? `, ${timeStr}` : "") +
    (job.address ? ` at ${job.address}` : "") +
    `. Questions? Call/text (765) 885-6317.`;

  return sendSms(phone, body);
}

async function sendAppointmentReminder(job, phone) {
  const dateStr = job.scheduled_date ? fmtDate(job.scheduled_date) : null;
  const timeStr = fmtTimeSlot(job.scheduled_time_slot);
  if (!dateStr) return false;

  const body =
    `FlexHaul & Demolition: Reminder \u2014 we're scheduled for you tomorrow, ${dateStr}` +
    (timeStr ? `, ${timeStr}` : "") +
    (job.address ? ` at ${job.address}` : "") +
    `. Reply or call (765) 885-6317 if anything's changed.`;

  return sendSms(phone, body);
}

module.exports = { isConfigured, sendSms, sendAppointmentConfirmation, sendAppointmentReminder, toE164 };

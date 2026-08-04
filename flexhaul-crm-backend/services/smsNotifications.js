const quoSms = require("./quoSms");
const twilioSms = require("./twilioSms");

function isConfigured() {
  return quoSms.isConfigured() || twilioSms.isConfigured();
}

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
      weekday: "long", month: "long", day: "numeric",
    });
  } catch (e) {
    return dateStr;
  }
}

function fmtTimeSlot(slotKey) {
  if (!slotKey) return null;
  const [start] = slotKey.split("-");
  let [h, m] = start.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

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
  if (!dateStr) return false;
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

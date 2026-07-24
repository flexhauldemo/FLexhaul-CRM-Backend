// services/googleCalendar.js
//
// One-way sync: CRM jobs -> a shared Google Calendar. The CRM stays the
// source of truth for scheduling (create/edit jobs here, same as
// always) — this just mirrors that onto a real calendar so you and
// your crew can see the schedule in whatever calendar app you already
// use on your phones, with normal native notifications.
//
// This is entirely optional. If the two environment variables below
// aren't set, every function here silently no-ops — the CRM works
// exactly as it did before, just without calendar sync.
//
// ENVIRONMENT VARIABLES REQUIRED TO ACTIVATE THIS:
//   GOOGLE_SERVICE_ACCOUNT_KEY_BASE64   - see README.md "Connect Google Calendar"
//   GOOGLE_CALENDAR_ID                  - the calendar's ID (from that calendar's
//                                          Settings page in Google Calendar), e.g.
//                                          "abc123...@group.calendar.google.com"
//
// NOTE ON TIME OF DAY: jobs with a scheduled_time_slot sync as real timed
// events (e.g. 9:00 AM - 11:00 AM). Jobs with only a date and no chosen
// window still sync as all-day events rather than guessing a time.

const { google } = require("googleapis");
const { getSlotByKey, BUSINESS_TIMEZONE } = require("../constants/timeSlots");

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

let calendarClient = null;
let configError = null;

function getClient() {
  if (calendarClient) return calendarClient;
  if (configError) return null;

  const keyB64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!keyB64 || !CALENDAR_ID) {
    configError = "not configured";
    return null;
  }

  try {
    const keyJson = JSON.parse(Buffer.from(keyB64, "base64").toString("utf8"));
    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    calendarClient = google.calendar({ version: "v3", auth });
    return calendarClient;
  } catch (err) {
    console.error("Google Calendar sync misconfigured — check GOOGLE_SERVICE_ACCOUNT_KEY_BASE64:", err.message);
    configError = err.message;
    return null;
  }
}

function isConfigured() {
  return !!getClient();
}

function jobToEventBody(job) {
  const summary = `${job.customer_name || "Job"} \u2014 ${job.address || "no address"}`;
  const slot = job.scheduled_time_slot ? getSlotByKey(job.scheduled_time_slot) : null;

  const descriptionLines = [
    job.notes || "",
    "",
    `Status: ${job.status}`,
    job.customer_phone ? `Phone: ${job.customer_phone}` : "",
    `\u2014 synced automatically from the FlexHaul CRM, job #${job.id}`,
  ].filter(Boolean);

  const body = {
    summary,
    description: descriptionLines.join("\n"),
    location: job.address || undefined,
  };

  if (job.scheduled_date && slot) {
    // Real timed event using the job's chosen window, e.g. 9:00 AM - 11:00 AM.
    const startDateTime = `${job.scheduled_date}T${String(slot.startHour).padStart(2, "0")}:00:00`;
    const endDateTime = `${job.scheduled_date}T${String(slot.endHour).padStart(2, "0")}:00:00`;
    body.start = { dateTime: startDateTime, timeZone: BUSINESS_TIMEZONE };
    body.end = { dateTime: endDateTime, timeZone: BUSINESS_TIMEZONE };
  } else if (job.scheduled_date) {
    // No specific window chosen yet — all-day event for the date instead
    // of guessing a time.
    const next = new Date(job.scheduled_date + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    body.start = { date: job.scheduled_date };
    body.end = { date: next.toISOString().slice(0, 10) };
  }

  return body;
}

// Creates or updates the calendar event for a job, based on whether it
// already has a google_event_id. Returns the event id to store on the
// job (or null if sync isn't configured / the job has no date yet).
// Never throws — sync problems are logged, not allowed to break the
// actual job save.
async function syncJob(job) {
  const client = getClient();
  if (!client) return null;
  if (!job.scheduled_date) return job.google_event_id || null;

  const eventBody = jobToEventBody(job);

  try {
    if (job.google_event_id) {
      await client.events.update({
        calendarId: CALENDAR_ID,
        eventId: job.google_event_id,
        requestBody: eventBody,
      });
      return job.google_event_id;
    } else {
      const res = await client.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: eventBody,
      });
      return res.data.id;
    }
  } catch (err) {
    console.error(`Google Calendar sync failed for job #${job.id}:`, err.message);
    return job.google_event_id || null;
  }
}

// Removes the calendar event entirely (used when a job is canceled or deleted).
async function removeJobEvent(googleEventId) {
  const client = getClient();
  if (!client || !googleEventId) return;
  try {
    await client.events.delete({ calendarId: CALENDAR_ID, eventId: googleEventId });
  } catch (err) {
    // Common and harmless: event was already deleted directly in Google
    // Calendar by a human. Don't treat that as a real error.
    if (err.code !== 410 && err.code !== 404) {
      console.error(`Google Calendar event removal failed (${googleEventId}):`, err.message);
    }
  }
}

module.exports = { isConfigured, syncJob, removeJobEvent };

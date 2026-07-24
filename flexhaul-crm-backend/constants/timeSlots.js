// constants/timeSlots.js
//
// The canonical list of 2-hour scheduling windows, matching what's
// shown on the public site's furniture pickup booking (js/schedule.js).
// Keeping one list here (backend) and one there (frontend, static site)
// is a deliberate tradeoff — the two systems don't share a build step —
// so if you ever change these, update both places. Search the public
// site for "WINDOWS = [" to find the other copy.
//
// Each slot has a stable `key` (used in the database and API, never
// changes even if display wording does) and 24-hour start/end hours
// used to build real timed Google Calendar events.

const TIME_SLOTS = [
  { key: "08:00-10:00", label: "8:00 AM – 10:00 AM", startHour: 8, endHour: 10 },
  { key: "09:00-11:00", label: "9:00 AM – 11:00 AM", startHour: 9, endHour: 11 },
  { key: "10:00-12:00", label: "10:00 AM – 12:00 PM", startHour: 10, endHour: 12 },
  { key: "11:00-13:00", label: "11:00 AM – 1:00 PM", startHour: 11, endHour: 13 },
  { key: "12:00-14:00", label: "12:00 PM – 2:00 PM", startHour: 12, endHour: 14 },
  { key: "13:00-15:00", label: "1:00 PM – 3:00 PM", startHour: 13, endHour: 15 },
  { key: "14:00-16:00", label: "2:00 PM – 4:00 PM", startHour: 14, endHour: 16 },
  { key: "15:00-17:00", label: "3:00 PM – 5:00 PM", startHour: 15, endHour: 17 },
  { key: "16:00-18:00", label: "4:00 PM – 6:00 PM", startHour: 16, endHour: 18 },
];

// The business operates in Lafayette, Indiana (Tippecanoe County), which
// observes US Eastern Time. Change this if that ever changes.
const BUSINESS_TIMEZONE = "America/Indiana/Indianapolis";

const TIME_SLOT_KEYS = TIME_SLOTS.map((s) => s.key);

function getSlotByKey(key) {
  return TIME_SLOTS.find((s) => s.key === key) || null;
}

module.exports = { TIME_SLOTS, TIME_SLOT_KEYS, BUSINESS_TIMEZONE, getSlotByKey };

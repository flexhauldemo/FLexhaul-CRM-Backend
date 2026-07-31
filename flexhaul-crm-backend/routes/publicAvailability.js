// routes/publicAvailability.js
//
// The one job this route has: tell the public website which of the 9
// standard time-slot windows (constants/timeSlots.js) are already
// booked on a given date, so furniture-pickup.html can gray out real
// unavailable windows instead of just showing all 9 as open no matter
// what. Unauthenticated on purpose, same reasoning as
// publicInquiries.js — this is called directly from the marketing site,
// before anyone has logged into anything.
//
// "Booked" here means capacity-booked, not crew-specific: with one
// truck and trailer, a window that already has ANY active job in it is
// full, regardless of which crew_id it's assigned to. That's simpler
// than (and a deliberate departure from) the per-crew conflict checks
// in routes/jobs.js, which make sense once there's more than one crew.

const express = require("express");
const { db } = require("../db");
const { TIME_SLOT_KEYS } = require("../constants/timeSlots");

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get("/", (req, res) => {
  const { date } = req.query;

  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: "date is required, as YYYY-MM-DD" });
  }

  const rows = db
    .prepare(
      "SELECT DISTINCT scheduled_time_slot FROM jobs WHERE scheduled_date = ? AND status != 'canceled' AND scheduled_time_slot IS NOT NULL"
    )
    .all(date);

  // Only ever report keys the site actually knows about — filters out
  // anything stale if the canonical slot list ever changes shape.
  const taken = rows.map((r) => r.scheduled_time_slot).filter((k) => TIME_SLOT_KEYS.includes(k));

  res.json({ date, taken });
});

module.exports = router;

// routes/timeSlots.js
//
// Exposes the canonical time-slot list (constants/timeSlots.js) to the
// frontend, so admin/views/jobs.js doesn't need its own hardcoded copy.
const express = require("express");
const { TIME_SLOTS } = require("../constants/timeSlots");

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ timeSlots: TIME_SLOTS.map((s) => ({ key: s.key, label: s.label })) });
});

module.exports = router;

// routes/jobs.js
const express = require("express");
const { db, logActivity } = require("../db");
const googleCalendar = require("../services/googleCalendar");
const { TIME_SLOT_KEYS } = require("../constants/timeSlots");

const router = express.Router();
const VALID_STATUSES = ["scheduled", "in_progress", "complete", "canceled"];
const RECURRING_INTERVALS = ["weekly", "biweekly", "monthly"];

// Fetches a job joined with customer info — what googleCalendar.syncJob
// needs to build a readable event title, separate from the plain job
// row used everywhere else in this file.
function getJobWithCustomer(id) {
  return db
    .prepare(
      `SELECT jobs.*, customers.name AS customer_name, customers.phone AS customer_phone
       FROM jobs
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE jobs.id = ?`
    )
    .get(id);
}

// Returns the conflicting job if the given crew is already booked for
// the same date + time window — the whole point of a one-truck, two-crew
// operation not accidentally double-booking itself. Returns null if
// there's no conflict, or if any of crewId/date/timeSlot is missing
// (can't detect a conflict without knowing exactly when).
function findCrewConflict(crewId, scheduledDate, timeSlot, excludeJobId) {
  if (!crewId || !scheduledDate || !timeSlot) return null;
  let sql = `
    SELECT jobs.id, customers.name AS customer_name FROM jobs
    JOIN deals ON deals.id = jobs.deal_id
    JOIN customers ON customers.id = deals.customer_id
    WHERE jobs.crew_id = ? AND jobs.scheduled_date = ? AND jobs.scheduled_time_slot = ? AND jobs.status != 'canceled'
  `;
  const params = [crewId, scheduledDate, timeSlot];
  if (excludeJobId) {
    sql += " AND jobs.id != ?";
    params.push(excludeJobId);
  }
  return db.prepare(sql).get(...params);
}

// Same idea for equipment — a truck or trailer assigned to two jobs at
// the same time is exactly the kind of mistake this is meant to catch.
function findEquipmentConflicts(equipmentIds, scheduledDate, timeSlot, excludeJobId) {
  if (!Array.isArray(equipmentIds) || equipmentIds.length === 0 || !scheduledDate || !timeSlot) return [];
  let sql = `
    SELECT jobs.id, jobs.equipment_ids, customers.name AS customer_name FROM jobs
    JOIN deals ON deals.id = jobs.deal_id
    JOIN customers ON customers.id = deals.customer_id
    WHERE jobs.scheduled_date = ? AND jobs.scheduled_time_slot = ? AND jobs.status != 'canceled'
  `;
  const params = [scheduledDate, timeSlot];
  if (excludeJobId) {
    sql += " AND jobs.id != ?";
    params.push(excludeJobId);
  }
  const candidates = db.prepare(sql).all(...params);
  const conflicts = [];
  candidates.forEach((c) => {
    const theirIds = JSON.parse(c.equipment_ids || "[]");
    const overlap = equipmentIds.filter((id) => theirIds.includes(id));
    if (overlap.length > 0) {
      conflicts.push({ job_id: c.id, customer_name: c.customer_name, equipment_ids: overlap });
    }
  });
  return conflicts;
}

// Computes the next date for a recurring job — weekly/biweekly/monthly
// from the completed job's own scheduled date, or from today if it
// somehow didn't have one.
function nextRecurringDate(fromDate, interval) {
  const base = fromDate ? new Date(fromDate + "T00:00:00") : new Date();
  if (interval === "weekly") base.setDate(base.getDate() + 7);
  else if (interval === "biweekly") base.setDate(base.getDate() + 14);
  else if (interval === "monthly") base.setMonth(base.getMonth() + 1);
  return base.toISOString().slice(0, 10);
}

// GET /api/jobs — list, optionally filtered by date range (powers the calendar view)
// and/or status. ?from=YYYY-MM-DD&to=YYYY-MM-DD&status=scheduled
router.get("/", (req, res) => {
  const { from, to, status } = req.query;
  let sql = `
    SELECT jobs.*, deals.customer_id, customers.name AS customer_name, customers.phone AS customer_phone,
           crews.name AS crew_name
    FROM jobs
    JOIN deals ON deals.id = jobs.deal_id
    JOIN customers ON customers.id = deals.customer_id
    LEFT JOIN crews ON crews.id = jobs.crew_id
    WHERE 1=1
  `;
  const params = [];
  if (from) {
    sql += " AND jobs.scheduled_date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND jobs.scheduled_date <= ?";
    params.push(to);
  }
  if (status) {
    sql += " AND jobs.status = ?";
    params.push(status);
  }
  sql += " ORDER BY jobs.scheduled_date ASC";

  const rows = db.prepare(sql).all(...params);
  res.json({ jobs: rows.map((r) => ({ ...r, equipment_ids: JSON.parse(r.equipment_ids || "[]") })) });
});

// GET /api/jobs/:id — detail, with documents
router.get("/:id", (req, res) => {
  const job = db
    .prepare(
      `SELECT jobs.*, deals.customer_id, customers.name AS customer_name, customers.phone AS customer_phone,
              customers.email AS customer_email, crews.name AS crew_name
       FROM jobs
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       LEFT JOIN crews ON crews.id = jobs.crew_id
       WHERE jobs.id = ?`
    )
    .get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const documents = db.prepare("SELECT * FROM documents WHERE job_id = ? ORDER BY uploaded_at DESC").all(req.params.id);
  const invoices = db.prepare("SELECT * FROM invoices WHERE job_id = ? ORDER BY created_at DESC").all(req.params.id);

  res.json({ job: { ...job, equipment_ids: JSON.parse(job.equipment_ids || "[]") }, documents, invoices });
});

// POST /api/jobs — create against a won deal
router.post("/", async (req, res) => {
  const { deal_id, status, scheduled_date, scheduled_time_slot, address, crew_id, equipment_ids, notes, recurring_interval } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: "deal_id is required" });

  const deal = db.prepare("SELECT id FROM deals WHERE id = ?").get(deal_id);
  if (!deal) return res.status(400).json({ error: "deal_id does not match an existing deal" });

  if (scheduled_time_slot && !TIME_SLOT_KEYS.includes(scheduled_time_slot)) {
    return res.status(400).json({ error: `scheduled_time_slot must be one of: ${TIME_SLOT_KEYS.join(", ")}` });
  }
  if (recurring_interval && !RECURRING_INTERVALS.includes(recurring_interval)) {
    return res.status(400).json({ error: `recurring_interval must be one of: ${RECURRING_INTERVALS.join(", ")}` });
  }

  const equipmentIdsArr = Array.isArray(equipment_ids) ? equipment_ids : [];

  const crewConflict = findCrewConflict(crew_id, scheduled_date, scheduled_time_slot);
  if (crewConflict) {
    return res.status(409).json({
      error: `That crew is already booked for ${scheduled_date} in that window \u2014 job #${crewConflict.id} for ${crewConflict.customer_name}.`,
    });
  }
  const equipmentConflicts = findEquipmentConflicts(equipmentIdsArr, scheduled_date, scheduled_time_slot);
  if (equipmentConflicts.length > 0) {
    return res.status(409).json({
      error: `Equipment already assigned to job #${equipmentConflicts[0].job_id} (${equipmentConflicts[0].customer_name}) for that same date and window.`,
    });
  }

  const finalStatus = VALID_STATUSES.includes(status) ? status : "scheduled";
  const result = db
    .prepare(
      `INSERT INTO jobs (deal_id, status, scheduled_date, scheduled_time_slot, address, crew_id, equipment_ids, notes, recurring_interval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      deal_id,
      finalStatus,
      scheduled_date || null,
      scheduled_time_slot || null,
      address || null,
      crew_id || null,
      JSON.stringify(equipmentIdsArr),
      notes || null,
      recurring_interval || null
    );

  const id = Number(result.lastInsertRowid);
  logActivity("job", id, `Job created (status: ${finalStatus})`, req.user && req.user.name);

  // Calendar sync is best-effort and never blocks the response — if it's
  // not configured, or Google is briefly unreachable, the job is still
  // saved either way. See services/googleCalendar.js.
  if (googleCalendar.isConfigured()) {
    const jobWithCustomer = getJobWithCustomer(id);
    const eventId = await googleCalendar.syncJob(jobWithCustomer);
    if (eventId) {
      db.prepare("UPDATE jobs SET google_event_id = ? WHERE id = ?").run(eventId, id);
    }
  }

  res.status(201).json({ job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) });
});

// PATCH /api/jobs/:id
router.patch("/:id", async (req, res) => {
  const existing = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Job not found" });

  if (req.body.status !== undefined && !VALID_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  if (req.body.scheduled_time_slot !== undefined && req.body.scheduled_time_slot !== null && !TIME_SLOT_KEYS.includes(req.body.scheduled_time_slot)) {
    return res.status(400).json({ error: `scheduled_time_slot must be one of: ${TIME_SLOT_KEYS.join(", ")}` });
  }
  if (req.body.recurring_interval !== undefined && req.body.recurring_interval !== null && !RECURRING_INTERVALS.includes(req.body.recurring_interval)) {
    return res.status(400).json({ error: `recurring_interval must be one of: ${RECURRING_INTERVALS.join(", ")}` });
  }

  // Resolve what the crew/date/window/equipment WILL be after this patch,
  // so conflicts are checked against the real final state — not just
  // whatever field happened to be included in this particular request.
  const resolvedCrewId = req.body.crew_id !== undefined ? req.body.crew_id : existing.crew_id;
  const resolvedDate = req.body.scheduled_date !== undefined ? req.body.scheduled_date : existing.scheduled_date;
  const resolvedSlot = req.body.scheduled_time_slot !== undefined ? req.body.scheduled_time_slot : existing.scheduled_time_slot;
  const resolvedEquipment = req.body.equipment_ids !== undefined ? req.body.equipment_ids : JSON.parse(existing.equipment_ids || "[]");

  const scheduleFieldsChanged = ["crew_id", "scheduled_date", "scheduled_time_slot", "equipment_ids"].some((f) => req.body[f] !== undefined);
  if (scheduleFieldsChanged) {
    const crewConflict = findCrewConflict(resolvedCrewId, resolvedDate, resolvedSlot, existing.id);
    if (crewConflict) {
      return res.status(409).json({
        error: `That crew is already booked for ${resolvedDate} in that window \u2014 job #${crewConflict.id} for ${crewConflict.customer_name}.`,
      });
    }
    const equipmentConflicts = findEquipmentConflicts(resolvedEquipment, resolvedDate, resolvedSlot, existing.id);
    if (equipmentConflicts.length > 0) {
      return res.status(409).json({
        error: `Equipment already assigned to job #${equipmentConflicts[0].job_id} (${equipmentConflicts[0].customer_name}) for that same date and window.`,
      });
    }
  }

  const fields = ["status", "scheduled_date", "scheduled_time_slot", "address", "crew_id", "notes", "actual_cost", "recurring_interval", "review_requested"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      // node:sqlite only accepts null/number/bigint/string/Buffer as bind
      // params — a raw JS boolean (e.g. review_requested: true from the
      // frontend) throws at bind time, so convert it here.
      values.push(typeof req.body[f] === "boolean" ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  });
  if (req.body.equipment_ids !== undefined) {
    updates.push("equipment_ids = ?");
    values.push(JSON.stringify(req.body.equipment_ids));
  }
  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  if (req.body.status && req.body.status !== existing.status) {
    logActivity("job", req.params.id, `Status changed: ${existing.status} \u2192 ${req.body.status}`, req.user && req.user.name);
  }

  // ---- Job marked complete: two automations fire off the same moment ----
  let spawnedJob = null;
  if (req.body.status === "complete" && existing.status !== "complete") {
    // 1. Recurring jobs: if this job was set up to repeat, create the
    // next occurrence now rather than making you remember to.
    if (existing.recurring_interval) {
      const nextDate = nextRecurringDate(resolvedDate || existing.scheduled_date, existing.recurring_interval);
      const spawnResult = db
        .prepare(
          `INSERT INTO jobs (deal_id, status, scheduled_date, scheduled_time_slot, address, crew_id, equipment_ids, notes, recurring_interval, recurrence_parent_id)
           VALUES (?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          existing.deal_id,
          nextDate,
          existing.scheduled_time_slot,
          existing.address,
          existing.crew_id,
          existing.equipment_ids,
          `Auto-created as the next ${existing.recurring_interval} occurrence of job #${existing.id}.`,
          existing.recurring_interval,
          existing.id
        );
      spawnedJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(Number(spawnResult.lastInsertRowid));
      logActivity(
        "job",
        req.params.id,
        `Recurring job \u2014 next occurrence (job #${spawnedJob.id}) auto-scheduled for ${nextDate}`,
        req.user && req.user.name
      );
    }

    // 2. Review request: completing a job is the trigger point, but
    // review_requested itself stays 0 here — it means "we've actually
    // asked," which hasn't happened yet. This just logs that the job
    // is now eligible, so it shows up on the Dashboard's "Review
    // Requests Due" list (jobs complete with review_requested = 0).
    // Staff mark it done via PATCH { review_requested: true } once they
    // actually text/call, which is what prevents asking the same
    // customer twice.
    logActivity("job", req.params.id, "Job complete \u2014 eligible for a review request", req.user && req.user.name);
  }

  // Calendar sync: cancellation removes the event; anything else
  // (new date, address, notes, etc.) updates it. Best-effort, same as
  // on create — never blocks the response.
  if (googleCalendar.isConfigured()) {
    if (req.body.status === "canceled" && existing.google_event_id) {
      await googleCalendar.removeJobEvent(existing.google_event_id);
      db.prepare("UPDATE jobs SET google_event_id = NULL WHERE id = ?").run(req.params.id);
    } else {
      const jobWithCustomer = getJobWithCustomer(req.params.id);
      const eventId = await googleCalendar.syncJob(jobWithCustomer);
      if (eventId && eventId !== existing.google_event_id) {
        db.prepare("UPDATE jobs SET google_event_id = ? WHERE id = ?").run(eventId, req.params.id);
      }
    }
  }

  const updated = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
  res.json({
    job: { ...updated, equipment_ids: JSON.parse(updated.equipment_ids || "[]") },
    spawned_job: spawnedJob,
  });
});

module.exports = router;

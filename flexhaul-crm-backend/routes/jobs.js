// routes/jobs.js
const express = require("express");
const { db, logActivity } = require("../db");
const googleCalendar = require("../services/googleCalendar");
const { TIME_SLOT_KEYS } = require("../constants/timeSlots");

const router = express.Router();
const VALID_STATUSES = ["scheduled", "in_progress", "complete", "canceled"];

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
  const { deal_id, status, scheduled_date, scheduled_time_slot, address, crew_id, equipment_ids, notes } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: "deal_id is required" });

  const deal = db.prepare("SELECT id FROM deals WHERE id = ?").get(deal_id);
  if (!deal) return res.status(400).json({ error: "deal_id does not match an existing deal" });

  if (scheduled_time_slot && !TIME_SLOT_KEYS.includes(scheduled_time_slot)) {
    return res.status(400).json({ error: `scheduled_time_slot must be one of: ${TIME_SLOT_KEYS.join(", ")}` });
  }

  const finalStatus = VALID_STATUSES.includes(status) ? status : "scheduled";
  const result = db
    .prepare(
      `INSERT INTO jobs (deal_id, status, scheduled_date, scheduled_time_slot, address, crew_id, equipment_ids, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      deal_id,
      finalStatus,
      scheduled_date || null,
      scheduled_time_slot || null,
      address || null,
      crew_id || null,
      JSON.stringify(Array.isArray(equipment_ids) ? equipment_ids : []),
      notes || null
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

  const fields = ["status", "scheduled_date", "scheduled_time_slot", "address", "crew_id", "notes"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
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
  res.json({ job: { ...updated, equipment_ids: JSON.parse(updated.equipment_ids || "[]") } });
});

module.exports = router;

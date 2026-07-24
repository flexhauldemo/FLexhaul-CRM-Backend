// routes/invoices.js
const express = require("express");
const { db, logActivity } = require("../db");

const router = express.Router();
const VALID_STATUSES = ["unpaid", "paid", "overdue"];

// GET /api/invoices — list, with customer + job context, optional status filter
router.get("/", (req, res) => {
  const { status } = req.query;
  let sql = `
    SELECT invoices.*, jobs.address AS job_address, jobs.scheduled_date,
           customers.name AS customer_name, customers.phone AS customer_phone
    FROM invoices
    JOIN jobs ON jobs.id = invoices.job_id
    JOIN deals ON deals.id = jobs.deal_id
    JOIN customers ON customers.id = deals.customer_id
  `;
  const params = [];
  if (status) {
    sql += " WHERE invoices.status = ?";
    params.push(status);
  }
  sql += " ORDER BY invoices.created_at DESC";
  res.json({ invoices: db.prepare(sql).all(...params) });
});

// POST /api/invoices — generate from an estimate (via its deal's job) or directly from a job_id + amount
router.post("/", (req, res) => {
  const { job_id, estimate_id, amount, due_date } = req.body || {};
  if (!job_id) return res.status(400).json({ error: "job_id is required" });

  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job_id);
  if (!job) return res.status(400).json({ error: "job_id does not match an existing job" });

  let finalAmount = amount;
  if (finalAmount === undefined && estimate_id) {
    const estimate = db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimate_id);
    if (!estimate) return res.status(400).json({ error: "estimate_id does not match an existing estimate" });
    finalAmount = estimate.total;
  }
  if (finalAmount === undefined) {
    return res.status(400).json({ error: "Provide either amount or estimate_id" });
  }

  const result = db
    .prepare("INSERT INTO invoices (job_id, amount, due_date) VALUES (?, ?, ?)")
    .run(job_id, finalAmount, due_date || null);

  const id = Number(result.lastInsertRowid);
  logActivity("job", job_id, `Invoice #${id} generated \u2014 $${Number(finalAmount).toFixed(2)}`, req.user && req.user.name);
  res.status(201).json({ invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) });
});

// PATCH /api/invoices/:id — mark paid/unpaid/overdue
router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Invoice not found" });

  if (req.body.status !== undefined && !VALID_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  const fields = ["amount", "status", "due_date"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  });
  if (req.body.status === "paid" && existing.status !== "paid") {
    updates.push("paid_at = datetime('now')");
  }
  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(req.params.id);
  db.prepare(`UPDATE invoices SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  if (req.body.status && req.body.status !== existing.status) {
    logActivity("job", existing.job_id, `Invoice #${req.params.id} marked ${req.body.status}`, req.user && req.user.name);
  }

  res.json({ invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) });
});

module.exports = router;

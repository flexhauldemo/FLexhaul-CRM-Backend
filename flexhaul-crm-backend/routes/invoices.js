// routes/invoices.js
const express = require("express");
const crypto = require("crypto");
const { db, logActivity, advanceDealStage } = require("../db");
const { buildInvoicePdf } = require("../services/invoicePdf");

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
  let lineItems = "[]";
  if (finalAmount === undefined && estimate_id) {
    const estimate = db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimate_id);
    if (!estimate) return res.status(400).json({ error: "estimate_id does not match an existing estimate" });
    finalAmount = estimate.total;
    lineItems = estimate.line_items;
  }
  if (finalAmount === undefined) {
    return res.status(400).json({ error: "Provide either amount or estimate_id" });
  }

  const result = db
    .prepare("INSERT INTO invoices (job_id, amount, line_items, due_date, share_token) VALUES (?, ?, ?, ?, ?)")
    .run(job_id, finalAmount, lineItems, due_date || null, crypto.randomBytes(16).toString("hex"));

  const id = Number(result.lastInsertRowid);
  logActivity("job", job_id, `Invoice #${id} generated \u2014 $${Number(finalAmount).toFixed(2)}`, req.user && req.user.name);

  // Auto-advance: a real invoice existing means the deal has genuinely
  // reached "Invoiced" — forward-only, so this never fires for a deal
  // that's already further along (e.g. already paid off and closed out).
  advanceDealStage(
    job.deal_id,
    "invoiced",
    `Invoice #${id} generated \u2014 deal automatically moved to Invoiced`,
    req.user && req.user.name
  );

  res.status(201).json({ invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) });
});

// GET /api/invoices/:id/pdf — itemized invoice as a downloadable PDF.
// Pulls the same customer/job join as the list view so the PDF has
// everything it needs in one query.
router.get("/:id/pdf", async (req, res) => {
  const invoice = db
    .prepare(
      `SELECT invoices.*, jobs.address AS job_address,
              customers.name AS customer_name, customers.phone AS customer_phone, customers.email AS customer_email
       FROM invoices
       JOIN jobs ON jobs.id = invoices.job_id
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE invoices.id = ?`
    )
    .get(req.params.id);
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });

  try {
    const pdfBuffer = await buildInvoicePdf(invoice);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="FlexHaul-Invoice-${invoice.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("PDF generation failed:", err.message);
    res.status(500).json({ error: "Could not generate PDF" });
  }
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

    // Closes the loop: a paid invoice means the deal is genuinely done,
    // so it moves to its final stage automatically instead of sitting in
    // "Won" forever and getting double-counted as still-open pipeline
    // value in reporting even though the money's already in.
    if (req.body.status === "paid") {
      const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(existing.job_id);
      if (job) {
        db.prepare("UPDATE deals SET stage = 'invoiced', updated_at = datetime('now') WHERE id = ? AND stage != 'invoiced'").run(job.deal_id);
        db.prepare("UPDATE jobs SET status = 'complete', updated_at = datetime('now') WHERE id = ? AND status != 'complete'").run(job.id);
      }
    }
  }

  res.json({ invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id) });
});

module.exports = router;

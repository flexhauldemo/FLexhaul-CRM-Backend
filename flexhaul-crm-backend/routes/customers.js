// routes/customers.js
const express = require("express");
const { db, logActivity } = require("../db");

const router = express.Router();

// GET /api/customers — list, with optional search
router.get("/", (req, res) => {
  const { q } = req.query;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db
      .prepare(
        "SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY updated_at DESC"
      )
      .all(like, like, like);
  } else {
    rows = db.prepare("SELECT * FROM customers ORDER BY updated_at DESC").all();
  }
  res.json({ customers: rows });
});

// GET /api/customers/:id — detail, with their deals and jobs
router.get("/:id", (req, res) => {
  const customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!customer) return res.status(404).json({ error: "Customer not found" });

  const deals = db
    .prepare("SELECT * FROM deals WHERE customer_id = ? ORDER BY created_at DESC")
    .all(req.params.id);

  // Every job across every deal this customer has ever had — this is
  // what actually answers "show me their past and future work," since
  // dates/addresses/status live on jobs, not deals. Split into upcoming
  // vs past so the customer detail view can show both clearly without
  // the caller having to do date math itself.
  const allJobs = db
    .prepare(
      `SELECT jobs.*, crews.name AS crew_name
       FROM jobs
       JOIN deals ON deals.id = jobs.deal_id
       LEFT JOIN crews ON crews.id = jobs.crew_id
       WHERE deals.customer_id = ?
       ORDER BY jobs.scheduled_date DESC`
    )
    .all(req.params.id)
    .map((j) => ({ ...j, equipment_ids: JSON.parse(j.equipment_ids || "[]") }));

  const today = new Date().toISOString().slice(0, 10);
  const upcomingJobs = allJobs
    .filter((j) => j.scheduled_date && j.scheduled_date >= today && j.status !== "canceled" && j.status !== "complete")
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  const pastJobs = allJobs.filter(
    (j) => !j.scheduled_date || j.scheduled_date < today || j.status === "complete" || j.status === "canceled"
  );

  const activity = db
    .prepare(
      "SELECT * FROM activity_log WHERE entity_type = 'customer' AND entity_id = ? ORDER BY created_at DESC LIMIT 50"
    )
    .all(req.params.id);

  // Lifetime value — every invoice this customer has actually paid,
  // across every deal and job they've ever had, regardless of whether
  // that deal is still open or already archived. This is the number
  // that answers "is this a repeat customer worth prioritizing," at a
  // glance, without digging through their whole history.
  const ltv = db
    .prepare(
      `SELECT COALESCE(SUM(invoices.amount), 0) AS total, COUNT(*) AS job_count
       FROM invoices
       JOIN jobs ON jobs.id = invoices.job_id
       JOIN deals ON deals.id = jobs.deal_id
       WHERE deals.customer_id = ? AND invoices.status = 'paid'`
    )
    .get(req.params.id);

  res.json({
    customer,
    deals,
    upcoming_jobs: upcomingJobs,
    past_jobs: pastJobs,
    activity,
    lifetime_value: ltv.total,
    completed_job_count: ltv.job_count,
  });
});

// POST /api/customers
router.post("/", (req, res) => {
  const { name, type, phone, email, address, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: "Customer name is required" });

  const result = db
    .prepare(
      "INSERT INTO customers (name, type, phone, email, address, notes) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(name, type || "homeowner", phone || null, email || null, address || null, notes || null);

  const id = Number(result.lastInsertRowid);
  logActivity("customer", id, `Customer "${name}" created`, req.user && req.user.name);
  res.status(201).json({ customer: db.prepare("SELECT * FROM customers WHERE id = ?").get(id) });
});

// PATCH /api/customers/:id
router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  // If the phone or email being saved already belongs to a DIFFERENT
  // customer, warn rather than silently proceed — this is exactly the
  // kind of mistake that quietly links two different people's history
  // together. But don't hard-block it either: a shared household phone
  // is a real, legitimate case, so the caller can explicitly confirm
  // past this with confirm_collision and it goes through as normal.
  if (!req.body.confirm_collision) {
    if (req.body.phone !== undefined && req.body.phone && req.body.phone !== existing.phone) {
      const collision = db
        .prepare("SELECT id, name FROM customers WHERE phone = ? AND id != ?")
        .get(req.body.phone, req.params.id);
      if (collision) {
        return res.status(409).json({
          error: `This phone number is already on file for ${collision.name}.`,
          field: "phone",
          conflictingCustomer: collision,
        });
      }
    }
    if (req.body.email !== undefined && req.body.email && req.body.email !== existing.email) {
      const collision = db
        .prepare("SELECT id, name FROM customers WHERE email = ? AND id != ?")
        .get(req.body.email, req.params.id);
      if (collision) {
        return res.status(409).json({
          error: `This email address is already on file for ${collision.name}.`,
          field: "email",
          conflictingCustomer: collision,
        });
      }
    }
  }

  const fields = ["name", "type", "phone", "email", "address", "notes"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      // Trim consistently with how a website inquiry's contact info is
      // cleaned (see routes/publicInquiries.js) — a wandering space at
      // the start/end of a hand-typed correction shouldn't be able to
      // make an otherwise-matching phone number fail to match later.
      const value = typeof req.body[f] === "string" ? req.body[f].trim() : req.body[f];
      updates.push(`${f} = ?`);
      values.push(value === "" ? null : value);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE customers SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  logActivity("customer", req.params.id, "Customer details updated", req.user && req.user.name);
  res.json({ customer: db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id) });
});

// POST /api/customers/:id/reassign-deals — moves one or more deals from
// this customer to a different, existing customer. Built for exactly
// the situation where an estimate already got accepted against a
// profile that turned out to be incomplete or a duplicate: rather than
// losing that history, it gets re-pointed at the correct customer
// record, with every estimate, job, invoice, and document underneath
// it following along untouched — nothing is copied or recreated, only
// the ownership (deals.customer_id) changes.
router.post("/:id/reassign-deals", (req, res) => {
  const source = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!source) return res.status(404).json({ error: "Customer not found" });

  const targetId = req.body.target_customer_id;
  if (!targetId) return res.status(400).json({ error: "target_customer_id is required" });
  if (String(targetId) === String(req.params.id)) {
    return res.status(400).json({ error: "Can't reassign a customer's deals to themselves." });
  }
  const target = db.prepare("SELECT * FROM customers WHERE id = ?").get(targetId);
  if (!target) return res.status(400).json({ error: "target_customer_id does not match an existing customer" });

  // Only ever moves deals that actually belong to the source customer —
  // an id list from the client is never trusted blindly. Omitting
  // deal_ids entirely reassigns everything this customer has, which is
  // the common case (merging a duplicate profile into the real one).
  const dealIds = Array.isArray(req.body.deal_ids) && req.body.deal_ids.length > 0
    ? req.body.deal_ids
    : db.prepare("SELECT id FROM deals WHERE customer_id = ?").all(req.params.id).map((d) => d.id);

  let moved = 0;
  dealIds.forEach((dealId) => {
    const result = db
      .prepare("UPDATE deals SET customer_id = ?, updated_at = datetime('now') WHERE id = ? AND customer_id = ?")
      .run(targetId, dealId, req.params.id);
    if (result.changes > 0) {
      moved++;
      logActivity("deal", dealId, `Reassigned from "${source.name}" to "${target.name}"`, req.user && req.user.name);
    }
  });

  logActivity("customer", req.params.id, `${moved} deal${moved === 1 ? "" : "s"} reassigned to "${target.name}"`, req.user && req.user.name);
  logActivity("customer", targetId, `${moved} deal${moved === 1 ? "" : "s"} reassigned from "${source.name}"`, req.user && req.user.name);

  res.json({ ok: true, moved, target_customer: target });
});

// DELETE /api/customers/:id — only ever allowed once this customer has
// zero deals attached. This is deliberately not a cascading delete: the
// realistic case this exists for is cleaning up an empty duplicate
// profile *after* reassigning its work elsewhere with the endpoint
// above, not erasing a customer along with real history in one step.
router.delete("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Customer not found" });

  const dealCount = db.prepare("SELECT COUNT(*) AS n FROM deals WHERE customer_id = ?").get(req.params.id).n;
  if (dealCount > 0) {
    return res.status(400).json({
      error: `This customer still has ${dealCount} deal${dealCount === 1 ? "" : "s"} attached. Reassign them to another customer first, then erase.`,
      dealCount,
    });
  }

  db.prepare("DELETE FROM customers WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

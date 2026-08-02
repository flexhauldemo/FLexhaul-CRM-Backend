// routes/deals.js
const express = require("express");
const { db, logActivity } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const VALID_STAGES = ["new_lead", "quoted", "won", "scheduled", "complete", "invoiced", "lost"];

// POST /api/deals/resync-values — admin-only, one-time cleanup tool.
// Fixes deals whose estimate was created before the automatic sync (added
// to estimates.js) existed — those deals are permanently stuck showing
// $0 even though a real estimate is attached, since nothing ever wrote
// that number back onto the deal. Safe to run more than once; it only
// ever sets a deal's value to match its own most recent estimate, never
// touches deals with no estimate at all.
router.post("/resync-values", requireAdmin, (req, res) => {
  const deals = db.prepare("SELECT id, estimated_value FROM deals").all();
  let updated = 0;

  deals.forEach((deal) => {
    const latestEstimate = db
      .prepare("SELECT total FROM estimates WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(deal.id);
    if (latestEstimate && latestEstimate.total !== deal.estimated_value) {
      db.prepare("UPDATE deals SET estimated_value = ?, updated_at = datetime('now') WHERE id = ?").run(
        latestEstimate.total,
        deal.id
      );
      updated++;
    }
  });

  res.json({ ok: true, dealsChecked: deals.length, dealsUpdated: updated });
});

// GET /api/deals — all deals, joined with customer name, optionally filtered by stage.
// This is what powers the Kanban pipeline view.
router.get("/", (req, res) => {
  const { stage } = req.query;
  let rows;
  const base = `
    SELECT deals.*, customers.name AS customer_name, customers.phone AS customer_phone
    FROM deals JOIN customers ON customers.id = deals.customer_id
  `;
  if (stage) {
    rows = db.prepare(`${base} WHERE deals.stage = ? ORDER BY deals.updated_at DESC`).all(stage);
  } else {
    rows = db.prepare(`${base} ORDER BY deals.updated_at DESC`).all();
  }
  res.json({ deals: rows });
});

// GET /api/deals/:id — detail, with estimates, jobs, and activity
router.get("/:id", (req, res) => {
  const deal = db
    .prepare(
      `SELECT deals.*, customers.name AS customer_name, customers.phone AS customer_phone,
              customers.email AS customer_email, customers.address AS customer_address
       FROM deals JOIN customers ON customers.id = deals.customer_id
       WHERE deals.id = ?`
    )
    .get(req.params.id);
  if (!deal) return res.status(404).json({ error: "Deal not found" });

  const estimates = db.prepare("SELECT * FROM estimates WHERE deal_id = ? ORDER BY created_at DESC").all(req.params.id);
  const jobs = db.prepare("SELECT * FROM jobs WHERE deal_id = ? ORDER BY created_at DESC").all(req.params.id);
  // Invoices don't have a direct deal_id — they belong to a job, which
  // belongs to a deal — so this joins through jobs to find every invoice
  // tied to any job under this deal.
  const invoices = db
    .prepare(
      `SELECT invoices.* FROM invoices
       JOIN jobs ON jobs.id = invoices.job_id
       WHERE jobs.deal_id = ?
       ORDER BY invoices.created_at DESC`
    )
    .all(req.params.id);
  const activity = db
    .prepare("SELECT * FROM activity_log WHERE entity_type = 'deal' AND entity_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(req.params.id);

  res.json({ deal, estimates, jobs, invoices, activity });
});

// POST /api/deals
router.post("/", (req, res) => {
  const { customer_id, stage, source, estimated_value, service_type } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: "customer_id is required" });

  const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(customer_id);
  if (!customer) return res.status(400).json({ error: "customer_id does not match an existing customer" });

  const finalStage = VALID_STAGES.includes(stage) ? stage : "new_lead";
  const result = db
    .prepare(
      "INSERT INTO deals (customer_id, stage, source, estimated_value, service_type) VALUES (?, ?, ?, ?, ?)"
    )
    .run(customer_id, finalStage, source || "other", estimated_value || 0, service_type || null);

  const id = Number(result.lastInsertRowid);
  logActivity("deal", id, `Deal created (stage: ${finalStage})`, req.user && req.user.name);
  res.status(201).json({ deal: db.prepare("SELECT * FROM deals WHERE id = ?").get(id) });
});

// PATCH /api/deals/:id — used both for general edits and for moving stages on the pipeline board
router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Deal not found" });

  if (req.body.stage !== undefined && !VALID_STAGES.includes(req.body.stage)) {
    return res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(", ")}` });
  }

  const fields = ["stage", "source", "estimated_value", "notes", "service_type"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE deals SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  let autoCreated = null;

  if (req.body.stage && req.body.stage !== existing.stage) {
    logActivity(
      "deal",
      req.params.id,
      `Stage changed: ${existing.stage} \u2192 ${req.body.stage}`,
      req.user && req.user.name
    );

    // The automation the business actually asked for: once a quote is
    // agreed to (the deal moves into "won"), a Job and an Invoice build
    // themselves — no separate manual steps. The job comes out
    // unscheduled (no date yet, since that's a real-world scheduling
    // decision a person still has to make) but it already exists and is
    // ready to be dated from the Jobs screen or Calendar. Guarded so this
    // only ever fires once per deal, even if the stage gets set to "won"
    // again later (e.g. after being moved back and forward).
    if (req.body.stage === "won") {
      const alreadyHasJob = db.prepare("SELECT id FROM jobs WHERE deal_id = ?").get(req.params.id);
      const latestEstimate = db
        .prepare("SELECT * FROM estimates WHERE deal_id = ? ORDER BY created_at DESC LIMIT 1")
        .get(req.params.id);

      if (!alreadyHasJob && latestEstimate) {
        const dealWithCustomer = db
          .prepare(
            `SELECT deals.*, customers.address AS customer_address
             FROM deals JOIN customers ON customers.id = deals.customer_id
             WHERE deals.id = ?`
          )
          .get(req.params.id);

        const jobResult = db
          .prepare("INSERT INTO jobs (deal_id, status, address) VALUES (?, 'scheduled', ?)")
          .run(req.params.id, dealWithCustomer.customer_address || null);
        const jobId = Number(jobResult.lastInsertRowid);
        logActivity("job", jobId, "Job auto-created — deal marked won with an agreed estimate", req.user && req.user.name);

        const invoiceResult = db
          .prepare("INSERT INTO invoices (job_id, amount, status) VALUES (?, ?, 'unpaid')")
          .run(jobId, latestEstimate.total);
        const invoiceId = Number(invoiceResult.lastInsertRowid);
        logActivity(
          "job",
          jobId,
          `Invoice #${invoiceId} auto-created \u2014 $${Number(latestEstimate.total).toFixed(2)}`,
          req.user && req.user.name
        );

        autoCreated = { job_id: jobId, invoice_id: invoiceId };
      }
    }
  }

  res.json({ deal: db.prepare("SELECT * FROM deals WHERE id = ?").get(req.params.id), auto_created: autoCreated });
});

module.exports = router;

// services/estimateAcceptance.js
//
// The core "customer said yes" logic, shared by two entry points:
//   - POST /api/estimates/:id/accept   (staff clicks Accept in the CRM)
//   - POST /api/public/estimates/:token/approve  (customer taps Approve
//     on the link you send them — no login)
//
// Kept in one place so both paths are guaranteed to behave identically —
// create the job, advance the deal — rather than two copies of the same
// logic quietly drifting apart over time.
//
// IMPORTANT: this used to also auto-create an invoice at the same moment.
// That's been removed on purpose — invoicing is now its own deliberate
// step (see routes/invoices.js), so the stage progression actually means
// something: Won happens here, Scheduled happens when a job gets a real
// date, Invoiced happens when a real invoice gets created. An invoice
// appearing at the same instant as "Won" would have skipped straight to
// "Invoiced" before anything was even scheduled.

const { db, logActivity } = require("../db");

class AcceptanceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// approvedBy: a human-readable string for the activity log, e.g.
// "Julius Franklin" (staff) or "Customer (online approval)".
function acceptEstimate(estimateId, approvedBy) {
  const estimate = db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimateId);
  if (!estimate) throw new AcceptanceError("Estimate not found", 404);
  if (estimate.accepted) throw new AcceptanceError("This estimate has already been accepted.", 400);

  const deal = db
    .prepare(
      `SELECT deals.*, customers.address AS customer_address
       FROM deals JOIN customers ON customers.id = deals.customer_id
       WHERE deals.id = ?`
    )
    .get(estimate.deal_id);
  if (!deal) throw new AcceptanceError("This estimate's deal no longer exists.", 400);

  db.prepare("UPDATE estimates SET accepted = 1, updated_at = datetime('now') WHERE id = ?").run(estimate.id);

  const EARLY_STAGES = ["new_lead", "quoted"];
  if (EARLY_STAGES.includes(deal.stage)) {
    db.prepare("UPDATE deals SET stage = 'won', updated_at = datetime('now') WHERE id = ?").run(deal.id);
  }

  const jobResult = db
    .prepare("INSERT INTO jobs (deal_id, status, address, notes) VALUES (?, 'scheduled', ?, ?)")
    .run(
      deal.id,
      deal.customer_address || null,
      "Created automatically when the estimate was accepted \u2014 pick a date to schedule it."
    );
  const jobId = Number(jobResult.lastInsertRowid);

  logActivity(
    "deal",
    deal.id,
    `Estimate accepted ($${estimate.total.toFixed(2)}) by ${approvedBy} \u2014 job #${jobId} created automatically, ready to schedule`,
    approvedBy
  );

  return {
    estimate: db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimate.id),
    job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId),
  };
}

module.exports = { acceptEstimate, AcceptanceError };

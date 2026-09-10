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

const { db, logActivity, syncDealValue } = require("../db");

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

  // The accepted estimate is now the deal's real, committed price —
  // make sure that's what shows everywhere, regardless of whether some
  // other (unaccepted) estimate happened to be created more recently.
  syncDealValue(deal.id);

  // A deal only ever gets ONE job out of this flow. If a leftover draft
  // or a revised estimate on the same deal gets accepted after a job
  // already exists — which is exactly what "Accept" buttons on old
  // duplicate estimates make possible — this must not spawn a second,
  // duplicate job. The existing job just inherits the new agreed price.
  const existingJob = db.prepare("SELECT * FROM jobs WHERE deal_id = ? ORDER BY created_at ASC LIMIT 1").get(deal.id);
  if (existingJob) {
    logActivity(
      "deal",
      deal.id,
      `A different estimate ($${estimate.total.toFixed(2)}) was accepted by ${approvedBy} \u2014 job #${existingJob.id} already exists, so no new job was created; the deal's value was updated instead.`,
      approvedBy
    );
    return {
      estimate: db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimate.id),
      job: existingJob,
      job_already_existed: true,
    };
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
    job_already_existed: false,
  };
}

module.exports = { acceptEstimate, AcceptanceError };

// services/estimateAcceptance.js
//
// The core "customer said yes" logic, shared by THREE entry points:
//   - POST /api/estimates/:id/accept   (staff clicks Accept in the CRM)
//   - POST /api/public/estimates/:token/approve  (customer taps Approve
//     on the link you send them — no login)
//   - PATCH /api/deals/:id with { stage: "won" }  (staff drags/selects
//     Won directly on the Pipeline board, without going through an
//     Accept button)
//
// Kept in one place so all three paths are guaranteed to behave
// identically — create the job, create the invoice with a real
// share_token/due_date/line_items, advance the deal — rather than
// multiple copies of the same logic quietly drifting apart over time.

const crypto = require("crypto");
const { db, logActivity } = require("../db");

class AcceptanceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Creates the job + invoice for a deal that just became Won, from
// whichever estimate is driving it. Always stamps the invoice with a
// share_token, due_date, and a line_items snapshot — this is the piece
// that was previously missing when a deal was marked Won by dragging it
// on the Pipeline board instead of clicking Accept, which silently
// produced invoices with no way to generate a customer payment link.
function createJobAndInvoice(deal, estimate, approvedBy) {
  const jobResult = db
    .prepare("INSERT INTO jobs (deal_id, status, address, notes) VALUES (?, 'scheduled', ?, ?)")
    .run(
      deal.id,
      deal.customer_address || null,
      "Created automatically when the deal was marked won \u2014 pick a date when ready."
    );
  const jobId = Number(jobResult.lastInsertRowid);

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);
  const invoiceShareToken = crypto.randomBytes(16).toString("hex");
  const invoiceResult = db
    .prepare("INSERT INTO invoices (job_id, amount, line_items, due_date, share_token) VALUES (?, ?, ?, ?, ?)")
    .run(jobId, estimate.total, estimate.line_items, dueDate.toISOString().slice(0, 10), invoiceShareToken);
  const invoiceId = Number(invoiceResult.lastInsertRowid);

  logActivity(
    "deal",
    deal.id,
    `Job #${jobId} and invoice #${invoiceId} created automatically ($${Number(estimate.total).toFixed(2)}) \u2014 ${approvedBy}`,
    approvedBy
  );

  return {
    job: db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId),
    invoice: db.prepare("SELECT * FROM invoices WHERE id = ?").get(invoiceId),
  };
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

  logActivity(
    "estimate",
    estimate.id,
    `Estimate accepted ($${estimate.total.toFixed(2)}) by ${approvedBy}`,
    approvedBy
  );

  const { job, invoice } = createJobAndInvoice(deal, estimate, approvedBy);

  return {
    estimate: db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimate.id),
    job,
    invoice,
  };
}

module.exports = { acceptEstimate, createJobAndInvoice, AcceptanceError };

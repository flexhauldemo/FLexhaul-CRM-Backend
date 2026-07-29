// routes/publicShare.js
//
// The customer-facing side of the CRM — no login, reached only by
// knowing a random share_token (mailed/texted as a link, not guessable
// by walking sequential IDs). Two things live here:
//   - viewing + approving an estimate
//   - viewing an invoice + getting a payment link (Square or Stripe,
//     whichever is configured) if either is set up
//
// Nothing here trusts anything from the request except the token itself
// — every write action re-derives what it needs from the database.

const express = require("express");
const { db } = require("../db");
const { acceptEstimate, AcceptanceError } = require("../services/estimateAcceptance");
const stripePayments = require("../services/stripePayments");
const squarePayments = require("../services/squarePayments");

const router = express.Router();

// GET /api/public/estimates/:token
router.get("/estimates/:token", (req, res) => {
  const estimate = db
    .prepare(
      `SELECT estimates.*, customers.name AS customer_name, deals.id AS deal_id
       FROM estimates
       JOIN deals ON deals.id = estimates.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE estimates.share_token = ?`
    )
    .get(req.params.token);
  if (!estimate) return res.status(404).json({ error: "Estimate not found or link is invalid." });

  res.json({
    estimate: {
      id: estimate.id,
      customer_name: estimate.customer_name,
      line_items: JSON.parse(estimate.line_items),
      total: estimate.total,
      accepted: !!estimate.accepted,
      customer_approved_at: estimate.customer_approved_at,
    },
  });
});

// POST /api/public/estimates/:token/approve — the customer taps "Approve"
router.post("/estimates/:token/approve", (req, res) => {
  const estimate = db.prepare("SELECT * FROM estimates WHERE share_token = ?").get(req.params.token);
  if (!estimate) return res.status(404).json({ error: "Estimate not found or link is invalid." });

  try {
    acceptEstimate(estimate.id, "Customer (online approval)");
    db.prepare("UPDATE estimates SET customer_approved_at = datetime('now') WHERE id = ?").run(estimate.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof AcceptanceError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Public estimate approval failed:", err.message);
    res.status(500).json({ error: "Something went wrong. Please call or text us instead." });
  }
});

// GET /api/public/invoices/:token
router.get("/invoices/:token", (req, res) => {
  const invoice = db
    .prepare(
      `SELECT invoices.*, jobs.address AS job_address,
              customers.name AS customer_name
       FROM invoices
       JOIN jobs ON jobs.id = invoices.job_id
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE invoices.share_token = ?`
    )
    .get(req.params.token);
  if (!invoice) return res.status(404).json({ error: "Invoice not found or link is invalid." });

  res.json({
    invoice: {
      id: invoice.id,
      customer_name: invoice.customer_name,
      job_address: invoice.job_address,
      line_items: JSON.parse(invoice.line_items),
      amount: invoice.amount,
      status: invoice.status,
      due_date: invoice.due_date,
      stripe_payment_link: invoice.stripe_payment_link,
      square_payment_link: invoice.square_payment_link,
    },
    payments_enabled: squarePayments.isConfigured() || stripePayments.isConfigured(),
  });
});

// POST /api/public/invoices/:token/pay-link — creates (or reuses) a
// payment link for this invoice. Tries Square first if it's configured
// (most contractors already have a Square merchant account for taking
// payments in person), falls back to Stripe if only that's set up.
// Separate from the GET above so a link is only ever generated when the
// customer actually clicks "Pay", not on every page view.
router.post("/invoices/:token/pay-link", async (req, res) => {
  const invoice = db
    .prepare(
      `SELECT invoices.*, customers.name AS customer_name
       FROM invoices
       JOIN jobs ON jobs.id = invoices.job_id
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE invoices.share_token = ?`
    )
    .get(req.params.token);
  if (!invoice) return res.status(404).json({ error: "Invoice not found or link is invalid." });
  if (invoice.status === "paid") return res.status(400).json({ error: "This invoice is already paid." });

  const useSquare = squarePayments.isConfigured();
  const useStripe = !useSquare && stripePayments.isConfigured();

  if (!useSquare && !useStripe) {
    return res.status(503).json({ error: "Online payment isn't set up yet. Please call or text us to pay." });
  }

  if (useSquare && invoice.square_payment_link) {
    return res.json({ url: invoice.square_payment_link });
  }
  if (useStripe && invoice.stripe_payment_link) {
    return res.json({ url: invoice.stripe_payment_link });
  }

  const result = useSquare ? await squarePayments.createPaymentLink(invoice) : await stripePayments.createPaymentLink(invoice);
  if (!result) {
    return res.status(500).json({ error: "Could not create a payment link right now. Please call or text us to pay." });
  }

  if (useSquare) {
    db.prepare("UPDATE invoices SET square_payment_link = ? WHERE id = ?").run(result.url, invoice.id);
  } else {
    db.prepare("UPDATE invoices SET stripe_payment_link = ?, stripe_session_id = ? WHERE id = ?").run(
      result.url,
      result.sessionId,
      invoice.id
    );
  }

  res.json({ url: result.url });
});

// GET /api/public/item-list — a price-free version of the catalog for
// the website's "get a quote" dropdown. Deliberately strips out rate,
// type, and unit — a customer picking "Standard Couch" from a list on
// your public site should never be able to see what you charge for it
// before you've had a chance to quote them. Keep this endpoint's
// response shape minimal on purpose; don't add pricing fields here even
// if it seems convenient later.
router.get("/item-list", (req, res) => {
  // Travel & Adjustments is internal pricing logic (mileage surcharges,
  // stairs, disassembly) — not something a customer picks as "what do
  // you have," so it's excluded from what they see.
  const rows = db
    .prepare("SELECT category, label FROM price_catalog WHERE category != 'Travel & Adjustments' ORDER BY category, label")
    .all();
  res.json({ items: rows });
});

module.exports = router;

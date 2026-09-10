const crypto = require("crypto");

// routes/estimates.js
const express = require("express");
const { db, logActivity, syncDealValue } = require("../db");
const { acceptEstimate, AcceptanceError } = require("../services/estimateAcceptance");

const router = express.Router();

// The only thing that locks an estimate is being the one actually relied
// on for money already committed — i.e. it's been accepted (whether via
// the explicit Accept button, or because it was the estimate used when a
// deal got marked Won by hand). Nothing else about the deal matters: a
// leftover draft or duplicate estimate that was never accepted stays
// editable and deletable no matter what stage the deal has since moved
// to, because nothing downstream depends on its numbers.
function getEditabilityInfo(estimateId) {
  const estimate = db.prepare("SELECT * FROM estimates WHERE id = ?").get(estimateId);
  if (!estimate) return { estimate: null, deal: null, editable: false };
  const deal = db.prepare("SELECT * FROM deals WHERE id = ?").get(estimate.deal_id);
  return { estimate, deal, editable: !estimate.accepted };
}

// Line items look like:
//   { type: 'labor'|'equipment'|'disposal'|'tonnage'|'cubic_yards'|'other',
//     label: string, qty: number, unit: string, rate: number, amount: number }
// amount is always recomputed server-side as qty*rate, never trusted from the client.
function computeTotal(lineItems) {
  return lineItems.reduce((sum, item) => {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    item.amount = Math.round(qty * rate * 100) / 100;
    return sum + item.amount;
  }, 0);
}

// GET /api/estimates/:id
router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM estimates WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Estimate not found" });
  const { editable } = getEditabilityInfo(req.params.id);
  res.json({ estimate: { ...row, line_items: JSON.parse(row.line_items), editable } });
});

// POST /api/estimates — create against a deal
router.post("/", (req, res) => {
  const { deal_id, line_items } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: "deal_id is required" });

  const deal = db.prepare("SELECT id FROM deals WHERE id = ?").get(deal_id);
  if (!deal) return res.status(400).json({ error: "deal_id does not match an existing deal" });

  const items = Array.isArray(line_items) ? line_items : [];
  const total = computeTotal(items);
  const shareToken = crypto.randomBytes(16).toString("hex");

  const result = db
    .prepare("INSERT INTO estimates (deal_id, line_items, total, share_token) VALUES (?, ?, ?, ?)")
    .run(deal_id, JSON.stringify(items), total, shareToken);

  const id = Number(result.lastInsertRowid);

  // Keep the deal's dollar value in sync — but never at the expense of
  // an already-accepted estimate's total (see syncDealValue above).
  syncDealValue(deal_id);

  logActivity("estimate", id, `Estimate created — total $${total.toFixed(2)}`, req.user && req.user.name);
  res.status(201).json({ estimate: { ...db.prepare("SELECT * FROM estimates WHERE id = ?").get(id), line_items: items } });
});

// PATCH /api/estimates/:id — replace line items, total is recalculated.
// Blocked once this specific estimate has been accepted — see
// getEditabilityInfo above.
router.patch("/:id", (req, res) => {
  const { estimate: existing, editable } = getEditabilityInfo(req.params.id);
  if (!existing) return res.status(404).json({ error: "Estimate not found" });
  if (!editable) {
    return res.status(400).json({
      error: "This estimate has already been accepted and can't be edited. Create a new estimate instead.",
    });
  }

  const items = Array.isArray(req.body.line_items) ? req.body.line_items : JSON.parse(existing.line_items);
  const total = computeTotal(items);

  db.prepare("UPDATE estimates SET line_items = ?, total = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(items),
    total,
    req.params.id
  );

  syncDealValue(existing.deal_id);

  logActivity("estimate", req.params.id, `Estimate updated — total $${total.toFixed(2)}`, req.user && req.user.name);
  res.json({ estimate: { ...db.prepare("SELECT * FROM estimates WHERE id = ?").get(req.params.id), line_items: items } });
});

// DELETE /api/estimates/:id — same "not accepted yet" guard as editing.
router.delete("/:id", (req, res) => {
  const { estimate: existing, editable } = getEditabilityInfo(req.params.id);
  if (!existing) return res.status(404).json({ error: "Estimate not found" });
  if (!editable) {
    return res.status(400).json({ error: "This estimate has already been accepted and can't be deleted." });
  }

  db.prepare("DELETE FROM estimates WHERE id = ?").run(req.params.id);
  syncDealValue(existing.deal_id);

  logActivity("estimate", req.params.id, `Estimate deleted (was $${Number(existing.total).toFixed(2)})`, req.user && req.user.name);
  res.json({ ok: true });
});

// POST /api/estimates/:id/accept — the "customer said yes" button.
// Automatically: marks the estimate accepted, moves the deal to Won (if
// it isn't further along already), creates a job (unscheduled — pick the
// date separately once you know it), and generates an invoice for the
// estimate's total. This is deliberately one action instead of four
// manual ones, since "accepted" is the actual decision point where all
// of that becomes true at once.
router.post("/:id/accept", (req, res) => {
  try {
    const result = acceptEstimate(req.params.id, (req.user && req.user.name) || "Staff");
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AcceptanceError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Accept estimate failed:", err.message);
    res.status(500).json({ error: "Something went wrong accepting this estimate." });
  }
});

module.exports = router;


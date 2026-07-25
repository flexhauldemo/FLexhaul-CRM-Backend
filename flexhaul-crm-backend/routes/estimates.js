const crypto = require("crypto");

// routes/estimates.js
const express = require("express");
const { db, logActivity } = require("../db");
const { acceptEstimate, AcceptanceError } = require("../services/estimateAcceptance");

const router = express.Router();

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
  res.json({ estimate: { ...row, line_items: JSON.parse(row.line_items) } });
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

  // Keep the deal's dollar value in sync with its estimate — otherwise a
  // deal that started at $0 (e.g. from a website inquiry, which has no
  // price yet) would keep showing as $0 on the Pipeline board and
  // Dashboard even after a real estimate is attached to it.
  db.prepare("UPDATE deals SET estimated_value = ?, updated_at = datetime('now') WHERE id = ?").run(total, deal_id);

  logActivity("estimate", id, `Estimate created — total $${total.toFixed(2)}`, req.user && req.user.name);
  res.status(201).json({ estimate: { ...db.prepare("SELECT * FROM estimates WHERE id = ?").get(id), line_items: items } });
});

// PATCH /api/estimates/:id — replace line items, total is recalculated
router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM estimates WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Estimate not found" });

  const items = Array.isArray(req.body.line_items) ? req.body.line_items : JSON.parse(existing.line_items);
  const total = computeTotal(items);

  db.prepare("UPDATE estimates SET line_items = ?, total = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(items),
    total,
    req.params.id
  );

  // Same sync as on creation — an edited estimate should immediately
  // update what the deal is worth everywhere it's shown.
  db.prepare("UPDATE deals SET estimated_value = ?, updated_at = datetime('now') WHERE id = ?").run(total, existing.deal_id);

  logActivity("estimate", req.params.id, `Estimate updated — total $${total.toFixed(2)}`, req.user && req.user.name);
  res.json({ estimate: { ...db.prepare("SELECT * FROM estimates WHERE id = ?").get(req.params.id), line_items: items } });
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

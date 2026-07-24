// routes/estimates.js
const express = require("express");
const { db, logActivity } = require("../db");

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

  const result = db
    .prepare("INSERT INTO estimates (deal_id, line_items, total) VALUES (?, ?, ?)")
    .run(deal_id, JSON.stringify(items), total);

  const id = Number(result.lastInsertRowid);
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

  logActivity("estimate", req.params.id, `Estimate updated — total $${total.toFixed(2)}`, req.user && req.user.name);
  res.json({ estimate: { ...db.prepare("SELECT * FROM estimates WHERE id = ?").get(req.params.id), line_items: items } });
});

module.exports = router;

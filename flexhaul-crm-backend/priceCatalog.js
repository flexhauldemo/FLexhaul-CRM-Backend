// routes/priceCatalog.js
//
// Serves the price catalog that powers "pick from a list" in the estimate
// builder, grouped by category so the frontend can render it as a
// searchable, categorized picker instead of a flat list of 100+ items.

const express = require("express");
const { db } = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM price_catalog ORDER BY category, label").all();
  res.json({ items: rows });
});

// PATCH /api/price-catalog/:id — lets staff adjust a rate as costs change,
// without needing to touch code or redeploy.
router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM price_catalog WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Catalog item not found" });

  const fields = ["category", "label", "type", "unit", "rate"];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(req.params.id);
  db.prepare(`UPDATE price_catalog SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  res.json({ item: db.prepare("SELECT * FROM price_catalog WHERE id = ?").get(req.params.id) });
});

// POST /api/price-catalog — add a new catalog item (e.g. a service you didn't have before)
router.post("/", (req, res) => {
  const { category, label, type, unit, rate } = req.body || {};
  if (!category || !label || rate === undefined) {
    return res.status(400).json({ error: "category, label, and rate are required" });
  }
  const result = db
    .prepare("INSERT INTO price_catalog (category, label, type, unit, rate) VALUES (?, ?, ?, ?, ?)")
    .run(category, label, type || "other", unit || "item", rate);
  const id = Number(result.lastInsertRowid);
  res.status(201).json({ item: db.prepare("SELECT * FROM price_catalog WHERE id = ?").get(id) });
});

module.exports = router;

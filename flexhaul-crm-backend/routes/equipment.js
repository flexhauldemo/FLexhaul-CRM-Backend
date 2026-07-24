// routes/equipment.js
const express = require("express");
const { db } = require("../db");

const router = express.Router();
const VALID_STATUSES = ["available", "in_use", "maintenance"];

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM equipment ORDER BY name").all();
  res.json({ equipment: rows });
});

router.post("/", (req, res) => {
  const { name, type, status } = req.body || {};
  if (!name) return res.status(400).json({ error: "Equipment name is required" });
  const finalStatus = VALID_STATUSES.includes(status) ? status : "available";
  const result = db
    .prepare("INSERT INTO equipment (name, type, status) VALUES (?, ?, ?)")
    .run(name, type || "other", finalStatus);
  const id = Number(result.lastInsertRowid);
  res.status(201).json({ equipment: db.prepare("SELECT * FROM equipment WHERE id = ?").get(id) });
});

router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM equipment WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Equipment not found" });
  if (req.body.status !== undefined && !VALID_STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  const fields = ["name", "type", "status", "assigned_job_id"];
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
  db.prepare(`UPDATE equipment SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  res.json({ equipment: db.prepare("SELECT * FROM equipment WHERE id = ?").get(req.params.id) });
});

module.exports = router;

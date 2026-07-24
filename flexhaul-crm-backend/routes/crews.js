// routes/crews.js
const express = require("express");
const { db } = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM crews ORDER BY name").all();
  res.json({ crews: rows.map((r) => ({ ...r, members: JSON.parse(r.members || "[]") })) });
});

router.post("/", (req, res) => {
  const { name, members } = req.body || {};
  if (!name) return res.status(400).json({ error: "Crew name is required" });
  const result = db
    .prepare("INSERT INTO crews (name, members) VALUES (?, ?)")
    .run(name, JSON.stringify(Array.isArray(members) ? members : []));
  const id = Number(result.lastInsertRowid);
  res.status(201).json({ crew: { ...db.prepare("SELECT * FROM crews WHERE id = ?").get(id), members: members || [] } });
});

router.patch("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM crews WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Crew not found" });
  const name = req.body.name !== undefined ? req.body.name : existing.name;
  const members = req.body.members !== undefined ? req.body.members : JSON.parse(existing.members || "[]");
  db.prepare("UPDATE crews SET name = ?, members = ? WHERE id = ?").run(name, JSON.stringify(members), req.params.id);
  res.json({ crew: { ...db.prepare("SELECT * FROM crews WHERE id = ?").get(req.params.id), members } });
});

module.exports = router;

// routes/resetData.js
//
// A real, deliberate "wipe test data and start clean" action — admin
// only, and requires typing a confirmation phrase in the request body
// on top of whatever confirmation the frontend button shows, since this
// is genuinely irreversible.
//
// Clears: customers, deals, estimates, jobs, invoices, documents,
// activity_log — every table that holds actual business/customer data.
//
// Deliberately does NOT touch: users (your login), price_catalog (your
// pricing), crews, equipment — none of that is "customer data," it's
// business configuration, and wiping it would just make you rebuild
// things that have nothing to do with the actual problem.

const express = require("express");
const { db } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const TABLES_TO_CLEAR = ["documents", "invoices", "jobs", "estimates", "deals", "customers", "activity_log"];

router.post("/reset-data", requireAdmin, (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== "RESET") {
    return res.status(400).json({
      error: 'Send { "confirm": "RESET" } in the request body to actually run this \u2014 this is a safety check, not a bug.',
    });
  }

  const counts = {};
  TABLES_TO_CLEAR.forEach((table) => {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  });

  // Order matters — clear child tables (documents, invoices) before the
  // parents they reference (jobs, deals, customers), even though
  // ON DELETE CASCADE would technically handle it, so this stays
  // correct even if that ever changes. Wrapped in a real transaction —
  // node:sqlite doesn't have better-sqlite3's db.transaction() helper,
  // so this is done with explicit BEGIN/COMMIT/ROLLBACK instead.
  db.exec("BEGIN");
  try {
    TABLES_TO_CLEAR.forEach((table) => {
      db.exec(`DELETE FROM ${table};`);
    });
    const placeholders = TABLES_TO_CLEAR.map(() => "?").join(",");
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...TABLES_TO_CLEAR);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("Reset data failed, rolled back:", err.message);
    return res.status(500).json({ error: "Something went wrong \u2014 no data was changed." });
  }

  res.json({ ok: true, cleared: counts });
});

module.exports = router;

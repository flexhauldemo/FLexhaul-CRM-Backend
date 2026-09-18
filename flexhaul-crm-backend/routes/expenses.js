// routes/expenses.js
//
// A real expense ledger — deliberately manual entry only. No OCR, no
// approval chain, no per-role permissions: for a two-person crew,
// typing three fields and snapping a photo takes exactly as long as
// waiting for an AI model to read the receipt for you, and costs
// nothing extra. What this DOES do is finally feed the "Job Margin"
// stat on the Dashboard that's been sitting empty.

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { db, logActivity } = require("../db");

const router = express.Router();

// The category list lives here, in exactly one place. Adding a new
// category later (e.g. if you start tracking something new) is a
// one-line edit to this array — never a database migration, since the
// column itself is a plain, unconstrained TEXT field.
const CATEGORIES = [
  "Fuel",
  "Disposal Fees",
  "Equipment & Dumpster Rental",
  "Vehicle Maintenance",
  "Tools & Supplies",
  "Permits & Regulatory Fees",
  "Subcontractor / Labor",
  "Insurance",
  "Recurring / Subscriptions",
  "Other",
];

router.get("/categories", (req, res) => {
  res.json({ categories: CATEGORIES });
});

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

// GET /api/expenses/export.csv — same filters as the list endpoint.
// Registered before the /:id route below on purpose: Express matches
// routes in registration order, and "/export.csv" would otherwise be
// swallowed by "/:id" (treating "export.csv" as an id) and never run.
router.get("/export.csv", (req, res) => {
  const { from, to, category, job_id, vendor } = req.query;
  const conditions = [];
  const params = [];
  if (from) { conditions.push("expenses.expense_date >= ?"); params.push(from); }
  if (to) { conditions.push("expenses.expense_date <= ?"); params.push(to); }
  if (category) { conditions.push("expenses.category = ?"); params.push(category); }
  if (job_id) { conditions.push("expenses.job_id = ?"); params.push(job_id); }
  if (vendor) { conditions.push("expenses.vendor LIKE ?"); params.push(`%${vendor}%`); }
  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const rows = db
    .prepare(
      `SELECT expenses.*, jobs.address AS job_address, customers.name AS customer_name
       FROM expenses
       LEFT JOIN jobs ON jobs.id = expenses.job_id
       LEFT JOIN deals ON deals.id = jobs.deal_id
       LEFT JOIN customers ON customers.id = deals.customer_id
       ${where}
       ORDER BY expenses.expense_date DESC`
    )
    .all(...params);

  const csv = toCsv(rows, [
    { key: "expense_date", label: "Date" },
    { key: "category", label: "Category" },
    { key: "vendor", label: "Vendor" },
    { key: "amount", label: "Amount" },
    { key: "payment_method", label: "Payment Method" },
    { key: "customer_name", label: "Job Customer" },
    { key: "job_address", label: "Job Address" },
    { key: "notes", label: "Notes" },
  ]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="flexhaul-expenses-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB, matching the job-documents limit

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error("Unsupported file type. Allowed: JPG, PNG, WEBP, HEIC, PDF."));
    }
    cb(null, true);
  },
});

function rowWithJob(id) {
  return db
    .prepare(
      `SELECT expenses.*, jobs.address AS job_address, jobs.scheduled_date AS job_scheduled_date,
              customers.name AS customer_name
       FROM expenses
       LEFT JOIN jobs ON jobs.id = expenses.job_id
       LEFT JOIN deals ON deals.id = jobs.deal_id
       LEFT JOIN customers ON customers.id = deals.customer_id
       WHERE expenses.id = ?`
    )
    .get(id);
}

// GET /api/expenses — filterable list. from/to are dates (YYYY-MM-DD),
// category and job_id are exact matches, vendor is a partial match.
router.get("/", (req, res) => {
  const { from, to, category, job_id, vendor } = req.query;
  const conditions = [];
  const params = [];

  if (from) { conditions.push("expenses.expense_date >= ?"); params.push(from); }
  if (to) { conditions.push("expenses.expense_date <= ?"); params.push(to); }
  if (category) { conditions.push("expenses.category = ?"); params.push(category); }
  if (job_id) { conditions.push("expenses.job_id = ?"); params.push(job_id); }
  if (vendor) { conditions.push("expenses.vendor LIKE ?"); params.push(`%${vendor}%`); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const rows = db
    .prepare(
      `SELECT expenses.*, jobs.address AS job_address, customers.name AS customer_name
       FROM expenses
       LEFT JOIN jobs ON jobs.id = expenses.job_id
       LEFT JOIN deals ON deals.id = jobs.deal_id
       LEFT JOIN customers ON customers.id = deals.customer_id
       ${where}
       ORDER BY expenses.expense_date DESC, expenses.id DESC`
    )
    .all(...params);

  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  res.json({ expenses: rows, total });
});

router.get("/:id", (req, res) => {
  const row = rowWithJob(req.params.id);
  if (!row) return res.status(404).json({ error: "Expense not found" });
  res.json({ expense: row });
});

// POST /api/expenses — multipart form (receipt photo optional). Field
// names match the job-documents upload for consistency: "receipt" is
// the file field, everything else is a normal form field.
router.post("/", (req, res) => {
  upload.single("receipt")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { amount, expense_date, category, vendor, notes, job_id, payment_method } = req.body || {};
    if (!amount || isNaN(Number(amount))) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "A valid amount is required" });
    }

    if (job_id) {
      const job = db.prepare("SELECT id FROM jobs WHERE id = ?").get(job_id);
      if (!job) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "job_id does not match an existing job" });
      }
    }

    const receiptUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const receiptName = req.file ? req.file.originalname : null;

    const result = db
      .prepare(
        `INSERT INTO expenses (amount, expense_date, category, vendor, notes, job_id, payment_method, receipt_file_url, receipt_original_name, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Number(amount),
        expense_date || new Date().toISOString().slice(0, 10),
        CATEGORIES.includes(category) ? category : "Other",
        vendor || null,
        notes || null,
        job_id || null,
        payment_method || null,
        receiptUrl,
        receiptName,
        (req.user && req.user.name) || null
      );

    const id = Number(result.lastInsertRowid);
    if (job_id) {
      logActivity("job", job_id, `Expense logged: ${category || "Other"} \u2014 $${Number(amount).toFixed(2)}`, req.user && req.user.name);
    }
    res.status(201).json({ expense: rowWithJob(id) });
  });
});

// PATCH /api/expenses/:id — same fields as create; a new receipt file
// replaces the old one (the old file is removed). Omit the file field
// entirely to leave the existing receipt untouched.
router.patch("/:id", (req, res) => {
  upload.single("receipt")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const existing = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
    if (!existing) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: "Expense not found" });
    }

    if (req.body.job_id) {
      const job = db.prepare("SELECT id FROM jobs WHERE id = ?").get(req.body.job_id);
      if (!job) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "job_id does not match an existing job" });
      }
    }

    const amount = req.body.amount !== undefined ? Number(req.body.amount) : existing.amount;
    const expenseDate = req.body.expense_date || existing.expense_date;
    const category = req.body.category && CATEGORIES.includes(req.body.category) ? req.body.category : existing.category;
    const vendor = req.body.vendor !== undefined ? req.body.vendor : existing.vendor;
    const notes = req.body.notes !== undefined ? req.body.notes : existing.notes;
    const jobId = req.body.job_id !== undefined ? (req.body.job_id || null) : existing.job_id;
    const paymentMethod = req.body.payment_method !== undefined ? req.body.payment_method : existing.payment_method;

    let receiptUrl = existing.receipt_file_url;
    let receiptName = existing.receipt_original_name;
    if (req.file) {
      if (existing.receipt_file_url) {
        fs.unlink(path.join(UPLOAD_DIR, path.basename(existing.receipt_file_url)), () => {});
      }
      receiptUrl = `/uploads/${req.file.filename}`;
      receiptName = req.file.originalname;
    }

    db.prepare(
      `UPDATE expenses SET amount=?, expense_date=?, category=?, vendor=?, notes=?, job_id=?, payment_method=?,
       receipt_file_url=?, receipt_original_name=?, updated_at=datetime('now') WHERE id=?`
    ).run(amount, expenseDate, category, vendor, notes, jobId, paymentMethod, receiptUrl, receiptName, req.params.id);

    res.json({ expense: rowWithJob(req.params.id) });
  });
});

router.delete("/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Expense not found" });

  if (existing.receipt_file_url) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(existing.receipt_file_url)), () => {});
  }
  db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
  if (existing.job_id) {
    logActivity("job", existing.job_id, `Expense deleted: ${existing.category} \u2014 $${Number(existing.amount).toFixed(2)}`, req.user && req.user.name);
  }
  res.json({ ok: true });
});

module.exports = router;

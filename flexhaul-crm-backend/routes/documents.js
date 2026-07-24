// routes/documents.js
//
// Handles photo/document upload for a job. Files are stored on local
// disk under api/uploads/ for now (matching the brief's "SQLite to
// start" philosophy — simplest thing that works). When you outgrow
// this (e.g. deploying on a host with an ephemeral filesystem, or
// wanting CDN-backed delivery), swap the multer disk storage below for
// an S3-compatible bucket — nothing else in this file needs to change,
// since routes only ever deal with the returned file_url string.

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { db, logActivity } = require("../db");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = ["permit", "environmental_survey", "coi", "photo", "other"];
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    const safeName = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, safeName);
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

// POST /api/documents — multipart form: fields job_id, type, plus file field "file"
router.post("/", (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { job_id, type } = req.body || {};
    if (!job_id) return res.status(400).json({ error: "job_id is required" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')" });

    const job = db.prepare("SELECT id FROM jobs WHERE id = ?").get(job_id);
    if (!job) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "job_id does not match an existing job" });
    }

    const finalType = ALLOWED_TYPES.includes(type) ? type : "photo";
    const fileUrl = `/uploads/${req.file.filename}`;

    const result = db
      .prepare("INSERT INTO documents (job_id, type, file_url, original_name) VALUES (?, ?, ?, ?)")
      .run(job_id, finalType, fileUrl, req.file.originalname);

    const id = Number(result.lastInsertRowid);
    logActivity("job", job_id, `Document uploaded (${finalType}): ${req.file.originalname}`, req.user && req.user.name);
    res.status(201).json({ document: db.prepare("SELECT * FROM documents WHERE id = ?").get(id) });
  });
});

// GET /api/documents/job/:jobId
router.get("/job/:jobId", (req, res) => {
  const rows = db.prepare("SELECT * FROM documents WHERE job_id = ? ORDER BY uploaded_at DESC").all(req.params.jobId);
  res.json({ documents: rows });
});

// DELETE /api/documents/:id
router.delete("/:id", (req, res) => {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });

  const filePath = path.join(UPLOAD_DIR, path.basename(doc.file_url));
  fs.unlink(filePath, () => {}); // best-effort; don't fail the request if already gone

  db.prepare("DELETE FROM documents WHERE id = ?").run(req.params.id);
  logActivity("job", doc.job_id, `Document deleted: ${doc.original_name || doc.file_url}`, req.user && req.user.name);
  res.json({ ok: true });
});

module.exports = router;

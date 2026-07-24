// db.js
//
// SQLite schema + connection, using Node's built-in node:sqlite module
// (available Node 22.5+) — no native compilation, no extra dependency
// for the database layer itself.
//
// To migrate to Postgres later: everything that touches the database
// lives in routes/*.js via the query helpers below, so swapping this
// file for a Postgres client (e.g. `pg`) with matching function
// signatures is the only change needed — no route code should need to
// change.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "crm.db");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', -- 'admin' | 'staff'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'homeowner', -- 'homeowner' | 'gc' | 'property_manager' | 'other'
  phone TEXT,
  email TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'new_lead', -- new_lead | quoted | won | scheduled | complete | invoiced | lost
  source TEXT, -- 'website' | 'phone' | 'referral' | 'furniture_store' | 'other'
  estimated_value REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  line_items TEXT NOT NULL DEFAULT '[]', -- JSON array: [{type,label,qty,unit,rate,amount}]
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '[]' -- JSON array of member name strings
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT, -- 'truck' | 'trailer' | 'excavator' | 'dumpster' | 'other'
  status TEXT NOT NULL DEFAULT 'available', -- 'available' | 'in_use' | 'maintenance'
  assigned_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_progress | complete | canceled
  scheduled_date TEXT,
  scheduled_time_slot TEXT, -- one of the keys in constants/timeSlots.js, e.g. "09:00-11:00" — nullable, a job can have a date with no specific window yet
  address TEXT,
  crew_id INTEGER REFERENCES crews(id) ON DELETE SET NULL,
  equipment_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of equipment ids
  notes TEXT,
  google_event_id TEXT, -- links this job to an event on the shared Google Calendar, if calendar sync is configured
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'photo', -- 'permit' | 'environmental_survey' | 'coi' | 'photo' | 'other'
  file_url TEXT NOT NULL,
  original_name TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid', -- 'unpaid' | 'paid' | 'overdue'
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, -- 'deal' | 'job' | 'customer' | 'invoice' | 'estimate'
  entity_id INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deals_customer ON deals(customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_jobs_deal ON jobs(deal_id);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_date ON jobs(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_estimates_deal ON estimates(deal_id);
CREATE INDEX IF NOT EXISTS idx_documents_job ON documents(job_id);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
`);

// Safe migration for databases created before google_event_id existed.
// CREATE TABLE IF NOT EXISTS above doesn't add columns to an existing
// table, so this covers anyone who already had jobs before this update.
const jobsColumns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
if (!jobsColumns.includes("google_event_id")) {
  db.exec("ALTER TABLE jobs ADD COLUMN google_event_id TEXT;");
}
if (!jobsColumns.includes("scheduled_time_slot")) {
  db.exec("ALTER TABLE jobs ADD COLUMN scheduled_time_slot TEXT;");
}

function logActivity(entityType, entityId, note, createdBy) {
  db.prepare(
    "INSERT INTO activity_log (entity_type, entity_id, note, created_by) VALUES (?, ?, ?, ?)"
  ).run(entityType, entityId, note, createdBy || "system");
}

module.exports = { db, logActivity };

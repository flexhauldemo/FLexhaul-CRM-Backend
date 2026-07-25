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
  service_type TEXT, -- 'junk_removal' | 'furniture_pickup' | 'light_demolition' | 'other' — powers revenue-by-service reporting
  estimated_value REAL DEFAULT 0,
  notes TEXT, -- what the customer actually asked for — filled in automatically for website inquiries
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  line_items TEXT NOT NULL DEFAULT '[]', -- JSON array: [{type,label,qty,unit,rate,amount}]
  total REAL NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0, -- set to 1 by POST /api/estimates/:id/accept, which also auto-creates a job + invoice
  share_token TEXT, -- random token letting a customer view/approve this exact estimate with no login — see routes/publicShare.js
  customer_approved_at TEXT, -- set when the customer approves via the public link, as opposed to staff clicking Accept
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
  actual_cost REAL, -- what the job really cost (crew hours, disposal fees, fuel, etc.) — set once complete, compared against the estimate for real margin
  recurring_interval TEXT, -- 'weekly' | 'biweekly' | 'monthly' | NULL — set to auto-generate the next job when this one is marked complete
  recurrence_parent_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL, -- points back to the job that spawned this one, so a recurring chain is traceable
  review_requested INTEGER NOT NULL DEFAULT 0, -- set once a review request has gone out for this job, so it's never asked for twice
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'photo', -- 'permit' | 'environmental_survey' | 'coi' | 'photo' | 'other'
  file_url TEXT NOT NULL,
  original_name TEXT,
  expires_at TEXT, -- for permit/COI compliance tracking — the dashboard flags anything expiring soon
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  line_items TEXT NOT NULL DEFAULT '[]', -- snapshot of the source estimate's line items at invoice time — a copy, not a live reference, so editing/deleting the estimate later never changes what was actually billed
  status TEXT NOT NULL DEFAULT 'unpaid', -- 'unpaid' | 'paid' | 'overdue'
  due_date TEXT,
  share_token TEXT, -- lets a customer view/pay this exact invoice with no login
  stripe_payment_link TEXT, -- cached Stripe Checkout URL, only ever set if STRIPE_SECRET_KEY is configured
  stripe_session_id TEXT,
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

CREATE TABLE IF NOT EXISTS price_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL, -- 'Living & Dining Room' | 'Bedroom & Mattresses' | 'Appliances' | etc.
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other', -- matches estimate line_item types: labor | equipment | disposal | tonnage | cubic_yards | other
  unit TEXT, -- 'item' | 'linear_ft' | 'load' | 'hr' etc, shown next to the rate
  rate REAL NOT NULL
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

const dealsColumns = db.prepare("PRAGMA table_info(deals)").all().map((c) => c.name);
if (!dealsColumns.includes("notes")) {
  db.exec("ALTER TABLE deals ADD COLUMN notes TEXT;");
}

const estimatesColumns = db.prepare("PRAGMA table_info(estimates)").all().map((c) => c.name);
if (!estimatesColumns.includes("accepted")) {
  db.exec("ALTER TABLE estimates ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0;");
}

const invoicesColumns = db.prepare("PRAGMA table_info(invoices)").all().map((c) => c.name);
if (!invoicesColumns.includes("line_items")) {
  db.exec("ALTER TABLE invoices ADD COLUMN line_items TEXT NOT NULL DEFAULT '[]';");
}
if (!invoicesColumns.includes("stripe_payment_link")) {
  db.exec("ALTER TABLE invoices ADD COLUMN stripe_payment_link TEXT;");
}
if (!invoicesColumns.includes("stripe_session_id")) {
  db.exec("ALTER TABLE invoices ADD COLUMN stripe_session_id TEXT;");
}
if (!invoicesColumns.includes("share_token")) {
  db.exec("ALTER TABLE invoices ADD COLUMN share_token TEXT;");
}

const dealsColumns2 = db.prepare("PRAGMA table_info(deals)").all().map((c) => c.name);
if (!dealsColumns2.includes("service_type")) {
  db.exec("ALTER TABLE deals ADD COLUMN service_type TEXT;");
}

const estimatesColumns2 = db.prepare("PRAGMA table_info(estimates)").all().map((c) => c.name);
if (!estimatesColumns2.includes("share_token")) {
  db.exec("ALTER TABLE estimates ADD COLUMN share_token TEXT;");
}
if (!estimatesColumns2.includes("customer_approved_at")) {
  db.exec("ALTER TABLE estimates ADD COLUMN customer_approved_at TEXT;");
}

const jobsColumns2 = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
if (!jobsColumns2.includes("actual_cost")) {
  db.exec("ALTER TABLE jobs ADD COLUMN actual_cost REAL;");
}
if (!jobsColumns2.includes("recurring_interval")) {
  db.exec("ALTER TABLE jobs ADD COLUMN recurring_interval TEXT;");
}
if (!jobsColumns2.includes("recurrence_parent_id")) {
  db.exec("ALTER TABLE jobs ADD COLUMN recurrence_parent_id INTEGER;");
}
if (!jobsColumns2.includes("review_requested")) {
  db.exec("ALTER TABLE jobs ADD COLUMN review_requested INTEGER NOT NULL DEFAULT 0;");
}

const documentsColumns = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
if (!documentsColumns.includes("expires_at")) {
  db.exec("ALTER TABLE documents ADD COLUMN expires_at TEXT;");
}

// Backfill share_token for any estimates created before this feature
// existed, so the public link works for old data too, not just new.
db.exec(`
  UPDATE estimates SET share_token = lower(hex(randomblob(16)))
  WHERE share_token IS NULL;
`);
db.exec(`
  UPDATE invoices SET share_token = lower(hex(randomblob(16)))
  WHERE share_token IS NULL;
`);

// Auto-seed the price catalog on first boot — this is what lets the
// estimate builder offer "pick from a list" instead of typing every line
// item by hand. Only runs once (checks if the table is already populated),
// so it's safe on every restart. To adjust pricing later, edit rows
// directly via the Price Catalog admin screen rather than here.
const catalogCount = db.prepare("SELECT COUNT(*) AS n FROM price_catalog").get().n;
if (catalogCount === 0) {
  const insertCatalogItem = db.prepare(
    "INSERT INTO price_catalog (category, label, type, unit, rate) VALUES (?, ?, ?, ?, ?)"
  );
  const catalog = [
    // Living & Dining Room
    ["Living & Dining Room", "Recliner", "other", "item", 75],
    ["Living & Dining Room", "Oversized Recliner", "other", "item", 90],
    ["Living & Dining Room", "Loveseat", "other", "item", 95],
    ["Living & Dining Room", "Standard Couch", "other", "item", 125],
    ["Living & Dining Room", "Sectional (2-piece)", "other", "item", 225],
    ["Living & Dining Room", "Large Sectional", "other", "item", 300],
    ["Living & Dining Room", "Sleeper Sofa", "other", "item", 175],
    ["Living & Dining Room", "Coffee Table", "other", "item", 35],
    ["Living & Dining Room", "End Table", "other", "item", 20],
    ["Living & Dining Room", "Entertainment Center", "other", "item", 150],
    ["Living & Dining Room", "TV Stand", "other", "item", 60],
    ["Living & Dining Room", "Dining Chair", "other", "item", 15],
    ["Living & Dining Room", "Dining Table", "other", "item", 60],
    ["Living & Dining Room", "Dining Set", "other", "item", 150],
    ["Living & Dining Room", "China Cabinet", "other", "item", 175],
    ["Living & Dining Room", "Buffet", "other", "item", 90],

    // Bedroom & Mattresses
    ["Bedroom & Mattresses", "Night Stand", "other", "item", 30],
    ["Bedroom & Mattresses", "Small Dresser", "other", "item", 60],
    ["Bedroom & Mattresses", "Large Dresser", "other", "item", 95],
    ["Bedroom & Mattresses", "Chest of Drawers", "other", "item", 75],
    ["Bedroom & Mattresses", "Armoire", "other", "item", 125],
    ["Bedroom & Mattresses", "Bed Frame", "other", "item", 50],
    ["Bedroom & Mattresses", "Headboard", "other", "item", 35],
    ["Bedroom & Mattresses", "Footboard", "other", "item", 25],
    ["Bedroom & Mattresses", "Vanity", "other", "item", 90],
    ["Bedroom & Mattresses", "Adjustable Bed Base", "other", "item", 175],
    ["Bedroom & Mattresses", "Twin Mattress", "other", "item", 70],
    ["Bedroom & Mattresses", "Twin Box Spring", "other", "item", 40],
    ["Bedroom & Mattresses", "Full Mattress", "other", "item", 80],
    ["Bedroom & Mattresses", "Full Box Spring", "other", "item", 45],
    ["Bedroom & Mattresses", "Queen Mattress", "other", "item", 90],
    ["Bedroom & Mattresses", "Queen Box Spring", "other", "item", 50],
    ["Bedroom & Mattresses", "King Mattress", "other", "item", 110],
    ["Bedroom & Mattresses", "King Box Spring", "other", "item", 60],

    // Appliances
    ["Appliances", "Microwave", "other", "item", 30],
    ["Appliances", "Mini Fridge", "other", "item", 55],
    ["Appliances", "Refrigerator", "other", "item", 110],
    ["Appliances", "Deep Freezer", "other", "item", 110],
    ["Appliances", "Washer", "other", "item", 90],
    ["Appliances", "Dryer", "other", "item", 90],
    ["Appliances", "Dishwasher", "other", "item", 75],
    ["Appliances", "Stove", "other", "item", 100],
    ["Appliances", "Water Heater", "other", "item", 85],

    // Office Furniture
    ["Office Furniture", "Office Chair", "other", "item", 25],
    ["Office Furniture", "Desk", "other", "item", 75],
    ["Office Furniture", "Large Executive Desk", "other", "item", 150],
    ["Office Furniture", "Filing Cabinet", "other", "item", 45],
    ["Office Furniture", "Cubicle Section", "other", "item", 125],

    // Electronics
    ["Electronics", "Flat Screen TV (under 40\")", "other", "item", 40],
    ["Electronics", "TV (40-65\")", "other", "item", 60],
    ["Electronics", "TV (65\"+)", "other", "item", 80],
    ["Electronics", "CRT TV", "other", "item", 125],
    ["Electronics", "Computer", "other", "item", 30],
    ["Electronics", "Printer", "other", "item", 35],

    // Exercise Equipment
    ["Exercise Equipment", "Treadmill", "other", "item", 125],
    ["Exercise Equipment", "Elliptical", "other", "item", 100],
    ["Exercise Equipment", "Weight Bench", "other", "item", 60],
    ["Exercise Equipment", "Home Gym", "other", "item", 300],
    ["Exercise Equipment", "Exercise Bike", "other", "item", 75],

    // Outdoor & Garage
    ["Outdoor & Garage", "Grill", "other", "item", 60],
    ["Outdoor & Garage", "Push Mower", "other", "item", 55],
    ["Outdoor & Garage", "Riding Mower", "other", "item", 125],
    ["Outdoor & Garage", "Wheelbarrow", "other", "item", 25],
    ["Outdoor & Garage", "Patio Chair", "other", "item", 20],
    ["Outdoor & Garage", "Patio Table", "other", "item", 45],
    ["Outdoor & Garage", "Patio Set", "other", "item", 125],
    ["Outdoor & Garage", "Fire Pit", "other", "item", 50],
    ["Outdoor & Garage", "Tire", "other", "item", 15],
    ["Outdoor & Garage", "Tire w/ Rim", "other", "item", 20],
    ["Outdoor & Garage", "Lawn Tools", "other", "item", 10],
    ["Outdoor & Garage", "Shelving Unit", "other", "item", 60],
    ["Outdoor & Garage", "Tool Chest", "other", "item", 125],
    ["Outdoor & Garage", "Work Bench", "other", "item", 95],

    // Hot Tubs & Playsets
    ["Hot Tubs & Playsets", "Hot Tub (already disconnected)", "other", "item", 550],
    ["Hot Tubs & Playsets", "Small Wood Playset", "other", "item", 350],
    ["Hot Tubs & Playsets", "Medium Playset", "other", "item", 500],
    ["Hot Tubs & Playsets", "Large Playset", "other", "item", 800],

    // Demolition
    ["Demolition", "Shed Demo — Plastic Storage", "other", "job", 375],
    ["Demolition", "Shed Demo — 8x8", "other", "job", 600],
    ["Demolition", "Shed Demo — 10x10", "other", "job", 800],
    ["Demolition", "Shed Demo — 10x12", "other", "job", 975],
    ["Demolition", "Shed Demo — 12x16", "other", "job", 1450],
    ["Demolition", "Shed Demo — Concrete Floor Add-On", "other", "job", 650],
    ["Demolition", "Deck Demo — Small (under 150 sq ft)", "other", "job", 700],
    ["Demolition", "Deck Demo — Medium (150-300 sq ft)", "other", "job", 1250],
    ["Demolition", "Deck Demo — Large (300-500 sq ft)", "other", "job", 2200],
    ["Demolition", "Deck Demo — Elevated Add-On", "other", "job", 550],
    ["Demolition", "Fence Removal — Wood", "other", "linear_ft", 10],
    ["Demolition", "Fence Removal — Chain Link", "other", "linear_ft", 8.5],
    ["Demolition", "Fence Removal — Vinyl", "other", "linear_ft", 11.5],

    // Hauling & Debris
    ["Hauling & Debris", "Construction Debris — Pickup Load", "disposal", "load", 150],
    ["Hauling & Debris", "Construction Debris — 1/4 Trailer", "disposal", "load", 200],
    ["Hauling & Debris", "Construction Debris — 1/2 Trailer", "disposal", "load", 350],
    ["Hauling & Debris", "Construction Debris — 3/4 Trailer", "disposal", "load", 500],
    ["Hauling & Debris", "Construction Debris — Full Trailer", "disposal", "load", 650],
    ["Hauling & Debris", "Yard Waste — Brush Pile", "disposal", "load", 110],
    ["Hauling & Debris", "Yard Waste — Leaves", "disposal", "load", 75],
    ["Hauling & Debris", "Yard Waste — Tree Branches", "disposal", "load", 200],
    ["Hauling & Debris", "Railroad Tie", "disposal", "item", 30],

    // Labor
    ["Labor", "Crew Labor (per hour)", "labor", "hr", 65],
    ["Labor", "Minimum Service Call", "labor", "job", 95],
  ];
  catalog.forEach((row) => insertCatalogItem.run(...row));
}

function logActivity(entityType, entityId, note, createdBy) {
  db.prepare(
    "INSERT INTO activity_log (entity_type, entity_id, note, created_by) VALUES (?, ?, ?, ?)"
  ).run(entityType, entityId, note, createdBy || "system");
}

module.exports = { db, logActivity };

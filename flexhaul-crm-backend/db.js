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
  square_payment_link TEXT, -- cached Square Checkout URL, only ever set if SQUARE_ACCESS_TOKEN is configured
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
if (!invoicesColumns.includes("square_payment_link")) {
  db.exec("ALTER TABLE invoices ADD COLUMN square_payment_link TEXT;");
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

// The full price catalog data, as a function so both the first-boot
// auto-seed below AND the admin-triggered "Reload Full Catalog" action
// (routes/priceCatalog.js) use the exact same list — one source of
// truth, never two copies quietly drifting apart. Wipes and replaces
// every row when called, since the intent when you run this is always
// "load the current official pricing," not "merge with whatever's
// already there."
function reseedPriceCatalog() {
  db.exec("DELETE FROM price_catalog;");
  const insertCatalogItem = db.prepare(
    "INSERT INTO price_catalog (category, label, type, unit, rate) VALUES (?, ?, ?, ?, ?)"
  );
  const catalog = [
    // Junk Removal
    ["Junk Removal", "Dining Chair", "other", "item", 20],
    ["Junk Removal", "Office Chair", "other", "item", 25],
    ["Junk Removal", "Recliner", "other", "item", 75],
    ["Junk Removal", "Loveseat", "other", "item", 95],
    ["Junk Removal", "Standard Couch", "other", "item", 125],
    ["Junk Removal", "Sectional (per section)", "other", "item", 75],
    ["Junk Removal", "Sleeper Sofa", "other", "item", 175],
    ["Junk Removal", "Ottoman", "other", "item", 20],
    ["Junk Removal", "Coffee Table", "other", "item", 30],
    ["Junk Removal", "End Table", "other", "item", 20],
    ["Junk Removal", "TV Stand", "other", "item", 50],
    ["Junk Removal", "Entertainment Center", "other", "item", 150],
    ["Junk Removal", "Bookshelf (Small)", "other", "item", 40],
    ["Junk Removal", "Bookshelf (Large)", "other", "item", 85],
    ["Junk Removal", "Desk (Small)", "other", "item", 60],
    ["Junk Removal", "Executive Desk", "other", "item", 150],
    ["Junk Removal", "Filing Cabinet (Empty)", "other", "item", 50],
    ["Junk Removal", "Filing Cabinet (Full)", "other", "item", 95],

    // Mattresses
    ["Mattresses", "Twin Mattress", "other", "item", 60],
    ["Mattresses", "Twin Box Spring", "other", "item", 35],
    ["Mattresses", "Full Mattress", "other", "item", 70],
    ["Mattresses", "Full Box Spring", "other", "item", 40],
    ["Mattresses", "Queen Mattress", "other", "item", 80],
    ["Mattresses", "Queen Box Spring", "other", "item", 45],
    ["Mattresses", "King Mattress", "other", "item", 95],
    ["Mattresses", "King Box Spring", "other", "item", 50],
    ["Mattresses", "Adjustable Bed Base", "other", "item", 125],

    // Bedroom Furniture
    ["Bedroom Furniture", "Night Stand", "other", "item", 25],
    ["Bedroom Furniture", "Small Dresser", "other", "item", 75],
    ["Bedroom Furniture", "Large Dresser", "other", "item", 125],
    ["Bedroom Furniture", "Armoire", "other", "item", 175],
    ["Bedroom Furniture", "Headboard", "other", "item", 35],
    ["Bedroom Furniture", "Bed Frame", "other", "item", 40],
    ["Bedroom Furniture", "Complete Bedroom Set", "other", "item", 325],

    // Appliances
    ["Appliances", "Refrigerator", "other", "item", 125],
    ["Appliances", "Freezer", "other", "item", 100],
    ["Appliances", "Stove", "other", "item", 95],
    ["Appliances", "Dishwasher", "other", "item", 75],
    ["Appliances", "Washer", "other", "item", 95],
    ["Appliances", "Dryer", "other", "item", 95],
    ["Appliances", "Water Heater", "other", "item", 90],
    ["Appliances", "Microwave", "other", "item", 25],

    // Exercise Equipment
    ["Exercise Equipment", "Exercise Bike", "other", "item", 75],
    ["Exercise Equipment", "Treadmill", "other", "item", 150],
    ["Exercise Equipment", "Elliptical", "other", "item", 150],
    ["Exercise Equipment", "Weight Bench", "other", "item", 85],
    ["Exercise Equipment", "Home Gym", "other", "item", 275],

    // Electronics
    ["Electronics", "TV (under 40\")", "other", "item", 20],
    ["Electronics", "TV (over 40\")", "other", "item", 40],
    ["Electronics", "Computer", "other", "item", 20],
    ["Electronics", "Printer", "other", "item", 20],

    // Outdoor
    ["Outdoor", "Grill", "other", "item", 75],
    ["Outdoor", "Push Mower", "other", "item", 60],
    ["Outdoor", "Riding Mower", "other", "item", 175],
    ["Outdoor", "Snowblower", "other", "item", 95],
    ["Outdoor", "Wheelbarrow", "other", "item", 35],
    ["Outdoor", "Patio Chair", "other", "item", 20],
    ["Outdoor", "Patio Table", "other", "item", 50],

    // Tires
    ["Tires", "Passenger Tire", "other", "item", 20],
    ["Tires", "Tire with Rim", "other", "item", 30],
    ["Tires", "Tractor Tire (Manual Quote)", "other", "item", 0],

    // Construction Debris
    ["Construction Debris", "Drywall Bag", "disposal", "item", 20],
    ["Construction Debris", "Lumber (Pickup Load)", "disposal", "load", 150],
    ["Construction Debris", "Mixed Construction Debris (Pickup Load)", "disposal", "load", 225],
    ["Construction Debris", "Concrete (Manual Quote, per Cubic Yard)", "disposal", "cubic_yard", 0],
    ["Construction Debris", "Brick (Pickup Load)", "disposal", "load", 250],
    ["Construction Debris", "Dirt (Pickup Load)", "disposal", "load", 200],

    // Hauling Volume (trailer load, by fraction)
    ["Hauling Volume", "1/8 Trailer Load", "disposal", "load", 125],
    ["Hauling Volume", "1/4 Trailer Load", "disposal", "load", 225],
    ["Hauling Volume", "3/8 Trailer Load", "disposal", "load", 300],
    ["Hauling Volume", "1/2 Trailer Load", "disposal", "load", 400],
    ["Hauling Volume", "5/8 Trailer Load", "disposal", "load", 475],
    ["Hauling Volume", "3/4 Trailer Load", "disposal", "load", 550],
    ["Hauling Volume", "7/8 Trailer Load", "disposal", "load", 625],
    ["Hauling Volume", "Full Trailer Load", "disposal", "load", 700],

    // Demolition
    ["Demolition", "Deck Removal 8x8", "other", "item", 500],
    ["Demolition", "Deck Removal 10x10", "other", "item", 700],
    ["Demolition", "Deck Removal 12x12", "other", "item", 900],
    ["Demolition", "Deck Removal 16x16", "other", "item", 1400],
    ["Demolition", "Shed Removal \u2014 Plastic 8x8", "other", "item", 500],
    ["Demolition", "Shed Removal \u2014 Wood 8x8", "other", "item", 700],
    ["Demolition", "Shed Removal \u2014 Wood 10x12", "other", "item", 900],
    ["Demolition", "Shed Removal \u2014 Wood 12x16", "other", "item", 1300],
    ["Demolition", "Fence Removal \u2014 Chain Link (per linear ft)", "other", "linear_ft", 12],
    ["Demolition", "Fence Removal \u2014 Wood (per linear ft)", "other", "linear_ft", 15],
    ["Demolition", "Fence Removal \u2014 Vinyl (per linear ft)", "other", "linear_ft", 18],
    ["Demolition", "Hot Tub Removal ($450\u2013$700, avg shown)", "other", "item", 575],
    ["Demolition", "Swing Set Removal ($300\u2013$500, avg shown)", "other", "item", 400],
    ["Demolition", "Above Ground Pool Removal ($500\u2013$700, avg shown)", "other", "item", 600],
    ["Demolition", "Bathroom Demo ($800\u2013$1,500, avg shown)", "other", "item", 1150],
    ["Demolition", "Kitchen Demo ($1,500\u2013$3,500, avg shown)", "other", "item", 2500],
    ["Demolition", "Flooring Removal (per sq ft, $2.50\u2013$5 avg shown)", "other", "sqft", 3.75],
    ["Demolition", "Drywall Removal (per sq ft, $2\u2013$3.50 avg shown)", "other", "sqft", 2.75],
    ["Demolition", "Ceiling Removal (per sq ft, $3\u2013$5 avg shown)", "other", "sqft", 4],
    ["Demolition", "Cabinet Removal (each)", "other", "item", 100],
    ["Demolition", "Countertop Removal (per linear ft, $15\u2013$30 avg shown)", "other", "linear_ft", 22.5],

    // Travel & Adjustments — add these on top of the base job as needed.
    // Same-Day (+15%) and After-Hours (+25%) are percentage surcharges,
    // not flat fees, so they aren't in this list — apply them by hand
    // as a percentage of the subtotal when relevant.
    ["Travel & Adjustments", "Travel 21\u201330 Miles", "labor", "trip", 25],
    ["Travel & Adjustments", "Travel 31\u201340 Miles", "labor", "trip", 50],
    ["Travel & Adjustments", "Travel 41\u201350 Miles", "labor", "trip", 75],
    ["Travel & Adjustments", "Travel 51\u201360 Miles", "labor", "trip", 100],
    ["Travel & Adjustments", "Travel Over 60 Miles (per mile)", "labor", "mile", 2],
    ["Travel & Adjustments", "Upstairs (per flight)", "labor", "flight", 40],
    ["Travel & Adjustments", "Basement Access", "labor", "job", 50],
    ["Travel & Adjustments", "Long Carry", "labor", "job", 40],
    ["Travel & Adjustments", "Heavy Item (under 500 lbs)", "labor", "item", 75],
    ["Travel & Adjustments", "500+ lbs (Manual Review)", "labor", "item", 0],
    ["Travel & Adjustments", "Disassembly ($50\u2013$150, avg shown)", "labor", "item", 100],
    ["Travel & Adjustments", "Hazardous Materials (Manual Review)", "labor", "item", 0],
  ];
  catalog.forEach((row) => insertCatalogItem.run(...row));
  return catalog.length;
}

// Auto-seed on first boot only (empty table) — this is what lets the
// estimate builder offer "pick from a list" instead of typing every line
// item by hand, without needing you to do anything on a brand-new
// database. To reload pricing later (e.g. after this file's catalog
// data changes), use the "Reload Full Catalog" action in the CRM
// instead of relying on this — that one's safe to run anytime, this
// boot check deliberately isn't (it would never touch a populated table).
const catalogCount = db.prepare("SELECT COUNT(*) AS n FROM price_catalog").get().n;
if (catalogCount === 0) {
  reseedPriceCatalog();
}

function logActivity(entityType, entityId, note, createdBy) {
  db.prepare(
    "INSERT INTO activity_log (entity_type, entity_id, note, created_by) VALUES (?, ?, ?, ?)"
  ).run(entityType, entityId, note, createdBy || "system");
}

module.exports = { db, logActivity, reseedPriceCatalog };

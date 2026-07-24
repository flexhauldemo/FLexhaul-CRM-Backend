// seed.js
//
// Creates the first admin login and a small set of sample records so
// the CRM isn't empty on first run. Safe to re-run — it skips creating
// the admin user if one with that email already exists, and only adds
// sample data if the database has no customers yet.
//
// Usage:
//   node seed.js "Your Name" you@example.com "a-strong-password"

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { db, logActivity } = require("./db");

const [, , name, email, password] = process.argv;

if (!name || !email || !password) {
  console.log('Usage: node seed.js "Your Name" you@example.com "a-strong-password"');
  process.exit(1);
}
if (password.length < 8) {
  console.log("Password must be at least 8 characters.");
  process.exit(1);
}

const normalizedEmail = email.toLowerCase().trim();
const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);

if (existingUser) {
  console.log(`A user with email ${normalizedEmail} already exists — skipping admin creation.`);
} else {
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(
    name,
    normalizedEmail,
    hash
  );
  console.log(`Admin user created: ${normalizedEmail}`);
}

const customerCount = db.prepare("SELECT COUNT(*) AS n FROM customers").get().n;

if (customerCount === 0) {
  console.log("Adding sample data...");

  const c1 = db
    .prepare("INSERT INTO customers (name, type, phone, email, address) VALUES (?, ?, ?, ?, ?)")
    .run("Sarah Mitchell", "homeowner", "(765) 555-0142", "sarah.m@example.com", "412 Elm St, Lafayette, IN");
  const c2 = db
    .prepare("INSERT INTO customers (name, type, phone, email, address) VALUES (?, ?, ?, ?, ?)")
    .run("Property Solutions LLC", "property_manager", "(765) 555-0110", "ops@propsolutions.example", "900 Main St, Lafayette, IN");

  const d1 = db
    .prepare("INSERT INTO deals (customer_id, stage, source, estimated_value) VALUES (?, ?, ?, ?)")
    .run(Number(c1.lastInsertRowid), "quoted", "website", 225);
  const d2 = db
    .prepare("INSERT INTO deals (customer_id, stage, source, estimated_value) VALUES (?, ?, ?, ?)")
    .run(Number(c2.lastInsertRowid), "won", "referral", 1400);

  db.prepare("INSERT INTO estimates (deal_id, line_items, total) VALUES (?, ?, ?)").run(
    Number(d1.lastInsertRowid),
    JSON.stringify([
      { type: "labor", label: "2-person crew, 2 hrs", qty: 2, unit: "hr", rate: 65, amount: 130 },
      { type: "disposal", label: "1/4 trailer disposal fee", qty: 1, unit: "load", rate: 95, amount: 95 },
    ]),
    225
  );

  const crew = db.prepare("INSERT INTO crews (name, members) VALUES (?, ?)").run(
    "Crew A",
    JSON.stringify(["Mike", "Dan"])
  );

  db.prepare(
    "INSERT INTO jobs (deal_id, status, scheduled_date, address, crew_id, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    Number(d2.lastInsertRowid),
    "scheduled",
    new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    "900 Main St, Lafayette, IN",
    Number(crew.lastInsertRowid),
    "Full estate cleanout, 3 bedroom home."
  );

  logActivity("customer", Number(c1.lastInsertRowid), "Sample customer created by seed script");
  logActivity("customer", Number(c2.lastInsertRowid), "Sample customer created by seed script");

  console.log("Sample data added.");
} else {
  console.log("Customers already exist — skipping sample data.");
}

console.log("Done.");

// routes/publicInquiries.js
//
// The one deliberately UNAUTHENTICATED route in the whole API. Everything
// else requires a login — this doesn't, because it's called directly from
// your public website's quote form, before anyone has logged into anything.
//
// What it does: takes a quote request from contact.html or
// furniture-pickup.html and turns it into a real Customer + Deal in the
// CRM, landing in the Pipeline's "New Lead" column — so a real inquiry
// is actually visible to staff instead of only going out as an email.
//
// If a customer with the same phone number already submitted before,
// this reuses that customer record and just adds a new deal, rather than
// creating a duplicate person every time someone re-submits.

const express = require("express");
const { db, logActivity } = require("../db");

const router = express.Router();

const MAX_LEN = 2000; // guards against absurdly long submissions

function clip(str, max) {
  if (!str) return str;
  return String(str).slice(0, max);
}

// The website sends a human-readable string like "Junk Removal" or
// "Furniture Pickup" — map it to the structured type reporting groups by.
// Anything unrecognized falls into 'other' rather than breaking.
function mapServiceType(service) {
  const s = String(service || "").toLowerCase();
  if (s.includes("furniture")) return "furniture_pickup";
  if (s.includes("demo")) return "light_demolition";
  if (s.includes("junk") || s.includes("haul")) return "junk_removal";
  return "other";
}

router.post("/", (req, res) => {
  const { name, phone, email, address, description, service, source } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "Name is required" });
  }
  if (!phone && !email) {
    return res.status(400).json({ error: "Phone or email is required" });
  }

  const cleanName = clip(String(name).trim(), 200);
  const cleanPhone = phone ? clip(String(phone).trim(), 40) : null;
  const cleanEmail = email ? clip(String(email).trim().toLowerCase(), 200) : null;
  const cleanAddress = address ? clip(String(address).trim(), 300) : null;
  const cleanDescription = description ? clip(String(description).trim(), MAX_LEN) : null;
  const cleanSource = clip(String(source || "website").trim(), 60);

  // Reuse an existing customer if this phone number already submitted
  // before, instead of creating a duplicate person on every re-submit.
  let customer = null;
  if (cleanPhone) {
    customer = db.prepare("SELECT * FROM customers WHERE phone = ?").get(cleanPhone);
  }

  if (!customer) {
    const result = db
      .prepare(
        "INSERT INTO customers (name, type, phone, email, address) VALUES (?, 'homeowner', ?, ?, ?)"
      )
      .run(cleanName, cleanPhone, cleanEmail, cleanAddress);
    customer = db.prepare("SELECT * FROM customers WHERE id = ?").get(Number(result.lastInsertRowid));
    logActivity("customer", customer.id, `Customer "${cleanName}" created from website quote request`);
  }

  const dealDescription = [service, cleanDescription].filter(Boolean).join(" \u2014 ") || null;
  const dealResult = db
    .prepare(
      "INSERT INTO deals (customer_id, stage, source, estimated_value, notes, service_type) VALUES (?, 'new_lead', ?, 0, ?, ?)"
    )
    .run(customer.id, cleanSource, dealDescription, mapServiceType(service));
  const dealId = Number(dealResult.lastInsertRowid);

  logActivity("deal", dealId, "New inquiry submitted through the website");

  res.status(201).json({ ok: true, customer_id: customer.id, deal_id: dealId });
});

module.exports = router;

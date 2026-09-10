// routes/archive.js
//
// Where deals go once they leave the Pipeline for good — either Lost
// (declined, went quiet, whatever the reason) or Completed (paid in
// full). Two very different retention rules apply:
//
//   LOST      — the itemized estimate (pricing, line items) is deleted
//               the moment a deal is marked Lost (see routes/deals.js).
//               What's kept here is just enough to remember who they
//               were and why it didn't happen, for a possible win-back
//               later — not a priced quote sitting around indefinitely.
//
//   COMPLETED — nothing is deleted. The estimate, the job, the invoice,
//               every document stays attached exactly as it was, since
//               this is a real finished transaction, not a dead lead.

const express = require("express");
const { db } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// A fixed list rather than free text — the whole point of tracking a
// reason is being able to count them later ("half our lost jobs this
// quarter were price"). Free text can't be counted.
const LOST_REASONS = [
  "Price too high",
  "Went with a competitor",
  "No longer needed",
  "Unresponsive / went quiet",
  "Bad timing",
  "Other",
];

router.get("/reasons", (req, res) => {
  res.json({ reasons: LOST_REASONS });
});

function getLostDeals() {
  return db
    .prepare(
      `SELECT deals.id, deals.lost_reason, deals.notes, deals.archived_at, deals.source, deals.service_type,
              customers.id AS customer_id, customers.name AS customer_name, customers.phone AS customer_phone,
              customers.email AS customer_email, customers.address AS customer_address
       FROM deals
       JOIN customers ON customers.id = deals.customer_id
       WHERE deals.stage = 'lost' AND deals.archived_at IS NOT NULL
       ORDER BY deals.archived_at DESC`
    )
    .all();
}

function getCompletedDeals() {
  const deals = db
    .prepare(
      `SELECT deals.id, deals.archived_at, deals.source, deals.service_type, deals.notes,
              customers.id AS customer_id, customers.name AS customer_name, customers.phone AS customer_phone,
              customers.email AS customer_email, customers.address AS customer_address
       FROM deals
       JOIN customers ON customers.id = deals.customer_id
       WHERE deals.stage = 'invoiced' AND deals.archived_at IS NOT NULL
       ORDER BY deals.archived_at DESC`
    )
    .all();

  // Attach every job and every invoice under each deal — full history,
  // not just the headline number. Small dataset, simple per-row lookups
  // beat a sprawling join here.
  const jobStmt = db.prepare("SELECT * FROM jobs WHERE deal_id = ? ORDER BY scheduled_date");
  const invoiceStmt = db.prepare(
    `SELECT invoices.* FROM invoices JOIN jobs ON jobs.id = invoices.job_id WHERE jobs.deal_id = ? ORDER BY invoices.created_at`
  );
  return deals.map((d) => ({
    ...d,
    jobs: jobStmt.all(d.id),
    invoices: invoiceStmt.all(d.id),
    total_paid: invoiceStmt.all(d.id).reduce((sum, inv) => sum + (inv.status === "paid" ? Number(inv.amount) || 0 : 0), 0),
  }));
}

router.get("/", (req, res) => {
  const lost = getLostDeals();
  const completed = getCompletedDeals();

  const totalClosed = lost.length + completed.length;
  const stats = {
    lostCount: lost.length,
    completedCount: completed.length,
    completedRevenue: completed.reduce((sum, d) => sum + d.total_paid, 0),
    winRate: totalClosed > 0 ? Math.round((completed.length / totalClosed) * 100) : null,
    lostReasonBreakdown: LOST_REASONS.map((reason) => ({
      reason,
      count: lost.filter((d) => (d.lost_reason || "Other") === reason).length,
    })).filter((r) => r.count > 0),
  };

  // Win-back candidates: Lost leads that are old enough for a "still
  // interested?" check-in to feel natural rather than pushy. This is
  // deliberately a surfaced list for a human to act on, not an
  // auto-send — texting someone who already told you no, without a
  // person deciding to do it, is exactly the kind of thing that damages
  // a small local business's reputation instead of helping it.
  const WINBACK_THRESHOLD_DAYS = 60;
  const now = Date.now();
  const winBackCandidates = lost
    .map((d) => {
      const daysSince = Math.floor((now - new Date(d.archived_at.replace(" ", "T") + "Z").getTime()) / 86400000);
      return { ...d, days_since_lost: daysSince };
    })
    .filter((d) => d.days_since_lost >= WINBACK_THRESHOLD_DAYS)
    .sort((a, b) => b.days_since_lost - a.days_since_lost);

  res.json({ lost, completed, stats, winBackCandidates });
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
function sendCsv(res, filename, csv) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}
function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

router.get("/lost.csv", requireAdmin, (req, res) => {
  const csv = toCsv(getLostDeals(), [
    { key: "customer_name", label: "Customer" },
    { key: "customer_phone", label: "Phone" },
    { key: "customer_email", label: "Email" },
    { key: "customer_address", label: "Address" },
    { key: "lost_reason", label: "Lost Reason" },
    { key: "service_type", label: "Service Type" },
    { key: "source", label: "Source" },
    { key: "archived_at", label: "Marked Lost On" },
  ]);
  sendCsv(res, `flexhaul-lost-leads-${todayStamp()}.csv`, csv);
});

router.get("/completed.csv", requireAdmin, (req, res) => {
  const rows = getCompletedDeals().map((d) => ({
    ...d,
    job_dates: d.jobs.map((j) => j.scheduled_date || "unscheduled").join("; "),
    invoice_ids: d.invoices.map((i) => `#${i.id}`).join("; "),
  }));
  const csv = toCsv(rows, [
    { key: "customer_name", label: "Customer" },
    { key: "customer_phone", label: "Phone" },
    { key: "customer_email", label: "Email" },
    { key: "customer_address", label: "Address" },
    { key: "service_type", label: "Service Type" },
    { key: "source", label: "Source" },
    { key: "total_paid", label: "Total Paid" },
    { key: "job_dates", label: "Job Date(s)" },
    { key: "invoice_ids", label: "Invoice(s)" },
    { key: "archived_at", label: "Completed On" },
  ]);
  sendCsv(res, `flexhaul-completed-jobs-${todayStamp()}.csv`, csv);
});

module.exports = router;

// routes/dashboard.js
const express = require("express");
const { db } = require("../db");

const router = express.Router();

router.get("/", (req, res) => {
  const openDeals = db
    .prepare("SELECT COUNT(*) AS n FROM deals WHERE stage NOT IN ('invoiced', 'lost')")
    .get().n;

  const jobsThisWeek = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE scheduled_date >= date('now', 'weekday 0', '-7 days')
         AND scheduled_date < date('now', 'weekday 0', '+1 days')
         AND status != 'canceled'`
    )
    .get().n;

  const overdueInvoices = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM invoices
       WHERE status = 'unpaid' AND due_date IS NOT NULL AND due_date < date('now')`
    )
    .get();

  const recentActivity = db
    .prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20")
    .all();

  const upcomingJobs = db
    .prepare(
      `SELECT jobs.id, jobs.scheduled_date, jobs.scheduled_time_slot, jobs.address, jobs.status, customers.name AS customer_name
       FROM jobs
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE jobs.scheduled_date >= date('now') AND jobs.status != 'canceled'
       ORDER BY jobs.scheduled_date ASC LIMIT 8`
    )
    .all();

  const pipelineByStage = db
    .prepare("SELECT stage, COUNT(*) AS n, COALESCE(SUM(estimated_value),0) AS value FROM deals GROUP BY stage")
    .all();

  res.json({
    open_deals: openDeals,
    jobs_this_week: jobsThisWeek,
    overdue_invoices: { count: overdueInvoices.n, total: overdueInvoices.total },
    recent_activity: recentActivity,
    upcoming_jobs: upcomingJobs,
    pipeline_by_stage: pipelineByStage,
  });
});

module.exports = router;

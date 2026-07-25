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

  // "How much we made" — total of every invoice actually marked paid, all time.
  const totalRevenue = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE status = 'paid'")
    .get().total;

  // "How much we could make" — total value sitting in every deal that
  // hasn't closed out yet (won, quoted, scheduled, etc.) or been lost.
  const pipelineValue = db
    .prepare("SELECT COALESCE(SUM(estimated_value),0) AS total FROM deals WHERE stage NOT IN ('invoiced', 'lost')")
    .get().total;

  // Revenue this calendar month specifically, since "all time" alone
  // doesn't tell you how business is doing right now.
  const revenueThisMonth = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) AS total FROM invoices WHERE status = 'paid' AND paid_at >= date('now','start of month')"
    )
    .get().total;

  // Revenue by service type — which line of business actually makes
  // the money. Joins paid invoices back through jobs -> deals to reach
  // the deal's service_type. Deals without a service_type set (older
  // ones, or ones entered before this field existed) show up grouped
  // as "Unspecified" rather than silently vanishing from the total.
  const revenueByService = db
    .prepare(
      `SELECT COALESCE(deals.service_type, 'unspecified') AS service_type,
              COUNT(*) AS job_count, COALESCE(SUM(invoices.amount),0) AS total
       FROM invoices
       JOIN jobs ON jobs.id = invoices.job_id
       JOIN deals ON deals.id = jobs.deal_id
       WHERE invoices.status = 'paid'
       GROUP BY service_type
       ORDER BY total DESC`
    )
    .all();

  // Lead source conversion — which channel (website, referral, phone,
  // furniture store...) actually turns into real business, not just
  // inquiries. "Converted" = reached won or further, not lost.
  const leadSourceConversion = db
    .prepare(
      `SELECT COALESCE(source, 'unspecified') AS source,
              COUNT(*) AS total_leads,
              SUM(CASE WHEN stage NOT IN ('new_lead','quoted','lost') THEN 1 ELSE 0 END) AS converted,
              COALESCE(AVG(CASE WHEN stage NOT IN ('new_lead','quoted','lost') THEN estimated_value END), 0) AS avg_won_value
       FROM deals
       GROUP BY source
       ORDER BY total_leads DESC`
    )
    .all();

  // Compliance alerts — permits/COIs/surveys expiring within 30 days,
  // or already expired. Real risk reduction for demolition work, not
  // just a nice-to-have.
  const complianceAlerts = db
    .prepare(
      `SELECT documents.id, documents.type, documents.expires_at, documents.original_name,
              jobs.id AS job_id, jobs.address AS job_address, customers.name AS customer_name
       FROM documents
       JOIN jobs ON jobs.id = documents.job_id
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE documents.expires_at IS NOT NULL AND documents.expires_at <= date('now', '+30 days')
       ORDER BY documents.expires_at ASC
       LIMIT 10`
    )
    .all();

  // Review requests due — jobs that finished but haven't had a review
  // ask sent yet. This is the to-do list until real automated
  // text/email is wired in.
  const reviewRequestsDue = db
    .prepare(
      `SELECT jobs.id, jobs.updated_at, customers.name AS customer_name, customers.phone AS customer_phone
       FROM jobs
       JOIN deals ON deals.id = jobs.deal_id
       JOIN customers ON customers.id = deals.customer_id
       WHERE jobs.status = 'complete' AND jobs.review_requested = 0
       ORDER BY jobs.updated_at DESC
       LIMIT 10`
    )
    .all();

  // Job costing — estimate value vs. what the job actually cost, across
  // every job that's had a real cost logged. NULL actual_cost jobs are
  // excluded rather than treated as $0, since "not entered yet" and
  // "cost nothing" are very different things.
  const jobCosting = db
    .prepare(
      `SELECT COUNT(*) AS jobs_costed,
              COALESCE(SUM(invoices.amount),0) AS total_billed,
              COALESCE(SUM(jobs.actual_cost),0) AS total_actual_cost
       FROM jobs
       JOIN invoices ON invoices.job_id = jobs.id
       WHERE jobs.actual_cost IS NOT NULL`
    )
    .get();

  res.json({
    open_deals: openDeals,
    jobs_this_week: jobsThisWeek,
    overdue_invoices: { count: overdueInvoices.n, total: overdueInvoices.total },
    recent_activity: recentActivity,
    upcoming_jobs: upcomingJobs,
    pipeline_by_stage: pipelineByStage,
    total_revenue: totalRevenue,
    revenue_this_month: revenueThisMonth,
    pipeline_value: pipelineValue,
    revenue_by_service: revenueByService,
    lead_source_conversion: leadSourceConversion,
    compliance_alerts: complianceAlerts,
    review_requests_due: reviewRequestsDue,
    job_costing: {
      jobs_costed: jobCosting.jobs_costed,
      total_billed: jobCosting.total_billed,
      total_actual_cost: jobCosting.total_actual_cost,
      margin: jobCosting.total_billed - jobCosting.total_actual_cost,
    },
  });
});

module.exports = router;

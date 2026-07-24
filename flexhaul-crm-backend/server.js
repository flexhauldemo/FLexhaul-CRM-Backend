// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const { requireAuth } = require("./middleware/auth");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const customerRoutes = require("./routes/customers");
const dealRoutes = require("./routes/deals");
const estimateRoutes = require("./routes/estimates");
const jobRoutes = require("./routes/jobs");
const crewRoutes = require("./routes/crews");
const equipmentRoutes = require("./routes/equipment");
const documentRoutes = require("./routes/documents");
const invoiceRoutes = require("./routes/invoices");
const timeSlotsRoutes = require("./routes/timeSlots");

const app = express();
const PORT = process.env.PORT || 4000;

// CORS: restrict to your actual site origin in production via ALLOWED_ORIGIN.
// Left open during local development if that variable isn't set.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
app.use(
  cors({
    origin: ALLOWED_ORIGIN || true,
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));

// Uploaded photos/documents are served statically. In production, put
// this behind the same auth as the rest of the app if the files are
// sensitive (e.g. via a signed-URL proxy) — see README.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Only /api/auth/login is unauthenticated (checked inside auth.js itself).
// Every other /api/auth/* route and every other router below requires a
// valid token.
app.use("/api/auth", authRoutes);

app.use("/api/dashboard", requireAuth, dashboardRoutes);
app.use("/api/customers", requireAuth, customerRoutes);
app.use("/api/deals", requireAuth, dealRoutes);
app.use("/api/estimates", requireAuth, estimateRoutes);
app.use("/api/jobs", requireAuth, jobRoutes);
app.use("/api/crews", requireAuth, crewRoutes);
app.use("/api/equipment", requireAuth, equipmentRoutes);
app.use("/api/documents", requireAuth, documentRoutes);
app.use("/api/invoices", requireAuth, invoiceRoutes);
app.use("/api/time-slots", requireAuth, timeSlotsRoutes);

// attach req.user inside routes that log activity — the requireAuth
// middleware above already sets it before these routers run.

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler — catches anything thrown synchronously in a
// route and returns JSON instead of leaking an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`FlexHaul CRM API listening on port ${PORT}`);
});

module.exports = app;

// routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("../db");
const { requireAuth, requireAdmin, JWT_SECRET } = require("../middleware/auth");

const router = express.Router();

// POST /api/auth/login — the only unauthenticated route in the whole API.
router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(String(email).toLowerCase().trim());

  if (!user) {
    // Same generic message whether the email doesn't exist or the
    // password is wrong — don't reveal which one it was.
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// GET /api/auth/me — lets the frontend confirm a stored token is still valid
// and re-fetch the current user on page load, without prompting for a
// password again every time.
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/users — admin-only: create a new staff login.
// This is what gives every staff member their own account instead of
// one shared password.
router.post("/users", requireAuth, requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  const normalizedEmail = String(email).toLowerCase().trim();

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: "A user with that email already exists" });
  }

  const hash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
    .run(name, normalizedEmail, hash, role === "admin" ? "admin" : "staff");

  res.status(201).json({ id: Number(result.lastInsertRowid), name, email: normalizedEmail, role: role || "staff" });
});

// GET /api/auth/users — admin-only: list staff logins (no password hashes returned).
router.get("/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, name, email, role, created_at FROM users ORDER BY created_at").all();
  res.json({ users });
});

module.exports = router;

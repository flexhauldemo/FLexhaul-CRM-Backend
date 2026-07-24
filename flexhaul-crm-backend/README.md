# FlexHaul CRM

A CRM for FlexHaul & Demolition, built as a login-gated `admin.html` that attaches
to the existing public site without modifying it. Phase 1 only, per the build
brief — dashboard, pipeline, customers, estimates, jobs, calendar, and simple
invoicing, all working end to end. Phase 2 (compliance tracking, crew/equipment
conflict detection, dispatch routing, job costing, client portal, reporting,
automated review requests) is intentionally not started, per the brief's own
instruction to get Phase 1 approved first.

## How this is different from the rest of your site

Your public website (`index.html`, `hauling.html`, etc.) is untouched — this
CRM is a completely separate system that happens to live at `/admin.html` and
`/admin/`. It needs its own backend server and database, which is **not**
something Netlify (where your public site lives) can run. That's not a
limitation of this build — it's true of any real CRM; a static file host can
serve HTML but can't run a server or hold a database.

**This replaces the old `admin.html`.** If you had the earlier lightweight
"Dispatch Board" (the one reading from Netlify Blobs / local storage), this
is a full replacement — same URL, completely different system underneath.
The old one won't work anymore once you deploy this.

## Project structure

```
admin.html          <- login-gated entry point (this replaces your old admin.html)
admin/
  api.js             <- talks to the backend API
  app.js              <- login flow, navigation, view routing
  styles.css          <- the whole design system
  views/               <- one file per screen
  images/
api/                  <- separate backend service (deploy this separately, see below)
  server.js
  db.js               <- SQLite schema (built on Node's native sqlite module)
  seed.js             <- creates your first login + sample data
  routes/
  middleware/
```

## Part 1 — Run it locally first

Do this before deploying anywhere, so you can see it working and get
comfortable with it.

```bash
cd api
npm install
cp .env.example .env
```

Open `.env` and fill in `JWT_SECRET` — generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste that value in. Leave `PORT` and `ALLOWED_ORIGIN` as-is for local use.

Create your first login:

```bash
node seed.js "Your Name" you@example.com "a-strong-password"
```

This also adds a couple of sample customers/deals/jobs so the screens aren't
empty on first look. Start the backend:

```bash
node server.js
```

You should see `FlexHaul CRM API listening on port 4000`.

Now serve the frontend. From the project root (not inside `api/`), in a
**second terminal**:

```bash
python3 -m http.server 8080
```
(or any static file server — `npx serve`, VS Code's Live Server extension,
whatever you're comfortable with)

Open `http://localhost:8080/admin.html` and log in with the email/password
you just created.

## Part 2 — Deploy for real

Two separate deployments: the backend API (a real server), and the frontend
(stays wherever your public site already is — Netlify).

### Deploy the API

The brief calls for Render, Railway, or Fly.io. **Render** is the simplest
for a first deploy:

1. Push this whole project to a GitHub repo (or add it to your existing one).
2. In Render: **New → Web Service**, connect the repo.
3. **Root Directory**: `api`
4. **Build Command**: `npm install`
5. **Start Command**: `node server.js`
6. Add environment variables (Render's dashboard, not a `.env` file in
   production): `JWT_SECRET` (generate a new one, don't reuse your local one),
   and `ALLOWED_ORIGIN` set to your public site's URL, e.g.
   `https://flexhaul.netlify.app` (this locks down which website is allowed
   to call your API).
7. Deploy. Render gives you a URL like `https://flexhaul-crm-api.onrender.com`.
8. SSH or use Render's shell to run the seed command once:
   `node seed.js "Your Name" you@example.com "a-strong-password"`

**One thing to know about Render's free tier:** it spins down after
inactivity and takes ~30-60 seconds to wake back up on the next request.
Fine for a small operation checking in a few times a day; upgrade to a paid
instance if that delay ever becomes annoying.

**About the SQLite database file — read this before you rely on this for
real customer data.** On most hosts (including Render's free tier), the
filesystem is **ephemeral** — it gets wiped every time you redeploy. The
CRM itself never deletes anything, but an ephemeral filesystem will, which
amounts to the same lost data from your perspective. Fix this **before**
you start entering real customers:

**Add a persistent disk (recommended at your size — cheap, zero code changes):**
1. In Render, open your web service → **Disks** tab → **Add Disk**
2. Mount path: `/opt/render/project/src/api/data` (this is where
   `db.js` already looks for the database file — no code changes needed)
3. Size: 1 GB is overkill for years of customer/job records at this scale;
   Render's minimum billing size is fine
4. Save and redeploy once. From then on, that disk survives every future
   redeploy, and your data is genuinely permanent.

This costs a small monthly fee (currently around $1/GB on Render — check
their current pricing) but is by far the simplest fix, and is plenty
robust for a two-person operation.

**If you outgrow this later** (multiple people hitting the CRM
simultaneously at real volume, wanting managed backups, etc.), migrating
to Postgres is the natural next step — Render offers a free Postgres tier,
and the brief calls this out as the expected evolution. That's a real
rewrite (every database call in the backend changes from synchronous to
async) — worth doing when you actually need it, not preemptively.

### Point the frontend at the real API

In `admin.html`, find this near the top:

```html
<script>
  window.FLEXHAUL_API_BASE = "http://localhost:4000/api";
</script>
```

Change it to your deployed API's URL:

```html
<script>
  window.FLEXHAUL_API_BASE = "https://flexhaul-crm-api.onrender.com/api";
</script>
```

Then upload the changed `admin.html` (and the whole `admin/` folder, if you
haven't already) to your existing site on Netlify, the same way you've been
deploying the rest of the site.

### Try it

Go to `https://your-real-site.com/admin.html`, log in, and you should see
the same dashboard you tested locally — now backed by a real deployed
database instead of your laptop.

## Connect Google Calendar

Optional, and off by default. When configured, every job you create or
update in the CRM automatically creates/updates a matching event on a
shared Google Calendar — so you and Stephen can see the schedule in
whatever calendar app you already use on your phones, with normal native
notifications. **The CRM stays the source of truth** — you keep scheduling
jobs the same way you already do; this just mirrors that onto a real
calendar for viewing. It's one-directional: editing an event directly in
Google Calendar won't change anything back in the CRM.

**Time windows:** every job can optionally have a time window, not just a
date — the same nine 2-hour windows used on the public site's furniture
pickup booking (8:00–10:00 AM through 4:00–6:00 PM). Pick one when you
create or edit a job, and synced calendar events use the real start/end
time instead of showing as an all-day event. A job with a date but no
chosen window still syncs as all-day, so nothing's required to keep using
this the simpler way if you prefer.

### Setup (about 10 minutes, one-time)

1. **Create a Google Calendar to sync to.** In Google Calendar, create a
   new calendar named something like "FlexHaul Jobs" (Settings → Add
   calendar → Create new calendar). This can live under either your or
   Stephen's existing Google account — whoever owns it can share it with
   the other.

2. **Create a Google Cloud project and service account:**
   - Go to [console.cloud.google.com](https://console.cloud.google.com),
     create a new project (any name).
   - Search for and enable the **Google Calendar API** for that project.
   - Go to **IAM & Admin → Service Accounts → Create Service Account**.
     Any name works, e.g. "flexhaul-crm-calendar". Skip granting it any
     project-level roles — it doesn't need any.
   - Click into the new service account → **Keys** tab → **Add Key →
     Create new key → JSON**. This downloads a `.json` file — keep it
     private, it's a real credential.

3. **Share your calendar with the service account.** Open the downloaded
   JSON file and copy the `client_email` value (looks like
   `flexhaul-crm-calendar@your-project.iam.gserviceaccount.com`). Back in
   Google Calendar, go to your "FlexHaul Jobs" calendar's **Settings and
   sharing → Share with specific people**, add that email, and give it
   **"Make changes to events"** permission.

4. **Get the Calendar ID.** Same settings page, scroll to **Integrate
   calendar** — copy the **Calendar ID** (looks like
   `abc123xyz@group.calendar.google.com`).

5. **Set the two environment variables:**
   - `GOOGLE_CALENDAR_ID` — the ID from step 4.
   - `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` — the *entire contents* of the
     JSON key file from step 2, base64-encoded onto a single line:
     ```bash
     base64 -i path/to/your-key-file.json
     ```
     (on Windows: `certutil -encode path\to\key.json out.txt`, then use
     the contents of `out.txt` minus the header/footer lines)

     Paste that single long string as the value. Add both variables in
     Render's environment variables dashboard (or your `.env` file for
     local testing) and redeploy.

6. **Test it:** create or edit a job in the CRM with a scheduled date, then
   check the "FlexHaul Jobs" calendar — the event should appear within a
   few seconds. If it doesn't, check your API server's logs for a line
   starting with "Google Calendar sync failed" — that'll tell you exactly
   what went wrong (usually a copy-paste issue with the base64 key, or the
   calendar wasn't actually shared with the service account's email).

7. **Subscribe on your phones.** In the Google Calendar app (or any
   calendar app that supports Google accounts), add the "FlexHaul Jobs"
   calendar so it shows up alongside your personal calendar. Both you and
   Stephen can do this once the calendar's shared with each of you too.



## Adding staff logins

Every user gets their own real login — no more shared passwords. Only an
`admin`-role user can create new ones. There's no UI screen for this in
Phase 1 (it wasn't in the checklist), so do it via a quick API call:

```bash
curl -X POST https://your-api-url.onrender.com/api/auth/users \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{"name":"Stephen Laster","email":"stephen@example.com","password":"a-strong-password","role":"admin"}'
```

Get `YOUR_ADMIN_TOKEN` by logging in via `/api/auth/login` and copying the
`token` field from the response, or just open your browser's dev tools while
logged into the CRM and check `localStorage.getItem('flexhaul_crm_token')`.

## Customer order history

Click any customer to see their full history in one place: every upcoming
job (date, time window, address, status) and every past job, split
automatically — you don't have to figure out which of their deals are old
vs. current. If they have an active won deal, a **"Schedule Job"** button
jumps straight to creating a new job for them without navigating through
Pipeline first. Clicking any job in that list opens its full detail
(documents, invoicing, status) on the Jobs screen.

## What's genuinely tested vs. what to verify yourself

I ran this end to end — every API route with real requests (including the
edge cases: bad login, wrong role trying admin actions, invalid pipeline
stage, file upload with a disallowed file type), and the actual browser UI
clicking through the full workflow: create a deal → move it through pipeline
stages → build an estimate with live-calculated totals → win the deal →
create a job → upload a document → generate an invoice from the estimate →
mark it paid → log out. Also checked mobile/tablet/desktop layouts for
overflow. All of that passed.

The customer detail view's past/upcoming job split (see "Customer order
history" below) was tested with a deliberately tricky case — a job dated in
the future but marked complete — to confirm it lands in exactly one list,
never both or neither.

What I *can't* test from here: the actual Render/Railway/Fly.io deployment
itself, since that needs real hosting accounts. Follow Part 2 above closely
on the first deploy, and if something doesn't match what's described, it's
almost always either the environment variables not being set on the host, or
`ALLOWED_ORIGIN` not matching your site's exact URL (CORS will block the
request — check your browser console for a CORS error specifically, that's
the tell).

**On Google Calendar specifically:** I tested that jobs still create and
update correctly with calendar sync off (the default), and that a
misconfigured or invalid calendar connection fails safely — the job still
saves, the error just gets logged instead of breaking anything. What I
couldn't test is a *real* successful sync, since that needs an actual Google
Cloud project and service account, which only you can create. If step 6 in
the setup above doesn't show the event appearing, check the server logs
first — the error message there is usually specific enough to point at the
exact issue (bad key, calendar not shared, wrong calendar ID).

## When you're ready for Phase 2

Per the brief: don't start it until Phase 1 has been actually used for a
bit and you know what's missing or annoying. When you get there, the natural
order given what's already built is: compliance tracking on the job record
(you already have a `documents` table with a `type` field ready for permits/
surveys/COIs), then crew/equipment conflict detection, then the rest.

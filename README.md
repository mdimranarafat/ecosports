# Eco Sports — Facility Booking & Management Platform

A production-ready sports facility booking and business-management system
for Eco Sports (Chattogram, Bangladesh) — public booking website + admin
dashboard + manager dashboard, built on Firebase Authentication, Cloud
Firestore, and Google Apps Script (no Firebase Storage anywhere).

See `ARCHITECTURE.md` for the system design, Firestore schema, permission
matrix, booking-conflict strategy, and pricing algorithm in detail. This
document is the practical setup/deployment guide.

---

## 1. Project Overview

- **Public site** (`/index.html`, `/booking.html`, `/facilities.html`,
  `/offers.html`, `/about.html`, `/contact.html`) — customers browse
  facilities, check live availability, and submit booking requests.
- **Admin panel** (`/admin/*.html`) — full operational control: bookings,
  calendar, facilities, pricing rules, offers, customers, staff/roles,
  revenue & growth analytics, expenses, CSV reports, audit logs, settings.
- **Manager dashboard** (`/manager/dashboard.html`) — a restricted view of
  the same panel; the sidebar auto-filters to only the pages a manager's
  permissions allow (see §16).
- **GAS backup system** (`/gas/*.gs`) — nightly/weekly Firestore → Google
  Sheets backup, independent of Firebase Storage.

## 2. Folder Structure

```
eco-sports/
├── index.html, booking.html, facilities.html, offers.html,
│   about.html, contact.html, login.html
├── admin/            ← 13 admin pages (dashboard, bookings, calendar,
│                        facilities, pricing, offers, customers, staff,
│                        revenue, expenses, reports, settings, audit-logs)
├── manager/dashboard.html
├── assets/
│   ├── css/          global.css, public.css, admin.css, responsive.css
│   ├── js/           18 ES modules — see §3 below
│   └── images/
├── firestore.rules, firestore.indexes.json, firebase.json
├── gas/               Code.gs, Backup.gs, Reports.gs, README.md
└── README.md, ARCHITECTURE.md   (this file + system design doc)
```

Every page is a plain ES module `<script type="module">` importing shared
logic from `assets/js/`. Nothing is duplicated per-page; the booking engine,
pricing engine, and permission checks each have exactly one implementation.

## 3. Technology Stack

| Layer | Choice | Why |
|---|---|---|
| Hosting | Firebase Hosting (or any static host) | Pure static files, no server runtime needed |
| Auth | Firebase Authentication (email/password) | Built into the same project, free tier covers this scale |
| Database | Cloud Firestore | Real-time, scales to Eco Sports' facility count, supports the composite queries this app needs |
| Backend logic | Firestore Security Rules + client-side transactions | No Cloud Functions required, so no Blaze-plan billing dependency for core booking logic |
| Charts | Chart.js (CDN) | Lightweight, no build step |
| Backup | Google Apps Script + Google Sheets | Free, no Firebase Storage, human-readable backups |
| Build tooling | **None** | Every file is hand-authored vanilla JS/HTML/CSS — open `index.html` directly or serve the folder as-is |

## 4–8. Firebase Setup

1. Go to the [Firebase Console](https://console.firebase.google.com/) →
   Create a project (or use an existing one).
2. **Add a Web App** (</> icon) → copy the config object into
   `assets/js/firebase-config.js` (`firebaseConfig`).
3. **Authentication** → Sign-in method → enable **Email/Password**.
4. **Firestore Database** → Create database → **production mode** (never
   test mode — this repo's `firestore.rules` are the real protection).
   Choose a region close to Bangladesh (e.g. `asia-south1`).
5. Deploy rules and indexes with the [Firebase CLI](https://firebase.google.com/docs/cli):
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add        # select your project
   firebase deploy --only firestore:rules,firestore:indexes
   ```
6. **Firebase Hosting** (optional, or use any static host):
   ```bash
   firebase deploy --only hosting
   ```

### Required composite indexes

Already defined in `firestore.indexes.json` — deployed by the command
above. They cover: bookings by `facilityId + date + startMinutes` (conflict
detection), bookings by `date` range (dashboard/reports), `auditLogs` by
`entityType + timestamp`, and `offers` by `active`.

## 9. Environment / Configuration Setup

There is no `.env` file — Firebase web config is not a secret (see comment
in `firebase-config.js`). The only values you must set before going live:

- `firebaseConfig` in `assets/js/firebase-config.js`
- `APP_CHECK_ENABLED` + `APP_CHECK_SITE_KEY` once you've set up App Check
  (see §28 in `ARCHITECTURE.md`)

## 10–12. Google Apps Script & Sheets Backup Setup

Full walkthrough in **`gas/README.md`** — covers creating the backup
spreadsheet, creating a read-only Google Cloud service account, storing
credentials in Script Properties, running your first backup, and
installing the daily/weekly triggers.

## 13. Deployment Instructions

Any static host works (Firebase Hosting, Netlify, Vercel, Nginx). For
Firebase Hosting:

```bash
firebase deploy --only hosting,firestore:rules,firestore:indexes
```

`firebase.json` already rewrites `/admin/**` to `/admin/index.html` (which
itself redirects to `/admin/dashboard.html` after the auth guard runs) so
deep admin links refresh correctly instead of 404ing.

## 14. Creating the First Super Admin

Firestore rules only allow `super_admin` to create staff accounts (§23 in
`ARCHITECTURE.md`) — so the very first one must be created by hand:

1. Firebase Console → Authentication → Add user → enter the owner's email
   + a temporary password. Copy the generated **UID**.
2. Firebase Console → Firestore → start collection `users` → document ID =
   that UID → add fields:
   ```
   uid: "<the UID>"
   name: "Owner Name"
   email: "owner@ecosports.example"
   role: "super_admin"
   permissions: {}          // ignored for super_admin — see roles.js
   status: "active"
   createdAt: <timestamp, now>
   lastLogin: null
   ```
3. Sign in at `/login.html` with that email/password. You now have full
   access and can create every other account from **Admin → Staff & Roles**.

## 15. How to Create a Manager

As a signed-in super_admin or admin with `staff.manage`: **Admin → Staff &
Roles → + Add Staff**, choose role **Manager**. Managers get the default
permission bundle from `assets/js/roles.js` (`ROLE_DEFAULTS.manager`):
bookings view/create/edit/cancel, facilities view, customers view, revenue
view, offers manage, reports export. Fine-tune individual permissions
afterward via **Edit Role** on that row (super_admin only).

## 16. How to Configure Permissions

Every permission-gated action checks one of the 16 keys in
`assets/js/roles.js` `PERMISSIONS` — never just `role === "admin"`. Change
any staff member's individual permissions from **Admin → Staff & Roles →
Edit Role** (super_admin only — enforced both in the UI and in
`firestore.rules`, which also blocks anyone from escalating their own
role/permissions even via a direct Firestore write).

## 17. How to Add Facilities

**Admin → Facilities → + Add Facility.** Set name, hours, slot interval,
min/max duration, and display order. It appears automatically on the
homepage, `/facilities.html`, `/booking.html`, and every admin page that
lists facilities — nothing is hardcoded (see `facility-manager.js`).

## 18. How to Configure Pricing

**Admin → Pricing Rules.** Each rule targets a facility, a set of weekdays,
a time window, and a price (per-hour and/or fixed per-duration overrides),
with a priority for resolving overlaps and a rounding mode. See
`assets/js/pricing-engine.js` and §10–12 in `ARCHITECTURE.md` for the full
resolution algorithm.

## 19. How to Create Offers

**Admin → Offers → + New Offer.** Percentage, fixed-amount, special-price,
or buy-X-hours discounts, scoped to a facility/day/time window and an
optional date range and usage cap. The booking flow calls
`pricing-engine.js`'s `applyBestOffer()` automatically — no manual
"apply code" step is required for automatic offers, and a `code` field is
available for offers that should require the customer to enter it.

## 20. How CSV Export Works

**Admin → Reports & CSV.** Pick a date-range preset (or custom range) and
click Export on any of the six report types (Bookings, Revenue, Customers,
Expenses, Facility Performance, Payment Report). Generation happens
entirely client-side against Firestore range queries (`csv-export.js`) —
no server round-trip, no data leaves the browser except the download.

## 21. Security Checklist

- [x] Firestore is in **production mode**; `firestore.rules` never contains
      `allow read, write: if true`.
- [x] Every write path (bookings, pricing, offers, expenses, staff, users)
      requires a specific permission key, checked server-side in rules —
      not just in the UI.
- [x] Public users can create bookings but can **never** set their own
      `finalPrice` — booking creation validates the submitted price against
      what the pricing/offer engine computes (see `booking-engine.js` +
      rules `bookings` `create` validation).
- [x] A user can never escalate their own role or permissions, even via a
      direct Firestore write (`notEscalatingSelf()` in rules).
- [x] Financial collections (`expenses`, `paymentRecords`) and `auditLogs`
      are unreadable without the matching permission.
- [x] No hardcoded admin email is used as a security mechanism anywhere —
      access is entirely role/permission-document driven.
- [x] Booking overlap checks run through a Firestore transaction so two
      simultaneous bookings for the same slot can't both succeed (§29 in
      `ARCHITECTURE.md`).
- [x] Firebase App Check integration point is wired in `firebase-config.js`
      (disabled by default until you register a reCAPTCHA site key — see
      `ARCHITECTURE.md` §28).
- [ ] **Before go-live:** rotate the Firebase web config only if it was ever
      committed alongside real production data by mistake (it's not secret,
      but good hygiene); enable App Check; review `firestore.rules` against
      your final permission list if you add new collections.

## 22. Testing Checklist

- [ ] Sign in as each role (super_admin, admin, manager, staff) and confirm
      the sidebar only shows permitted links.
- [ ] Attempt a booking that overlaps an existing one — confirm rejection
      with a clear message, on both the public and admin manual-booking flow.
- [ ] Create two browser tabs, attempt to book the identical slot in both
      within a few seconds — confirm only one succeeds.
- [ ] Create a pricing rule + an offer for the same facility/window, confirm
      the booking preview shows the correct resolved price and priority.
- [ ] Add a facility, confirm it appears on the homepage, facilities page,
      booking page, and admin dropdowns without a code change.
- [ ] Export each of the 6 CSV report types and open in a spreadsheet app
      to confirm headers and data are correct.
- [ ] Run **Eco Sports Backup → Run Full Backup Now** in the GAS Sheet,
      confirm every tab populates and `BackupLogs` shows `SUCCESS`.
- [ ] As a non-super_admin with `staff.manage`, confirm you can toggle a
      staff member's active status but cannot open the role/permission
      editor.
- [ ] Resize the browser to a phone width on `admin/bookings.html` and
      `admin/calendar.html` — confirm tables reflow to stacked cards, not
      horizontal scroll-only.

## Known Limitations / Roadmap

- Payment gateway integration is intentionally **not** wired up (§14 in the
  brief) — the schema (`originalAmount`, `discountAmount`, `finalPrice`,
  `paidAmount`, `dueAmount`, `paymentMethod`, `paymentStatus`) is ready for
  it; add a `paymentRecords` write + webhook handler when you pick a
  provider (bKash/Nagad both offer merchant APIs).
- Customer search (`customer-manager.js`) is a bounded client-side filter
  over the 500 most recent customers — fine at Eco Sports' current scale;
  swap in Algolia/Typesense if the customer base grows into the tens of
  thousands and search needs to cover the full history.
- SMS/WhatsApp booking confirmations are not included — the booking
  document has everything needed to trigger one from a Cloud Function or
  a third-party webhook if you want to add it later.

# Eco Sports — System Architecture (Phase 1)

## 1. Stack

- **Frontend:** Static HTML/CSS/vanilla JS (ES modules), Firebase Web SDK v10 (modular).
- **Auth:** Firebase Authentication (email/password for staff; public users book without an account).
- **Database:** Cloud Firestore only. No Firebase Storage.
- **Backup:** Google Apps Script (Web App) writing into Google Sheets, called from an authenticated admin action or a scheduled Cloud Scheduler-less approach (GAS time-driven trigger pulls from Firestore via a service-account-authenticated REST call — see `gas/README.md` in Phase 4).
- **Images:** External URLs only (e.g. admin pastes an image URL from any host).
- **Hosting:** Firebase Hosting (or any static host) — pure static files, no build step required, so this can be deployed by dragging the folder into any static host too.

## 2. Why no client-trusted pricing

The single most important security decision in this system: **the client never sends a final price that gets trusted as-is.**

- The client sends: `facilityId, date, startTime, durationMinutes, offerCode (optional)`.
- A Firestore-callable **Cloud Function is NOT used here** because the brief restricts us to Firestore + GAS + client JS (no paid Storage, but Cloud Functions run on Blaze plan too and weren't requested). Instead, price computation logic lives in `assets/js/pricing-engine.js` and is **duplicated conceptually** in Firestore Security Rules as a defense-in-depth validation: rules check that `booking.finalPrice`, `booking.originalPrice` are within the bounds defined by the matching `pricingRules` documents that are readable server-side at rule-evaluation time via `get()`.
- Because Firestore rules cannot execute arbitrary JS loops elegantly, the practical model used is:
  1. **Untrusted client** computes a *proposed* price using the same open-source pricing engine (transparent, not a secret).
  2. **Booking is created with `status: "pending_review"` if pricing looks anomalous**, OR, more robustly for this phase: **only authenticated staff can set `status` beyond `pending`, and public bookings always start as `pending` with `paymentStatus: "unpaid"`, `finalPrice` server-recomputed by an admin action before `confirmed`.**
  3. Security rules additionally re-run a **simplified bounds check**: they fetch the matching active `pricingRules` docs for that facility/day/time and reject a `finalPrice` that is *lower* than the cheapest matching rule's price minus the maximum active offer discount. This blocks the obvious "set price to 1 BDT" attack even without a full function runtime.
- **Recommendation documented in README:** for a full production hardening pass, move final price computation into a Cloud Function (`onCreate` trigger that recomputes and corrects `finalPrice`, or a callable function `createBooking`). The architecture here is written so that swapping the client-side write for a callable function later is a one-file change (`booking-engine.js` only).

## 3. Firestore Schema

```
users/{uid}
  name, email, role, permissions: {map of booleanish keys}, status, createdAt, lastLogin

facilities/{facilityId}
  name, slug, description, imageUrl, icon, active, displayOrder,
  openingTime ("05:00"), closingTime ("29:00" i.e. supports >24h for overnight),
  slotIntervalMinutes, minDurationMinutes, maxDurationMinutes,
  allowOvernight, createdAt, updatedAt

bookings/{bookingId}                 // doc id == human bookingId e.g. ECO-20260824-001
  bookingId, facilityId, facilityName,
  customerName, customerPhone, customerEmail,
  date ("2026-08-24"), startMinutes (int, minutes since local midnight, can exceed 1440 for overnight),
  endMinutes (int), durationMinutes,
  startTimestamp (Firestore Timestamp, UTC-correct), endTimestamp,
  status: pending|approved|confirmed|completed|cancelled|rejected|no_show,
  players, note,
  originalPrice, discountAmount, finalPrice, paidAmount, dueAmount,
  paymentStatus: unpaid|partial|paid|refunded, paymentMethod,
  offerId (nullable), pricingRuleId (nullable, for audit),
  recurringGroupId (nullable),
  source: "public"|"admin"|"manager",
  createdBy (uid or "public"), createdAt, updatedAt

customers/{customerId}                // customerId derived from normalized phone
  name, phone, email, totalBookings, completedBookings, cancelledBookings,
  totalSpending, outstandingDue, firstBookingAt, lastBookingAt, notes

pricingRules/{ruleId}
  facilityId, days: [0-6], startMinutes, endMinutes,
  pricePerHour, durationPrices: {60: 750, 90: 1150, 120: 1500},
  weekendAdjustPercent (nullable, applies on top for configured weekend days),
  priority (1-100, higher wins), active, createdAt, updatedAt

offers/{offerId}
  name, code, type: percentage|fixed|special_price|buyx,
  value, facilityId (nullable = all), days, startTime, endTime,
  startDate, endDate, usageLimit, usageCount, active,
  revenueGenerated, discountGiven, createdAt

expenses/{expenseId}
  category, amount, date, facilityId (nullable), description, createdBy, createdAt

paymentRecords/{paymentId}
  bookingId, amount, method, recordedBy, createdAt

auditLogs/{logId}
  action, entityType, entityId, previousSummary, newSummary, performedBy, performedByName, timestamp

settings/{singleton = "business"}
  businessName, phone, email, address, currency, timezone,
  defaultSlotInterval, minBookingDuration, maxBookingDuration, leadTimeMinutes,
  roundingMode, roundingIncrement, cancellationPolicy

dailyAnalytics/{YYYY-MM-DD}          // precomputed rollups, written by admin dashboard on read (cached) or by a nightly GAS/manual job
  totalBookings, completedBookings, cancelledBookings, revenue, expenses, profit,
  byFacility: { [facilityId]: { bookings, revenue, hoursBooked } }

backupLogs/{logId}
  type: daily|weekly|manual, status: success|failed, sheetsUrl, startedAt, finishedAt, error
```

### Why `startMinutes`/`endMinutes` AND `startTimestamp`/`endTimestamp`

- Integer minutes-since-midnight (with values >1440 allowed for overnight bookings, e.g. 23:00 = 1380, 00:30 next day = 1470) makes **overlap math trivial and index-friendly** within a single `date` document.
- Real `Timestamp` fields make **cross-date range queries, analytics, and chronological ordering** correct and Firestore-index-friendly for dashboards ("bookings this week").
- Both are written atomically on create so every query pattern (by date+facility, or by time range) has a cheap, correctly-indexed field to filter on.

## 4. Booking Conflict Strategy

Two customers can race for the same slot. Firestore doesn't have row locks, but it has **transactions**, which is what we use:

1. Client calls `createBooking()` in `booking-engine.js`.
2. Inside a Firestore `runTransaction`:
   a. Query (inside the transaction, using `get()` on a bounded query: `bookings` where `facilityId == X` and `date == Y` and `status in [pending, approved, confirmed]`) for existing bookings on that facility+date.
   b. In JS, check `[newStart, newEnd)` against every existing `[existingStart, existingEnd)` for overlap using half-open interval math: `newStart < existingEnd && existingStart < newEnd`.
   c. If any overlap → abort the transaction, throw `SlotConflictError`.
   d. If clear → `transaction.set()` the new booking doc.
3. Firestore transactions guarantee **serializable isolation**: if two clients race, Firestore retries one transaction after detecting the read-set changed, so the second transaction re-reads the just-committed booking, finds the conflict, and fails cleanly. **Only one booking can ever succeed for an overlapping slot.**
4. The failing client gets a specific error surfaced as: *"Sorry, this slot was just booked by someone else. Please choose another time."*

This is documented and testable conceptually: open two tabs, submit the same slot within milliseconds — one wins, one gets the conflict message. (See `TESTING.md` in Phase 4 for a scripted test.)

## 5. Dynamic Pricing Algorithm

Implemented in `assets/js/pricing-engine.js`, pure function, no side effects, fully unit-testable:

```
computePrice(facilityId, dateISO, startMinutes, durationMinutes, allRules) {
  1. dayOfWeek = getDay(dateISO)               // 0=Sun..6=Sat
  2. candidates = allRules.filter(r =>
       r.active && r.facilityId === facilityId &&
       r.days.includes(dayOfWeek) &&
       rangesOverlapOrContain(r.startMinutes, r.endMinutes, startMinutes, startMinutes+durationMinutes))
  3. if candidates.length === 0 → throw NoPricingRuleError (booking blocked, admin must configure pricing)
  4. winner = candidates.sort by priority desc, then most specific (smallest time window) first  [0]
  5. base = winner.durationPrices?.[durationMinutes] ?? winner.pricePerHour * (durationMinutes/60)
  6. if winner.weekendAdjustPercent && isWeekendDay(dayOfWeek, settings) → base *= (1 + pct/100)
  7. apply best matching active offer (see offers-engine.js) → discountAmount
  8. finalPrice = round(base - discountAmount, settings.roundingMode, settings.roundingIncrement)
  9. return { originalPrice: base, discountAmount, finalPrice, pricingRuleId: winner.id }
}
```

Rounding modes: `none | nearest10 | nearest50 | nearest100 | down | up | custom(increment)`.

## 6. Roles & Permission Matrix

Roles are just a default permission bundle; **actual authorization checks always test individual permission keys**, never `role === "admin"` directly (except `super_admin` which is an unconditional bypass).

| Permission key        | super_admin | admin | manager (default) | staff (default) |
|---|---|---|---|---|
| dashboard.view         | ✅ | ✅ | ✅ | ✅ |
| bookings.view           | ✅ | ✅ | ✅ | ✅ |
| bookings.create         | ✅ | ✅ | ✅ | ✅ |
| bookings.edit            | ✅ | ✅ | ✅ | ❌ |
| bookings.cancel         | ✅ | ✅ | ✅ | ❌ |
| facilities.view         | ✅ | ✅ | ✅ | ✅ |
| facilities.edit          | ✅ | ✅ | ❌ (grantable) | ❌ |
| pricing.manage          | ✅ | ✅ | ❌ (grantable) | ❌ |
| offers.manage           | ✅ | ✅ | ✅ | ❌ |
| customers.view          | ✅ | ✅ | ✅ | ✅ |
| revenue.view             | ✅ | ✅ | ✅ | ❌ |
| expenses.manage        | ✅ | ✅ | ❌ (grantable) | ❌ |
| reports.export          | ✅ | ✅ | ✅ | ❌ |
| staff.manage             | ✅ | ✅ | ❌ | ❌ |
| settings.manage        | ✅ | ❌ (grantable) | ❌ | ❌ |
| audit.view                 | ✅ | ✅ | ❌ | ❌ |

`admin` defaults are broad but `settings.manage` (which includes rounding, currency, and business-critical config) defaults **off** even for `admin` and must be explicitly granted by a `super_admin` — this satisfies "cannot manage critical system configuration unless permission is granted."

Every user doc's `permissions` map can override any individual key regardless of role, enabling per-manager customization as required.

## 7. GAS Backup Architecture (built in Phase 4)

- A GAS Web App exposes `doPost(e)` protected by a shared secret header + admin-only Firebase ID token verification (verified via Google's public JWK endpoint, no service account key needed).
- Admin dashboard's "Backup Now" button (or a daily browser-less trigger the admin sets up in Apps Script itself, since GAS triggers run server-side on Google's clock, not the browser) reads current Firestore data client-side (admin is authenticated, rules allow it) and POSTs a JSON payload to the GAS Web App URL.
- GAS writes rows into named sheet tabs (`Bookings`, `Customers`, etc.), de-duplicating by ID column so re-running a backup doesn't create duplicate rows (upsert-by-ID).
- Every run appends a row to `BackupLogs` sheet and also writes a `backupLogs` doc back to Firestore (via a second authenticated call) for dashboard visibility.

---
**Status: Phase 1 delivers everything needed to run this document's architecture end-to-end for the public booking flow.** Admin/manager UI pages, CSV export, analytics rollups, and the GAS project are Phase 2–4 (see chat message).

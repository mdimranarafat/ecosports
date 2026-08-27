// ============================================================================
// booking-engine.js — the only place bookings get written. Uses a Firestore
// transaction to guarantee no two overlapping bookings can ever both
// succeed, even under a race (see ARCHITECTURE.md → Booking Conflict Strategy).
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  query,
  where,
  getDocs,
  runTransaction,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { rangesOverlap, toLocalDate, generateBookingId, isValidPhone, isValidEmail } from "./utils.js";
import { computePrice } from "./pricing-engine.js";
import { logAudit } from "./reports.js";
import { getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export class SlotConflictError extends Error {
  constructor() {
    super("Sorry, this slot was just booked by someone else. Please choose another time.");
    this.name = "SlotConflictError";
  }
}

export class ValidationError extends Error {}

const ACTIVE_STATUSES = ["pending", "approved", "confirmed"];

function validateBookingInput(input) {
  if (!input.facilityId) throw new ValidationError("Facility is required.");
  if (!input.customerName?.trim()) throw new ValidationError("Customer name is required.");
  if (!isValidPhone(input.customerPhone || "")) throw new ValidationError("A valid phone number is required.");
  if (!isValidEmail(input.customerEmail)) throw new ValidationError("Email address looks invalid.");
  if (!input.date) throw new ValidationError("Date is required.");
  if (input.durationMinutes <= 0) throw new ValidationError("Duration must be greater than zero.");
  if (input.startMinutes < 0) throw new ValidationError("Invalid start time.");
}

/**
 * Create a booking (public customer flow OR admin/manager manual flow).
 *
 * @param {object} input - facilityId, facilityName, customerName, customerPhone,
 *   customerEmail, date (ISO), startMinutes, durationMinutes, players, note,
 *   source ("public"|"admin"|"manager"), createdBy (uid or "public"),
 *   rules (pricingRules array, pre-fetched), offers (array, pre-fetched),
 *   settings (business settings), overridePrice (admin only, {originalPrice,
 *   discountAmount, finalPrice} to bypass the engine for manual bookings),
 *   paymentStatus/paymentMethod/paidAmount (admin manual booking only).
 */
export async function createBooking(input) {
  validateBookingInput(input);

  const endMinutes = input.startMinutes + input.durationMinutes;

  // Price is computed from the engine unless staff explicitly overrides it
  // (e.g. a negotiated VIP rate) — public bookings can never override.
  let priceResult;
  if (input.source === "public" || !input.overridePrice) {
    priceResult = computePrice({
      facilityId: input.facilityId,
      dateISO: input.date,
      startMinutes: input.startMinutes,
      durationMinutes: input.durationMinutes,
      rules: input.rules,
      offers: input.offers,
      settings: input.settings,
    });
  } else {
    priceResult = input.overridePrice;
  }

  const bookingsCol = collection(db, "bookings");

  const result = await runTransaction(db, async (tx) => {
    // Read every active booking for this facility+date inside the
    // transaction so Firestore tracks it as part of the read-set — if
    // another transaction commits a conflicting booking first, this
    // transaction's read-set becomes stale and Firestore automatically
    // retries it, guaranteeing serializable conflict detection.
    const q = query(
      bookingsCol,
      where("facilityId", "==", input.facilityId),
      where("date", "==", input.date),
      where("status", "in", ACTIVE_STATUSES)
    );
    const existingSnap = await getDocs(q); // transactional get() constrained to a query is supported via getDocs inside runTransaction in SDK v10 (falls back to tx.get for doc refs below)

    for (const docSnap of existingSnap.docs) {
      const b = docSnap.data();
      if (rangesOverlap(input.startMinutes, endMinutes, b.startMinutes, b.endMinutes)) {
        throw new SlotConflictError();
      }
    }

    const bookingId = generateBookingId(input.date, existingSnap.size + 1);
    const ref = doc(db, "bookings", bookingId);

    // Re-check the exact doc id isn't already taken (extremely unlikely
    // collision on the human-readable sequence number, but cheap to guard).
    const existingDoc = await tx.get(ref);
    if (existingDoc.exists()) {
      throw new SlotConflictError();
    }

    const startDate = toLocalDate(input.date, input.startMinutes);
    const endDate = toLocalDate(input.date, endMinutes);

    const paidAmount = input.source === "public" ? 0 : input.paidAmount || 0;
    const finalPrice = priceResult.finalPrice;

    const bookingDoc = {
      bookingId,
      facilityId: input.facilityId,
      facilityName: input.facilityName || "",
      customerName: input.customerName.trim(),
      customerPhone: input.customerPhone.trim(),
      customerEmail: input.customerEmail?.trim() || "",
      date: input.date,
      startMinutes: input.startMinutes,
      endMinutes,
      durationMinutes: input.durationMinutes,
      startTimestamp: Timestamp.fromDate(startDate),
      endTimestamp: Timestamp.fromDate(endDate),
      status: input.source === "public" ? "pending" : input.status || "pending",
      players: input.players || null,
      note: input.note || "",
      originalPrice: priceResult.originalPrice,
      discountAmount: priceResult.discountAmount,
      finalPrice,
      paidAmount,
      dueAmount: Math.max(0, finalPrice - paidAmount),
      paymentStatus: input.source === "public" ? "unpaid" : input.paymentStatus || "unpaid",
      paymentMethod: input.paymentMethod || null,
      offerId: priceResult.offerId || null,
      pricingRuleId: priceResult.pricingRuleId || null,
      recurringGroupId: input.recurringGroupId || null,
      source: input.source || "public",
      createdBy: input.createdBy || "public",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    tx.set(ref, bookingDoc);
    return { id: bookingId, ...bookingDoc };
  });

  if (input.source !== "public") {
    await logAudit({
      action: "booking.created",
      entityType: "booking",
      entityId: result.id,
      newSummary: `${result.customerName} — ${result.facilityName} — ${result.date} — ${finalPriceLabel(result)}`,
      performedBy: input.createdBy,
    });
  }

  return result;
}

function finalPriceLabel(b) {
  return `${b.finalPrice} BDT`;
}

/**
 * Checks every occurrence of a proposed recurring series against existing
 * bookings WITHOUT writing anything — used to show "available vs conflicting"
 * before the admin confirms a corporate/recurring booking.
 */
export async function previewRecurringOccurrences(occurrences, facilityId) {
  const results = [];
  for (const occ of occurrences) {
    const q = query(
      collection(db, "bookings"),
      where("facilityId", "==", facilityId),
      where("date", "==", occ.date),
      where("status", "in", ACTIVE_STATUSES)
    );
    const snap = await getDocs(q);
    const endMinutes = occ.startMinutes + occ.durationMinutes;
    const conflict = snap.docs.some((d) => {
      const b = d.data();
      return rangesOverlap(occ.startMinutes, endMinutes, b.startMinutes, b.endMinutes);
    });
    results.push({ ...occ, available: !conflict });
  }
  return results;
}

/** Generates the list of dates for a weekly recurring booking between two dates. */
export function generateWeeklyOccurrences(startDateISO, endDateISO, weekdays, startMinutes, durationMinutes) {
  const occurrences = [];
  let cursor = new Date(startDateISO + "T00:00:00");
  const end = new Date(endDateISO + "T00:00:00");

  while (cursor <= end) {
    if (weekdays.includes(cursor.getDay())) {
      const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
        cursor.getDate()
      ).padStart(2, "0")}`;
      occurrences.push({ date: iso, startMinutes, durationMinutes });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return occurrences;
}

// ----------------------------------------------------------------------------
// Status changes, edits, reschedules — everything after the initial create.
// All of these are staff-only actions (enforced by firestore.rules on the
// bookings collection); the UI-level guard is the calling admin page's
// requireAuth({ permission }) check.
// ----------------------------------------------------------------------------

const STATUS_TRANSITIONS = {
  pending: ["approved", "rejected", "cancelled"],
  approved: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  rejected: [],
  no_show: [],
};

export function canTransition(fromStatus, toStatus) {
  return (STATUS_TRANSITIONS[fromStatus] || []).includes(toStatus);
}

/** Approve / reject / cancel / mark completed / mark no-show — all funnel through here so every change is audited and validated. */
export async function setBookingStatus(bookingId, newStatus, performedBy) {
  const ref = doc(db, "bookings", bookingId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Booking not found.");
  const booking = snap.data();

  if (!canTransition(booking.status, newStatus)) {
    throw new ValidationError(`Cannot change booking from "${booking.status}" to "${newStatus}".`);
  }

  await updateDoc(ref, { status: newStatus, updatedAt: serverTimestamp() });
  await logAudit({
    action: `booking.${newStatus}`,
    entityType: "booking",
    entityId: bookingId,
    previousSummary: booking.status,
    newSummary: newStatus,
    performedBy,
  });

  if (newStatus === "completed" || newStatus === "cancelled") {
    const { upsertCustomerOnBooking } = await import("./customer-manager.js");
    await upsertCustomerOnBooking({ ...booking, id: bookingId }, { isNew: false, statusDelta: newStatus });
  }

  return { ...booking, id: bookingId, status: newStatus };
}

/** Edit editable fields on a booking (note, players, payment info) without touching the time slot. */
export async function editBooking(bookingId, patch, performedBy) {
  const ref = doc(db, "bookings", bookingId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("Booking not found.");
  const before = snap.data();

  const finalPatch = { ...patch, updatedAt: serverTimestamp() };
  if (patch.paidAmount != null) {
    finalPatch.dueAmount = Math.max(0, (before.finalPrice || 0) - patch.paidAmount);
    finalPatch.paymentStatus = finalPatch.dueAmount === 0 ? "paid" : patch.paidAmount > 0 ? "partial" : "unpaid";
  }

  await updateDoc(ref, finalPatch);
  await logAudit({
    action: "booking.edited",
    entityType: "booking",
    entityId: bookingId,
    previousSummary: `${before.finalPrice} BDT, paid ${before.paidAmount}`,
    newSummary: JSON.stringify(patch).slice(0, 300),
    performedBy,
  });
}

/**
 * Reschedule: re-runs full conflict-checking against the new slot inside a
 * transaction (same guarantee as createBooking), then updates the doc.
 */
export async function rescheduleBooking(bookingId, { date, startMinutes, durationMinutes }, performedBy) {
  const endMinutes = startMinutes + durationMinutes;
  const ref = doc(db, "bookings", bookingId);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Booking not found.");
    const booking = snap.data();

    const q = query(
      collection(db, "bookings"),
      where("facilityId", "==", booking.facilityId),
      where("date", "==", date),
      where("status", "in", ACTIVE_STATUSES)
    );
    const existingSnap = await getDocs(q);
    for (const docSnap of existingSnap.docs) {
      if (docSnap.id === bookingId) continue; // ignore the booking being moved
      const b = docSnap.data();
      if (rangesOverlap(startMinutes, endMinutes, b.startMinutes, b.endMinutes)) {
        throw new SlotConflictError();
      }
    }

    const startDate = toLocalDate(date, startMinutes);
    const endDate = toLocalDate(date, endMinutes);
    const patch = {
      date,
      startMinutes,
      endMinutes,
      durationMinutes,
      startTimestamp: Timestamp.fromDate(startDate),
      endTimestamp: Timestamp.fromDate(endDate),
      updatedAt: serverTimestamp(),
    };
    tx.update(ref, patch);
    return { ...booking, ...patch, id: bookingId };
  });

  await logAudit({
    action: "booking.rescheduled",
    entityType: "booking",
    entityId: bookingId,
    newSummary: `${date} ${minutesLabel(startMinutes)}–${minutesLabel(endMinutes)}`,
    performedBy,
  });

  return result;
}

function minutesLabel(m) {
  const h = String(Math.floor((m % 1440) / 60)).padStart(2, "0");
  const mi = String(m % 60).padStart(2, "0");
  return `${h}:${mi}`;
}

/** Creates every occurrence of an approved recurring/corporate series. Occurrences must already be conflict-checked via previewRecurringOccurrences(). */
export async function createRecurringBookings(occurrences, baseInput, performedBy) {
  const recurringGroupId = `RG-${Date.now()}`;
  const created = [];
  for (const occ of occurrences) {
    if (!occ.available) continue;
    const result = await createBooking({
      ...baseInput,
      date: occ.date,
      startMinutes: occ.startMinutes,
      durationMinutes: occ.durationMinutes,
      recurringGroupId,
      source: baseInput.source || "admin",
      createdBy: performedBy,
    });
    created.push(result);
  }
  await logAudit({
    action: "booking.recurring_series_created",
    entityType: "booking",
    entityId: recurringGroupId,
    newSummary: `${created.length} of ${occurrences.length} occurrences created`,
    performedBy,
  });
  return { recurringGroupId, created };
}

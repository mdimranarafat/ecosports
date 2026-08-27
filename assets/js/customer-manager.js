// ============================================================================
// customer-manager.js — customer profiles derived from bookings. A customer
// document is keyed by normalized phone number so repeat bookers (public or
// admin-entered) automatically roll up into one profile with no duplicate
// data entry required.
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit as fbLimit,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizePhone } from "./utils.js";

const CUSTOMERS_COL = "customers";

export function customerIdFromPhone(phone) {
  return normalizePhone(phone);
}

/**
 * Upserts a customer profile. Called by booking-engine.js after a booking
 * is created/completed/cancelled so totals stay in sync without a
 * scheduled job. Uses Firestore `increment()` so concurrent bookings from
 * the same customer never lose an update (no read-modify-write race).
 */
export async function upsertCustomerOnBooking(booking, { isNew = true, statusDelta = null } = {}) {
  const customerId = customerIdFromPhone(booking.customerPhone);
  const ref = doc(db, CUSTOMERS_COL, customerId);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      customerId,
      name: booking.customerName,
      phone: booking.customerPhone,
      email: booking.customerEmail || "",
      totalBookings: 1,
      completedBookings: 0,
      cancelledBookings: 0,
      totalSpending: booking.paidAmount || 0,
      outstandingDue: booking.dueAmount || 0,
      firstBookingAt: serverTimestamp(),
      lastBookingAt: serverTimestamp(),
      notes: "",
    });
    return;
  }

  const patch = {
    name: booking.customerName, // keep most recent name/email on file
    email: booking.customerEmail || snap.data().email || "",
    lastBookingAt: serverTimestamp(),
  };
  if (isNew) patch.totalBookings = increment(1);
  if (statusDelta === "completed") patch.completedBookings = increment(1);
  if (statusDelta === "cancelled") patch.cancelledBookings = increment(1);
  if (booking.paidAmount) patch.totalSpending = increment(booking.paidAmount);

  await updateDoc(ref, patch);
}

export async function getCustomer(customerId) {
  const snap = await getDoc(doc(db, CUSTOMERS_COL, customerId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function searchCustomers(term, max = 25) {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  // Firestore has no native "contains" text search; for a facility-scale
  // customer base a client-side filter over a bounded recent list is fast
  // and avoids a paid search add-on. See README "Scaling customer search"
  // for the Algolia/Typesense upgrade path if the list grows very large.
  const snap = await getDocs(query(collection(db, CUSTOMERS_COL), orderBy("lastBookingAt", "desc"), fbLimit(500)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter(
      (c) =>
        c.name?.toLowerCase().includes(t) ||
        c.phone?.toLowerCase().includes(t) ||
        c.email?.toLowerCase().includes(t)
    )
    .slice(0, max);
}

export async function listRecentCustomers(max = 50) {
  const snap = await getDocs(query(collection(db, CUSTOMERS_COL), orderBy("lastBookingAt", "desc"), fbLimit(max)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function updateCustomerNotes(customerId, notes) {
  await updateDoc(doc(db, CUSTOMERS_COL, customerId), { notes });
}

/** Bookings belonging to one customer, most recent first — powers the profile history view. */
export async function getCustomerBookingHistory(phone, max = 100) {
  const snap = await getDocs(
    query(collection(db, "bookings"), where("customerPhone", "==", phone), orderBy("createdAt", "desc"), fbLimit(max))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

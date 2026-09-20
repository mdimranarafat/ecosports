// ============================================================================
// availability.js — reads existing bookings for a facility+date and
// computes free/blocked slots. Read-only; actual conflict-safe writes
// happen inside booking-engine.js's transaction.
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { rangesOverlap, timeStrToMinutes, minutesToAmPm, todayISO } from "./utils.js?v=abd8c48";

const ACTIVE_STATUSES = ["pending", "approved", "confirmed"];
const getDocsWithTimeout = (q) => Promise.race([
  getDocs(q),
  new Promise((_, reject) => setTimeout(() => reject(new Error("availability query timeout")), 4000)),
]);

/** Fetch all non-cancelled bookings for a single facility+date. Cheap, indexed query. */
export async function getBookingsForFacilityDate(facilityId, dateISO) {
  const q = query(
    collection(db, "bookingSlots"),
    where("facilityId", "==", facilityId),
    where("date", "==", dateISO),
    where("status", "==", "active")
  );
  try {
    const snap = await getDocsWithTimeout(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch {
    throw new Error("Availability is temporarily unavailable. Please try again.");
  }
}

/** Is [startMinutes, startMinutes+durationMinutes) free for this facility/date? */
export async function isSlotAvailable(facilityId, dateISO, startMinutes, durationMinutes) {
  const existing = await getBookingsForFacilityDate(facilityId, dateISO);
  const endMinutes = startMinutes + durationMinutes;
  return !existing.some((b) => rangesOverlap(startMinutes, endMinutes, b.startMinutes, b.endMinutes));
}

/**
 * Build a list of bookable start-time slots for a facility on a date, each
 * flagged available/unavailable, respecting the facility's opening/closing
 * time, slot interval, and min/max duration — for the "quick booking" UI.
 */
export async function buildSlotGrid(facility, dateISO, durationMinutes) {
  if (dateISO < todayISO()) return [];
  const existing = await getBookingsForFacilityDate(facility.id, dateISO);
  const open = timeStrToMinutes(facility.openingTime);
  let close = timeStrToMinutes(facility.closingTime);
  if (facility.allowOvernight && close <= open) close += 1440; // crosses midnight

  // Eco Sports booking times are always half-hour slots: 5:00, 5:30, 6:00…
  // Ignore legacy facility documents that still contain 10/15-minute values.
  const interval = 30;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const isToday = dateISO === todayISO();
  const slots = [];

  for (let start = open; start + durationMinutes <= close; start += interval) {
    if (isToday && start < currentMinutes) continue;
    const end = start + durationMinutes;
    const booked = existing.find((b) => rangesOverlap(start, end, b.startMinutes, b.endMinutes));
    slots.push({
      startMinutes: start,
      endMinutes: end,
      label: minutesToAmPm(start),
      available: !booked,
      bookedBy: booked?.customerName || "",
    });
  }

  return slots;
}

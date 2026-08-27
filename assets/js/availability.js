// ============================================================================
// availability.js — reads existing bookings for a facility+date and
// computes free/blocked slots. Read-only; actual conflict-safe writes
// happen inside booking-engine.js's transaction.
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { rangesOverlap, timeStrToMinutes, minutesToTimeStr } from "./utils.js";

const ACTIVE_STATUSES = ["pending", "approved", "confirmed"];

/** Fetch all non-cancelled bookings for a single facility+date. Cheap, indexed query. */
export async function getBookingsForFacilityDate(facilityId, dateISO) {
  const q = query(
    collection(db, "bookings"),
    where("facilityId", "==", facilityId),
    where("date", "==", dateISO),
    where("status", "in", ACTIVE_STATUSES)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
  const existing = await getBookingsForFacilityDate(facility.id, dateISO);
  const open = timeStrToMinutes(facility.openingTime);
  let close = timeStrToMinutes(facility.closingTime);
  if (facility.allowOvernight && close <= open) close += 1440; // crosses midnight

  const interval = facility.slotIntervalMinutes || 30;
  const slots = [];

  for (let start = open; start + durationMinutes <= close; start += interval) {
    const end = start + durationMinutes;
    const conflict = existing.some((b) => rangesOverlap(start, end, b.startMinutes, b.endMinutes));
    slots.push({
      startMinutes: start,
      endMinutes: end,
      label: minutesToTimeStr(start),
      available: !conflict,
    });
  }

  return slots;
}

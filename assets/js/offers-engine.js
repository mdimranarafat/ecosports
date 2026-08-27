// ============================================================================
// offers-engine.js — CRUD + stats helpers for offers/promotions.
// The actual "which offer applies & how much discount" logic lives in
// pricing-engine.js (computeOfferDiscount / applyBestOffer) so there is a
// single source of truth used by both the booking flow and this admin UI.
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./reports.js";
import { getCurrentProfile } from "./auth.js";

const OFFERS_COL = "offers";

export async function listOffers({ activeOnly = false } = {}) {
  const col = collection(db, OFFERS_COL);
  const q = activeOnly ? query(col, where("active", "==", true)) : query(col, orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function createOffer(offer) {
  const payload = {
    name: offer.name,
    code: (offer.code || "").toUpperCase().trim(),
    type: offer.type, // percentage | fixed | special_price | buyx
    value: Number(offer.value) || 0,
    thresholdMinutes: offer.thresholdMinutes ?? null,
    facilityId: offer.facilityId || null, // null = applies to all facilities
    days: Array.isArray(offer.days) ? offer.days : [0, 1, 2, 3, 4, 5, 6],
    startTime: offer.startTime ?? null, // minutes since midnight, null = no time restriction
    endTime: offer.endTime ?? null,
    startDate: offer.startDate || null, // "YYYY-MM-DD"
    endDate: offer.endDate || null,
    usageLimit: offer.usageLimit ? Number(offer.usageLimit) : null,
    usageCount: 0,
    active: offer.active !== false,
    revenueGenerated: 0,
    discountGiven: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, OFFERS_COL), payload);
  await logAudit({ action: "offer.created", entityType: "offer", entityId: ref.id, newSummary: `${payload.name} (${payload.type})`, performedBy: getCurrentProfile()?.uid });
  return ref.id;
}

export async function updateOffer(offerId, patch) {
  await updateDoc(doc(db, OFFERS_COL, offerId), { ...patch, updatedAt: serverTimestamp() });
  await logAudit({ action: "offer.updated", entityType: "offer", entityId: offerId, newSummary: JSON.stringify(patch).slice(0, 300) });
}

export async function setOfferActive(offerId, active) {
  await updateOffer(offerId, { active });
  await logAudit({ action: active ? "offer.activated" : "offer.deactivated", entityType: "offer", entityId: offerId });
}

export async function deleteOffer(offerId) {
  await deleteDoc(doc(db, OFFERS_COL, offerId));
  await logAudit({ action: "offer.deleted", entityType: "offer", entityId: offerId });
}

/** Called by booking-engine.js right after a booking is confirmed with an offer applied. */
export async function recordOfferUsage(offerId, { discountAmount, finalPrice }) {
  if (!offerId) return;
  await updateDoc(doc(db, OFFERS_COL, offerId), {
    usageCount: increment(1),
    discountGiven: increment(discountAmount || 0),
    revenueGenerated: increment(finalPrice || 0),
  });
}

export function offerSummaryStats(offers) {
  return offers.reduce(
    (acc, o) => ({
      totalUsage: acc.totalUsage + (o.usageCount || 0),
      totalDiscountGiven: acc.totalDiscountGiven + (o.discountGiven || 0),
      totalRevenueGenerated: acc.totalRevenueGenerated + (o.revenueGenerated || 0),
    }),
    { totalUsage: 0, totalDiscountGiven: 0, totalRevenueGenerated: 0 }
  );
}

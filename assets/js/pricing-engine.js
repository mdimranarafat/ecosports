// ============================================================================
// pricing-engine.js — computes price for a proposed booking using
// admin-configured pricingRules + settings. Zero hardcoded prices.
// Pure functions: same inputs always produce the same output, no I/O here.
// (Data fetching lives in facility-manager.js / booking-engine.js.)
// ============================================================================

import { getDayOfWeek, rangeContains, round } from "./utils.js";
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
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./reports.js";

const RULES_COL = "pricingRules";

// ---------------------------------------------------------------------------
// Firestore CRUD — used by admin/pricing.html and by booking.html/booking-
// engine.js to fetch the rule set before calling computePrice() below.
// ---------------------------------------------------------------------------

/** All rules for one facility (admin editing view). */
export async function listPricingRules(facilityId = null) {
  const col = collection(db, RULES_COL);
  const q = facilityId ? query(col, where("facilityId", "==", facilityId)) : query(col, orderBy("priority", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Every ACTIVE rule across all facilities — what the booking engine needs. */
export async function listActivePricingRules() {
  const snap = await getDocs(query(collection(db, RULES_COL), where("active", "==", true)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function createPricingRule(rule) {
  const payload = {
    facilityId: rule.facilityId,
    days: rule.days, // [0-6]
    startMinutes: rule.startMinutes,
    endMinutes: rule.endMinutes,
    pricePerHour: rule.pricePerHour ?? null,
    durationPrices: rule.durationPrices || {},
    weekendAdjustPercent: rule.weekendAdjustPercent ?? null,
    priority: rule.priority ?? 1,
    active: rule.active !== false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, RULES_COL), payload);
  await logAudit({ action: "pricing.rule_created", entityType: "pricingRule", entityId: ref.id, newSummary: `Facility ${payload.facilityId}, priority ${payload.priority}` });
  return ref.id;
}

export async function updatePricingRule(ruleId, patch) {
  await updateDoc(doc(db, RULES_COL, ruleId), { ...patch, updatedAt: serverTimestamp() });
  await logAudit({ action: "pricing.rule_updated", entityType: "pricingRule", entityId: ruleId, newSummary: JSON.stringify(patch).slice(0, 300) });
}

export async function setPricingRuleActive(ruleId, active) {
  await updatePricingRule(ruleId, { active });
}

export async function deletePricingRule(ruleId) {
  await deleteDoc(doc(db, RULES_COL, ruleId));
  await logAudit({ action: "pricing.rule_deleted", entityType: "pricingRule", entityId: ruleId });
}

export class NoPricingRuleError extends Error {
  constructor(facilityId, dateISO, startMinutes, durationMinutes) {
    super(
      `No active pricing rule covers facility=${facilityId} on ${dateISO} ${startMinutes}-${
        startMinutes + durationMinutes
      } min. An admin must configure pricing for this facility/time before it can be booked.`
    );
    this.name = "NoPricingRuleError";
  }
}

/**
 * Pick the winning pricing rule for a proposed slot.
 * Rule must FULLY CONTAIN the requested [start,end) window.
 * Winner = highest priority; ties broken by narrowest time window (most specific).
 */
export function findMatchingRule(rules, facilityId, dateISO, startMinutes, durationMinutes) {
  const dayOfWeek = getDayOfWeek(dateISO);
  const endMinutes = startMinutes + durationMinutes;

  const candidates = rules.filter(
    (r) =>
      r.active !== false &&
      r.facilityId === facilityId &&
      Array.isArray(r.days) &&
      r.days.includes(dayOfWeek) &&
      rangeContains(r.startMinutes, r.endMinutes, startMinutes, endMinutes)
  );

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const pri = (b.priority ?? 1) - (a.priority ?? 1);
    if (pri !== 0) return pri;
    const widthA = a.endMinutes - a.startMinutes;
    const widthB = b.endMinutes - b.startMinutes;
    return widthA - widthB; // narrower window wins on tie
  });

  return candidates[0];
}

/** Base price before offers, from the matched rule. */
export function computeBasePrice(rule, durationMinutes, dayOfWeek, weekendDays = [5, 6]) {
  let base;
  const exact = rule.durationPrices?.[String(durationMinutes)] ?? rule.durationPrices?.[durationMinutes];

  if (exact != null) {
    base = exact;
  } else if (rule.pricePerHour != null) {
    base = rule.pricePerHour * (durationMinutes / 60);
  } else {
    throw new Error(`Pricing rule ${rule.id || "(unsaved)"} has neither durationPrices nor pricePerHour.`);
  }

  if (rule.weekendAdjustPercent && weekendDays.includes(dayOfWeek)) {
    base = base * (1 + rule.weekendAdjustPercent / 100);
  }

  return base;
}

/**
 * Full price computation pipeline. `offers` optional — pass [] to skip.
 * Returns { originalPrice, discountAmount, finalPrice, pricingRuleId, offerId }.
 */
export function computePrice({
  facilityId,
  dateISO,
  startMinutes,
  durationMinutes,
  rules,
  offers = [],
  settings = { roundingMode: "nearest10", roundingIncrement: 10, weekendDays: [5, 6] },
}) {
  const rule = findMatchingRule(rules, facilityId, dateISO, startMinutes, durationMinutes);
  if (!rule) {
    throw new NoPricingRuleError(facilityId, dateISO, startMinutes, durationMinutes);
  }

  const dayOfWeek = getDayOfWeek(dateISO);
  const originalPrice = computeBasePrice(rule, durationMinutes, dayOfWeek, settings.weekendDays);

  const { discountAmount, offer } = applyBestOffer({
    facilityId,
    dateISO,
    startMinutes,
    durationMinutes,
    dayOfWeek,
    basePrice: originalPrice,
    offers,
  });

  const rounded = round(
    Math.max(0, originalPrice - discountAmount),
    settings.roundingMode,
    settings.roundingIncrement
  );

  return {
    originalPrice: round(originalPrice, "none"),
    discountAmount: round(discountAmount, "none"),
    finalPrice: rounded,
    pricingRuleId: rule.id ?? null,
    offerId: offer?.id ?? null,
  };
}

/** Finds the single best-value active offer applicable to this slot and returns its discount. */
export function applyBestOffer({ facilityId, dateISO, startMinutes, durationMinutes, dayOfWeek, basePrice, offers }) {
  const endMinutes = startMinutes + durationMinutes;
  const today = dateISO;

  const applicable = offers.filter((o) => {
    if (o.active === false) return false;
    if (o.startDate && today < o.startDate) return false;
    if (o.endDate && today > o.endDate) return false;
    if (o.facilityId && o.facilityId !== facilityId) return false;
    if (Array.isArray(o.days) && o.days.length && !o.days.includes(dayOfWeek)) return false;
    if (o.startTime != null && o.endTime != null) {
      // offer window must contain the booking window
      if (!(o.startTime <= startMinutes && endMinutes <= o.endTime)) return false;
    }
    if (o.usageLimit != null && (o.usageCount ?? 0) >= o.usageLimit) return false;
    return true;
  });

  if (applicable.length === 0) return { discountAmount: 0, offer: null };

  const scored = applicable.map((o) => ({
    offer: o,
    discount: computeOfferDiscount(o, basePrice),
  }));

  scored.sort((a, b) => b.discount - a.discount); // best value to the customer wins
  return { discountAmount: scored[0].discount, offer: scored[0].offer };
}

export function computeOfferDiscount(offer, basePrice) {
  switch (offer.type) {
    case "percentage":
      return basePrice * (offer.value / 100);
    case "fixed":
      return Math.min(offer.value, basePrice);
    case "special_price":
      return Math.max(0, basePrice - offer.value);
    case "buyx":
      // value = discount amount granted once duration threshold (offer.thresholdMinutes) is met
      return offer.thresholdMinutes && basePrice > 0 ? offer.value : 0;
    default:
      return 0;
  }
}

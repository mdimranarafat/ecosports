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

// Frenzy Arena pricing imported into the EcoSports schema. Prices are in BDT.
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [0, 1, 2, 3];
const SURCHARGE_DAYS = [4, 5, 6];
const durations = (values) => ({ "60": values[0], "90": values[1], "120": values[2], "150": values[3], "180": values[4] });
export const DEFAULT_PRICING_RULES = [
  { id: "sixASideTurf-day", facilityId: "sixASideTurf", days: WEEKDAYS, startMinutes: 300, endMinutes: 1020, durationPrices: durations([750, 1150, 1550, 1950, 2350]), priority: 10, active: true },
  { id: "sixASideTurf-night", facilityId: "sixASideTurf", days: WEEKDAYS, startMinutes: 1020, endMinutes: 1440, durationPrices: durations([1450, 2200, 2950, 3700, 4450]), priority: 10, active: true },
  { id: "sixASideTurf-midnight", facilityId: "sixASideTurf", days: WEEKDAYS, startMinutes: 0, endMinutes: 300, durationPrices: durations([1200, 1400, 1600, 1800, 2000]), priority: 10, active: true },
  { id: "sixASideTurf-surcharge-day", facilityId: "sixASideTurf", days: SURCHARGE_DAYS, startMinutes: 300, endMinutes: 1020, durationPrices: durations([900, 1400, 1900, 2400, 2900]), priority: 10, active: true },
  { id: "sixASideTurf-surcharge-night", facilityId: "sixASideTurf", days: SURCHARGE_DAYS, startMinutes: 1020, endMinutes: 1440, durationPrices: durations([1800, 2700, 3600, 4600, 5500]), priority: 10, active: true },
  { id: "sixASideTurf-surcharge-midnight", facilityId: "sixASideTurf", days: SURCHARGE_DAYS, startMinutes: 0, endMinutes: 300, durationPrices: durations([1500, 1700, 2000, 2200, 2500]), priority: 10, active: true },
  { id: "fourASideTurf-day", facilityId: "fourASideTurf", days: WEEKDAYS, startMinutes: 300, endMinutes: 1020, durationPrices: durations([500, 750, 1000, 1250, 1500]), priority: 10, active: true },
  { id: "fourASideTurf-night", facilityId: "fourASideTurf", days: WEEKDAYS, startMinutes: 1020, endMinutes: 1440, durationPrices: durations([1000, 1200, 1400, 1600, 1800]), priority: 10, active: true },
  { id: "fourASideTurf-midnight", facilityId: "fourASideTurf", days: WEEKDAYS, startMinutes: 0, endMinutes: 300, durationPrices: durations([900, 1200, 1500, 1800, 2100]), priority: 10, active: true },
  { id: "fourASideTurf-surcharge-day", facilityId: "fourASideTurf", days: SURCHARGE_DAYS, startMinutes: 300, endMinutes: 1020, durationPrices: durations([600, 900, 1200, 1500, 1800]), priority: 10, active: true },
  { id: "fourASideTurf-surcharge-night", facilityId: "fourASideTurf", days: SURCHARGE_DAYS, startMinutes: 1020, endMinutes: 1440, durationPrices: durations([1200, 1500, 1700, 2000, 2200]), priority: 10, active: true },
  { id: "fourASideTurf-surcharge-midnight", facilityId: "fourASideTurf", days: SURCHARGE_DAYS, startMinutes: 0, endMinutes: 300, durationPrices: durations([1100, 1500, 1800, 2200, 2600]), priority: 10, active: true },
  { id: "swimmingPool-hourly", facilityId: "swimmingPool", days: ALL_DAYS, startMinutes: 0, endMinutes: 1440, pricePerHour: 200, priority: 1, active: true },
  { id: "carrom-hourly", facilityId: "carrom", days: ALL_DAYS, startMinutes: 0, endMinutes: 1440, pricePerHour: 150, priority: 1, active: true },
];

// ---------------------------------------------------------------------------
// Firestore CRUD — used by admin/pricing.html and by booking.html/booking-
// engine.js to fetch the rule set before calling computePrice() below.
// ---------------------------------------------------------------------------

/** All rules for one facility (admin editing view). */
export async function listPricingRules(facilityId = null) {
  const col = collection(db, RULES_COL);
  const q = facilityId ? query(col, where("facilityId", "==", facilityId)) : query(col, orderBy("priority", "desc"));
  try {
    const snap = await getDocs(q);
    const rows = snap.empty ? DEFAULT_PRICING_RULES : snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return facilityId ? rows.filter((r) => r.facilityId === facilityId) : rows;
  } catch {
    return facilityId ? DEFAULT_PRICING_RULES.filter((r) => r.facilityId === facilityId) : DEFAULT_PRICING_RULES;
  }
}

/** Every ACTIVE rule across all facilities — what the booking engine needs. */
export async function listActivePricingRules() {
  try {
    const snap = await getDocs(query(collection(db, RULES_COL), where("active", "==", true)));
    return snap.empty ? DEFAULT_PRICING_RULES : snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch {
    return DEFAULT_PRICING_RULES;
  }
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

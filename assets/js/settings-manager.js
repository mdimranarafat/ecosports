// ============================================================================
// settings-manager.js — the single `settings/business` singleton document.
// Read by the public booking flow (rounding, currency, lead time) and
// written only by admin/settings.html (settings.manage permission).
// ============================================================================

import { db, DEFAULT_SETTINGS } from "./firebase-config.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./reports.js";

const SETTINGS_DOC = ["settings", "business"];

let cached = null;

/** Cached after first successful read for the lifetime of the page — settings rarely change mid-session. */
export async function getBusinessSettings() {
  if (cached) return cached;
  const snap = await getDoc(doc(db, ...SETTINGS_DOC));
  cached = snap.exists()
    ? { ...defaultFullSettings(), ...snap.data() }
    : defaultFullSettings();
  return cached;
}

function defaultFullSettings() {
  return {
    ...DEFAULT_SETTINGS,
    phone: "",
    email: "",
    address: "Chattogram, Bangladesh",
    roundingMode: "nearest10",
    roundingIncrement: 10,
    weekendDays: [5, 6], // Fri/Sat weekend in Bangladesh
    cancellationPolicy: "Cancellations must be made at least 2 hours before the booking start time.",
  };
}

export async function updateBusinessSettings(patch) {
  await setDoc(doc(db, ...SETTINGS_DOC), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
  cached = null; // force re-read next call
  await logAudit({ action: "settings.updated", entityType: "settings", entityId: "business", newSummary: JSON.stringify(patch).slice(0, 300) });
}

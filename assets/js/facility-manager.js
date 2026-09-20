// ============================================================================
// facility-manager.js — all reads/writes for the facilities collection.
// Public pages only ever call getActiveFacilities(); admin pages use the
// full CRUD set (create/update/deactivate).
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./reports.js";

const COL = "facilities";
const getDocsWithTimeout = (q) => Promise.race([
  getDocs(q),
  new Promise((_, reject) => setTimeout(() => reject(new Error("facilities query timeout")), 4000)),
]);

// Frenzy Arena catalog imported as the initial EcoSports catalog. Firestore
// documents override this fallback as soon as the admin creates/edits facilities.
export const DEFAULT_FACILITIES = [
  { id: "sixASideTurf", name: "6A Side Turf", slug: "six-a-side-turf", description: "Artificial futsal turf for five-a-side matches and practice sessions.", imageUrl: "", icon: "⚽", active: true, displayOrder: 1, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
  { id: "fourASideTurf", name: "4A Side Turf", slug: "four-a-side-turf", description: "Compact artificial turf for quick games, training, and small-sided matches.", imageUrl: "", icon: "⚽", active: true, displayOrder: 2, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
  { id: "swimmingPool", name: "Swimming Pool", slug: "swimming-pool", description: "A dedicated swimming pool for training, practice, and recreational sessions.", imageUrl: "", icon: "🏊", active: true, displayOrder: 3, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
  { id: "carrom", name: "Carrom", slug: "carrom", description: "Indoor carrom boards for a relaxed game between matches.", imageUrl: "", icon: "🎯", active: true, displayOrder: 4, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
];

function facilityKind(value = "") {
  const text = `${value}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (text.includes("swim") || text.includes("pool")) return "swimmingPool";
  if (text.includes("carrom") || text.includes("carom")) return "carrom";
  if (text.includes("four") || text.includes("4a") || text.includes("4side")) return "fourASideTurf";
  if (text.includes("six") || text.includes("6a") || text.includes("6side")) return "sixASideTurf";
  return null;
}

function canonicalizeFacilities(docs) {
  return DEFAULT_FACILITIES.map((fallback) => {
    const match = docs.find((f) => f.id === fallback.id || facilityKind(f.id) === fallback.id || facilityKind(f.slug) === fallback.id || facilityKind(f.name) === fallback.id);
    // Keep the canonical ID even when Firestore contains a legacy document ID.
    // Pricing rules, booking slots, and bookings all use this stable ID.
    return match ? { ...fallback, ...match, id: fallback.id, name: fallback.name, slug: fallback.slug, icon: fallback.icon, displayOrder: fallback.displayOrder, slotIntervalMinutes: 30 } : fallback;
  });
}

/** Public-facing: only active facilities, in admin-configured display order. */
export async function getActiveFacilities() {
  const q = query(collection(db, COL), where("active", "==", true), orderBy("displayOrder", "asc"));
  try {
    const snap = await getDocsWithTimeout(q);
    return snap.empty ? DEFAULT_FACILITIES : canonicalizeFacilities(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch {
    return DEFAULT_FACILITIES;
  }
}

/** Admin-facing: every facility regardless of active state. */
export async function getAllFacilities() {
  const q = query(collection(db, COL), orderBy("displayOrder", "asc"));
  try {
    const snap = await getDocsWithTimeout(q);
    return snap.empty ? DEFAULT_FACILITIES : canonicalizeFacilities(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch {
    return DEFAULT_FACILITIES;
  }
}

export async function getFacility(facilityId) {
  const snap = await getDoc(doc(db, COL, facilityId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createFacility(data, performedBy) {
  const ref = await addDoc(collection(db, COL), {
    name: data.name,
    slug: data.slug,
    description: data.description || "",
    imageUrl: data.imageUrl || "",
    icon: data.icon || "",
    active: data.active ?? true,
    displayOrder: data.displayOrder ?? 999,
    openingTime: data.openingTime || "05:00",
    closingTime: data.closingTime || "23:59",
    slotIntervalMinutes: data.slotIntervalMinutes || 30,
    minDurationMinutes: data.minDurationMinutes || 60,
    maxDurationMinutes: data.maxDurationMinutes || 180,
    allowOvernight: data.allowOvernight || false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await logAudit({ action: "facility.created", entityType: "facility", entityId: ref.id, newSummary: data.name, performedBy });
  return ref.id;
}

export async function updateFacility(facilityId, patch, performedBy) {
  await updateDoc(doc(db, COL, facilityId), { ...patch, updatedAt: serverTimestamp() });
  await logAudit({
    action: "facility.updated",
    entityType: "facility",
    entityId: facilityId,
    newSummary: JSON.stringify(patch),
    performedBy,
  });
}

export async function setFacilityActive(facilityId, active, performedBy) {
  await updateFacility(facilityId, { active }, performedBy);
  await logAudit({
    action: active ? "facility.activated" : "facility.deactivated",
    entityType: "facility",
    entityId: facilityId,
    performedBy,
  });
}

export async function deleteFacility(facilityId, performedBy) {
  await deleteDoc(doc(db, COL, facilityId));
  await logAudit({ action: "facility.deleted", entityType: "facility", entityId: facilityId, performedBy });
}

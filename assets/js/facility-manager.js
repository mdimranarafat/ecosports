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

// Frenzy Arena catalog imported as the initial EcoSports catalog. Firestore
// documents override this fallback as soon as the admin creates/edits facilities.
export const DEFAULT_FACILITIES = [
  { id: "sixASideTurf", name: "6A Side Turf", slug: "six-a-side-turf", description: "Artificial futsal turf for five-a-side matches and practice sessions.", imageUrl: "", icon: "⚽", active: true, displayOrder: 1, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
  { id: "fourASideTurf", name: "4A Side Turf", slug: "four-a-side-turf", description: "Compact artificial turf for quick games, training, and small-sided matches.", imageUrl: "", icon: "⚽", active: true, displayOrder: 2, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
  { id: "swimmingPool", name: "Swimming Pool", slug: "swimming-pool", description: "A dedicated swimming pool for training, practice, and recreational sessions.", imageUrl: "", icon: "🏊", active: true, displayOrder: 3, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
  { id: "carrom", name: "Carrom", slug: "carrom", description: "Indoor carrom boards for a relaxed game between matches.", imageUrl: "", icon: "🎯", active: true, displayOrder: 4, openingTime: "00:00", closingTime: "23:59", slotIntervalMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 180, allowOvernight: false },
];

/** Public-facing: only active facilities, in admin-configured display order. */
export async function getActiveFacilities() {
  const q = query(collection(db, COL), where("active", "==", true), orderBy("displayOrder", "asc"));
  const snap = await getDocs(q);
  return snap.empty ? DEFAULT_FACILITIES : snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Admin-facing: every facility regardless of active state. */
export async function getAllFacilities() {
  const q = query(collection(db, COL), orderBy("displayOrder", "asc"));
  const snap = await getDocs(q);
  return snap.empty ? DEFAULT_FACILITIES : snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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

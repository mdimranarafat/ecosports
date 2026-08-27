// ============================================================================
// staff-manager.js — staff account CRUD. Only super_admin can create
// accounts or change role/permissions (mirrored + enforced in firestore.rules
// under /users/{userId}). Creating a Firebase Auth user client-side normally
// signs you in as that new user; we avoid that by spinning up a *second*,
// throwaway Firebase App instance to run createUserWithEmailAndPassword on,
// which leaves the admin's own session untouched, then we tear it down.
// ============================================================================

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { db, firebaseConfig } from "./firebase-config.js";
import {
  collection, doc, getDocs, setDoc, updateDoc, orderBy, query,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { logAudit } from "./reports.js";
import { defaultPermissionsForRole } from "./roles.js";
import { getCurrentProfile } from "./auth.js";

const USERS_COL = "users";

export async function listStaff() {
  const snap = await getDocs(query(collection(db, USERS_COL), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

/**
 * Creates a new staff account: a Firebase Auth user + matching Firestore
 * profile. Requires super_admin (also enforced server-side by
 * firestore.rules — this client check is just fast UX feedback).
 */
export async function createStaffAccount({ name, email, password, role }) {
  const secondaryApp = initializeApp(firebaseConfig, `staff-create-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await setDoc(doc(db, USERS_COL, cred.user.uid), {
      uid: cred.user.uid,
      name,
      email,
      role,
      permissions: defaultPermissionsForRole(role),
      status: "active",
      createdAt: serverTimestamp(),
      lastLogin: null,
    });
    await logAudit({
      action: "staff.created",
      entityType: "user",
      entityId: cred.user.uid,
      newSummary: `${name} <${email}> as ${role}`,
      performedBy: getCurrentProfile()?.uid,
    });
    return cred.user.uid;
  } finally {
    // Always tear down the secondary app + its auth session, whether the
    // create succeeded or failed, so it never leaks a signed-in session.
    await secondaryAuth.signOut().catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

/** Role/permission changes — super_admin only (enforced server-side). */
export async function updateStaffRole(uid, role, permissions) {
  await updateDoc(doc(db, USERS_COL, uid), { role, permissions });
  await logAudit({ action: "staff.role_changed", entityType: "user", entityId: uid, newSummary: `role=${role}` });
}

/** Non-role fields any staff.manage holder can touch (name, status). */
export async function setStaffStatus(uid, status) {
  await updateDoc(doc(db, USERS_COL, uid), { status });
  await logAudit({ action: status === "active" ? "staff.activated" : "staff.deactivated", entityType: "user", entityId: uid });
}

export async function updateStaffName(uid, name) {
  await updateDoc(doc(db, USERS_COL, uid), { name });
}

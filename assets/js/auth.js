// ============================================================================
// auth.js — thin wrapper around Firebase Auth + the current user's Firestore
// profile (role + permissions). Every admin/manager page imports this.
// ============================================================================

import { auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "./firebase-config.js";
import { doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let currentUser = null;       // Firebase Auth user object
let currentProfile = null;    // Firestore /users/{uid} document data
let authResolved = false;     // Firebase has completed its first auth check

const listeners = [];

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentProfile = null;

  if (user) {
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        currentProfile = { uid: user.uid, ...snap.data() };
      }
    } catch {
      // A missing/inaccessible profile must not grant access. The guard below
      // will route the user to login instead of leaving the page half-loaded.
    }
  }

  authResolved = true;
  listeners.forEach((cb) => cb(currentUser, currentProfile));
});

/** Subscribe to auth+profile changes. Returns an unsubscribe function. */
export function onAuthReady(callback) {
  listeners.push(callback);
  // Do not treat the initial null value as a resolved unauthenticated state.
  // Firebase may still be restoring a valid persisted staff session.
  if (authResolved) callback(currentUser, currentProfile);
  return () => {
    const i = listeners.indexOf(callback);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getCurrentUser() {
  return currentUser;
}

export function getCurrentProfile() {
  return currentProfile;
}

export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  // Best-effort — a staff member's own lastLogin write is allowed by
  // firestore.rules (name/status-only fields, no role/permissions touched),
  // but never blocks sign-in if it fails for any reason.
  updateDoc(doc(db, "users", cred.user.uid), { lastLogin: serverTimestamp() }).catch(() => {});
  return cred.user;
}

export async function logout() {
  await signOut(auth);
}

/**
 * Guard for admin/manager pages: redirects to /login.html if not signed in
 * or the account is disabled, and enforces a minimum permission if given.
 */
export function requireAuth({ redirectTo = new URL("../login.html", document.baseURI).href, permission = null } = {}) {
  return new Promise((resolve) => {
    onAuthReady((user, profile) => {
      if (!user || !profile || profile.status !== "active") {
        window.location.href = redirectTo;
        return;
      }
      if (permission && !hasPermission(profile, permission)) {
        window.location.href = new URL("../admin/index.html?error=forbidden", document.baseURI).href;
        return;
      }
      resolve({ user, profile });
    });
  });
}

/** Central permission check — mirrors firestore.rules `hasPerm()`. */
export function hasPermission(profile, key) {
  if (!profile) return false;
  if (profile.role === "super_admin") return true;
  return profile.permissions?.[key] === true;
}

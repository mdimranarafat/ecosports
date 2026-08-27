// ============================================================================
// Firebase initialization — single shared instance for the whole app.
// Replace the values below with your Firebase project's web config
// (Firebase Console → Project Settings → General → Your apps → SDK config).
// These values are NOT secret; Firestore Security Rules are what actually
// protect your data (see /firestore.rules).
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// TODO: replace with your project's config (see README.md → Firebase Setup)
export const firebaseConfig = {
 apiKey: "AIzaSyDgj90WGbRa3IfacaWfQpX3YDx6rEI6d2k",
  authDomain: "eco-sports-e01fe.firebaseapp.com",
  projectId: "eco-sports-e01fe",
  storageBucket: "eco-sports-e01fe.firebasestorage.app",
  messagingSenderId: "321451490217",
  appId: "1:321451490217:web:9c8bd0907187a5c417a2b8",
  measurementId: "G-EZEET3MHEM"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Offline persistence + multi-tab support = fewer reads, snappier UI,
// and the app keeps working (read-only) on a flaky connection.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export { onAuthStateChanged, signInWithEmailAndPassword, signOut };

// Fallback defaults used by settings-manager.js before the Firestore
// settings/business document has ever been saved (first run on a fresh
// project). Once an admin saves Settings, the Firestore doc takes over.
export const DEFAULT_SETTINGS = {
  businessName: "Eco Sports",
  currency: "BDT",
  timezone: "Asia/Dhaka",
  defaultSlotInterval: 30,
  minBookingDuration: 30,
  maxBookingDuration: 240,
  bookingLeadTimeMinutes: 30,
};

// ----------------------------------------------------------------------------
// App Check readiness (see README.md → Security Checklist).
// Set APP_CHECK_ENABLED = true once you've registered a reCAPTCHA v3 site
// key in the Firebase Console → App Check, and set
// FIREBASE_APPCHECK_DEBUG_TOKEN during local development so requests
// aren't blocked before you've registered a real domain.
// ----------------------------------------------------------------------------
const APP_CHECK_ENABLED = false;
const APP_CHECK_SITE_KEY = "REPLACE_WITH_RECAPTCHA_SITE_KEY";

export let appCheck = null;
if (APP_CHECK_ENABLED) {
  const { initializeAppCheck, ReCaptchaV3Provider } = await import(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js"
  );
  appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

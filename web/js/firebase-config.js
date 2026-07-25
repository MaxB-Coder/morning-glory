// Paste your Firebase web app config here (Project settings → your web app).
// These keys are NOT secret — they identify the project. Real security is
// enforced by Firestore rules (see firestore.rules), not by hiding these.
//
// Until you fill this in, the app runs LOCAL-ONLY (no sync), which is fine.
export const firebaseConfig = {
  apiKey: "AIzaSyA9rft3Ki0VKUpucI14KlmP6vmkeWnJzFU",
  authDomain: "morningglory89.firebaseapp.com",
  projectId: "morningglory89",
  storageBucket: "morningglory89.firebasestorage.app",
  messagingSenderId: "591417820344",
  appId: "1:591417820344:web:759b14b88b1a23add1204d",
};

// Set to false to force local-only even with a valid config (e.g. while testing).
export const SYNC_ENABLED = true;

export function isConfigured() {
  return SYNC_ENABLED && firebaseConfig.apiKey && firebaseConfig.apiKey !== "PASTE_ME";
}

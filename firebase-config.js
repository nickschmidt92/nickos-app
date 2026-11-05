// NickOS — Firebase configuration.
// This file is safe to commit: Firebase web API keys are not secrets.
// Security lives in firestore.rules (users only read/write their own /users/{uid}/* subtree)
// and in the Authorized Domains list in the Firebase console.

export const firebaseConfig = {
  apiKey: "AIzaSyBwoE3L1JNm1kN2gyQ6SVqxf5wzgDjQvJI",
  authDomain: "nickos-c1ce8.firebaseapp.com",
  projectId: "nickos-c1ce8",
  storageBucket: "nickos-c1ce8.firebasestorage.app",
  messagingSenderId: "969317292382",
  appId: "1:969317292382:web:4705bbbd4d50665a6a57cf"
};

// Which backend the web app talks to. 'v1' writes to the Firestore document as it always
// has. Flipping to 'v2' is a step in the cutover runbook, with apiBase set to the deployed
// API. Login stays on the project above either way (D-0220).
export const backend = { mode: 'v2', apiBase: 'https://api-suqfofvrla-uw.a.run.app' };

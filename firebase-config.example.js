/* ============================================================================
   FIREBASE CONFIG — Orbit Logistics
   ----------------------------------------------------------------------------
   Replace the placeholder values below with your own Firebase web app config
   (Firebase Console → Project settings → Your apps → SDK setup and configuration).

   NOTE: A Firebase *web* apiKey is designed to be public — it only identifies
   your project. Real security is enforced by Firestore Security Rules and
   Firebase Auth, NOT by hiding this object. It is safe to ship client-side.

   This file is git-ignored so your project's real config never lands in the
   repo. Copy firebase-config.example.js → firebase-config.js and fill it in.
   ============================================================================ */
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID"
};

firebase.initializeApp(firebaseConfig);

/* Shared handles used by auth.js / dashboard.js */
const fbAuth = firebase.auth();
const fbDB   = firebase.firestore();

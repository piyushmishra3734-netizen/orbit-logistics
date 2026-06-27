/* Loads the REAL Orbit source files into one shared global context,
   the same way the browser's sequential <script> tags do. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const env = require('./env');

const SRC = path.join(__dirname, '..', 'EGC-Logistics-System');

function load() {
  env.resetDB();
  const w = env.makeWindow();

  // localStorage stub (reliable-queue persistence)
  const _ls = {};
  w.localStorage = {
    getItem: (k) => (k in _ls ? _ls[k] : null),
    setItem: (k, v) => { _ls[k] = String(v); },
    removeItem: (k) => { delete _ls[k]; },
  };

  // Shared globals the app expects (declared with const in firebase-config.js,
  // but other files reference them as free vars → put on the context global).
  const sandbox = w;                 // window IS the global in browsers
  sandbox.globalThis = sandbox;
  sandbox.fbDB = null;               // set by firebase-config.js equivalent
  sandbox.fbAuth = null;

  vm.createContext(sandbox);

  // Files in the SAME ORDER as the dashboards load them (business layer only;
  // we skip auth.js + UI bootstrap that need a real DOM, but DO load
  // owner-dashboard.js because the Order Engine lives there).
  const files = [
    'phase3-core.js',
    'invoice.js',
    'lr.js',
    'shipment.js',
    'acc-core.js',
    'acc-posting.js',
    'companies.js',
  ];

  // firebase-config.js uses `const firebaseConfig` + `firebase.initializeApp`
  // and defines fbDB/fbAuth. Replicate its effect explicitly to avoid `const`
  // scoping quirks under vm:
  sandbox.firebase.initializeApp({});
  sandbox.fbDB = sandbox.firebase.firestore();
  sandbox.fbAuth = sandbox.firebase.auth();

  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }

  // owner-dashboard.js: its IIFE runs lots of top-level $-lookups that return
  // null/[] with our stubs (harmless), then defines window.OWN.* including
  // runOrderPipeline / approve / submitManualOrder.
  const own = fs.readFileSync(path.join(SRC, 'owner-dashboard.js'), 'utf8');
  vm.runInContext(own, sandbox, { filename: 'owner-dashboard.js' });

  return sandbox;
}

module.exports = { load, env };

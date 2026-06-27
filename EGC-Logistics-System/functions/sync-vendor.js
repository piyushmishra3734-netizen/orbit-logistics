/* Copies the canonical accounting source into functions/vendor so the deployed
   Cloud Function can run the REAL ACC engine (no duplication, no drift).
   Runs automatically via the functions predeploy hook in firebase.json. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');         // hosting root (repo)
const VENDOR = path.join(__dirname, 'vendor');
const FILES = ['phase3-core.js', 'acc-core.js', 'acc-ledgers.js'];

fs.mkdirSync(VENDOR, { recursive: true });
let copied = 0;
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) { console.error('[sync-vendor] MISSING source: ' + f); process.exit(1); }
  fs.copyFileSync(src, path.join(VENDOR, f));
  copied++;
}
console.log('[sync-vendor] synced ' + copied + ' accounting source files into functions/vendor');

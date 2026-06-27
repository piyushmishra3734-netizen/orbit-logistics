/* ============================================================================
   Orbit AI — ACCOUNTING BRIDGE
   ----------------------------------------------------------------------------
   The AI must NEVER recompute accounting. Trial Balance, P&L, Balance Sheet,
   Outstanding and ledgers all have one canonical implementation in the client's
   acc-core.js + acc-ledgers.js (pure folds over journalEntries). To guarantee
   the AI's numbers are byte-identical to what the owner sees on screen, we load
   those EXACT source files here under a tiny shim and drive them with the
   owner-scoped data fetched by the DataAccess layer.

   No reimplementation = no drift. If the accounting logic changes, this bridge
   picks it up automatically because it runs the real files.
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* Locate the client source. In a deployed Function the public site files are
   bundled alongside; we look in a couple of candidate locations. */
function srcDir() {
  const candidates = [
    path.join(__dirname, 'vendor'),                 // copied in at build (preferred)
    path.join(__dirname, '..'),                      // sibling to functions/ in repo
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'acc-core.js')) && fs.existsSync(path.join(c, 'acc-ledgers.js'))) return c;
  }
  throw new Error('Accounting source (acc-core.js / acc-ledgers.js) not found for the AI bridge.');
}

let _cachedCode = null;
function loadCode() {
  if (_cachedCode) return _cachedCode;
  const dir = srcDir();
  _cachedCode = {
    egc: fs.readFileSync(path.join(dir, 'phase3-core.js'), 'utf8'),
    core: fs.readFileSync(path.join(dir, 'acc-core.js'), 'utf8'),
    ledgers: fs.readFileSync(path.join(dir, 'acc-ledgers.js'), 'utf8'),
  };
  return _cachedCode;
}

/* Build a fresh ACC instance bound to a specific data bundle. Each call is
   isolated (no cross-request state leakage). */
function makeACC(bundle) {
  const code = loadCode();

  /* Minimal browser shim. firestore() is only touched by loadSettings/ensure
     paths we don't call; we inject settings directly. */
  const noopColl = {
    doc: () => ({ get: () => Promise.resolve({ exists: false, data: () => ({}) }), set: () => Promise.resolve() }),
    limit: () => ({ get: () => Promise.resolve({ empty: true, forEach() {} }) }),
    get: () => Promise.resolve({ empty: true, forEach() {} }),
    where() { return this; },
    add: () => Promise.resolve(),
  };
  const firestore = () => ({ collection: () => noopColl, batch: () => ({ set() {}, commit: () => Promise.resolve() }), runTransaction: (f) => f({ get: () => Promise.resolve({ exists: false }), set() {} }) });
  firestore.FieldValue = { serverTimestamp: () => new Date() };
  firestore.Timestamp = { fromDate: (d) => d, now: () => new Date() };

  const _ls = {};
  const sandbox = {
    window: {}, console: { log() {}, error() {}, warn() {} },
    firebase: { firestore, auth: () => ({ currentUser: { email: 'owner' } }), initializeApp() {} },
    localStorage: { getItem: (k) => (k in _ls ? _ls[k] : null), setItem: (k, v) => { _ls[k] = String(v); }, removeItem: (k) => { delete _ls[k]; } },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, Object, Array, String, Number, parseFloat, parseInt, isNaN,
  };
  sandbox.window = sandbox;            // window === global in browser
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(code.egc, sandbox, { filename: 'phase3-core.js' });
  vm.runInContext(code.core, sandbox, { filename: 'acc-core.js' });
  vm.runInContext(code.ledgers, sandbox, { filename: 'acc-ledgers.js' });

  const ACC = sandbox.ACC;

  /* Inject the owner-scoped data + settings. We override ACC.settings() to
     return the merged config (DEFAULT_SETTINGS + the owner's saved overrides),
     exactly as loadSettings would have produced it — without needing network.
     ACC.acct() reads through ACC.settings(), so this is sufficient. */
  const merged = JSON.parse(JSON.stringify(ACC.DEFAULT_SETTINGS));
  if (bundle.settings) {
    Object.keys(bundle.settings).forEach((k) => {
      if (k === 'accounts' && bundle.settings.accounts) {
        Object.keys(bundle.settings.accounts).forEach((a) => { merged.accounts[a] = bundle.settings.accounts[a]; });
      } else merged[k] = bundle.settings[k];
    });
  }
  ACC.settings = () => merged;
  ACC.acct = (key) => merged.accounts[key];

  ACC.setData(bundle.entries || [], bundle.accounts || [], bundle.parties || []);
  return ACC;
}

/* High-level report helpers the AI tools call. All owner-only; the caller must
   have already passed an owner-scoped bundle from DataAccess.accountingBundle(). */
function reports(bundle) {
  const ACC = makeACC(bundle);
  return {
    trialBalance: (opts) => ACC.reportTrialBalance(opts || {}),
    profitLoss: (opts) => ACC.reportProfitLoss(opts || {}),
    balanceSheet: (opts) => ACC.reportBalanceSheet(opts || {}),
    outstanding: () => ACC.reportOutstanding(),
    dashboard: (opts) => ACC.reportDashboard(opts || {}),
    partyLedger: (partyId, opts) => ACC.reportPartyLedger(partyId, opts || {}),
    accountLedger: (code, opts) => ACC.reportAccountLedger(code, opts || {}),
    register: (type, opts) => ACC.reportRegister(type, opts || {}),
    _acc: ACC,
  };
}

module.exports = { reports, makeACC };

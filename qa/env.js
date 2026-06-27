/* ============================================================
   QA ENVIRONMENT — faithful in-memory Firestore + minimal browser
   stubs so the REAL Orbit source modules run unmodified in Node.
   Mirrors the Firestore client surface the app actually uses:
   collection().doc().get/set/update, collection().add,
   chained .where().limit().orderBy().get(), batch(), runTransaction(),
   FieldValue.serverTimestamp(), Timestamp.fromDate().
   ============================================================ */
'use strict';

let NOW = 1700000000000;            // deterministic clock base
function tick() { NOW += 1000; return NOW; }

class Timestamp {
  constructor(ms) { this._ms = ms; }
  toDate() { return new Date(this._ms); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  static now() { return new Timestamp(tick()); }
}
const SERVER_TS = '__SERVER_TS__';

const FieldValue = {
  serverTimestamp() { return SERVER_TS; },
};

function deepClone(v) {
  if (v === SERVER_TS) return new Timestamp(tick());      // materialise on write
  if (v instanceof Timestamp) return new Timestamp(v._ms);
  if (Array.isArray(v)) return v.map(deepClone);
  if (v && typeof v === 'object') {
    const o = {}; for (const k of Object.keys(v)) o[k] = deepClone(v[k]); return o;
  }
  return v;
}

/* ---- the store ---- */
const DB = {};  // collectionName -> { docId -> data }

function coll(name) { return (DB[name] = DB[name] || {}); }

class DocSnap {
  constructor(id, data) { this.id = id; this._data = data; this.exists = data !== undefined; }
  data() { return this._data ? deepClone(this._data) : undefined; }
}

class DocRef {
  constructor(collName, id) { this.collName = collName; this.id = id; this.path = collName + '/' + id; }
  collection(sub) { return new CollRef(this.collName + '/' + this.id + '/' + sub); }
  get() { return Promise.resolve(new DocSnap(this.id, coll(this.collName)[this.id])); }
  set(data, opts) {
    const c = coll(this.collName);
    if (opts && opts.merge && c[this.id]) c[this.id] = Object.assign({}, c[this.id], deepClone(data));
    else c[this.id] = deepClone(data);
    return Promise.resolve();
  }
  update(data) {
    const c = coll(this.collName);
    if (!c[this.id]) return Promise.reject(new Error('No document to update: ' + this.path));
    c[this.id] = Object.assign({}, c[this.id], deepClone(data));
    return Promise.resolve();
  }
  delete() { delete coll(this.collName)[this.id]; return Promise.resolve(); }
}

class Query {
  constructor(collName, filters, lim) { this.collName = collName; this.filters = filters || []; this._lim = lim || null; }
  where(field, op, val) { return new Query(this.collName, this.filters.concat([{ field, op, val }]), this._lim); }
  orderBy() { return this; }                 // ordering irrelevant for QA correctness
  limit(n) { return new Query(this.collName, this.filters, n); }
  _run() {
    const c = coll(this.collName);
    let docs = Object.keys(c).map((id) => new DocSnap(id, c[id]));
    for (const f of this.filters) {
      docs = docs.filter((d) => {
        const v = d._data ? d._data[f.field] : undefined;
        if (f.op === '==') return v === f.val;
        if (f.op === 'in') return Array.isArray(f.val) && f.val.indexOf(v) !== -1;
        return true;
      });
    }
    if (this._lim) docs = docs.slice(0, this._lim);
    return docs;
  }
  get() { const docs = this._run(); return Promise.resolve({ empty: docs.length === 0, size: docs.length, docs, forEach: (cb) => docs.forEach(cb) }); }
}

class CollRef extends Query {
  constructor(name) { super(name, [], null); this.name = name; }
  doc(id) { if (id === undefined) id = 'auto-' + Math.random().toString(36).slice(2, 10); return new DocRef(this.name, id); }
  add(data) { const id = 'auto-' + Math.random().toString(36).slice(2, 10); coll(this.name)[id] = deepClone(data); return Promise.resolve(new DocRef(this.name, id)); }
}

class Batch {
  constructor() { this.ops = []; }
  set(ref, data, opts) { this.ops.push(() => ref.set(data, opts)); return this; }
  update(ref, data) { this.ops.push(() => ref.update(data)); return this; }
  delete(ref) { this.ops.push(() => ref.delete()); return this; }
  commit() { return this.ops.reduce((p, op) => p.then(op), Promise.resolve()); }
}

/* Transaction: serial, no real isolation needed for single-threaded QA, but
   we DO honour read-before-write and surface thrown errors (abort). */
class Txn {
  get(ref) { return ref.get(); }
  set(ref, data, opts) { this._q = (this._q || Promise.resolve()).then(() => ref.set(data, opts)); return this; }
  update(ref, data) { this._q = (this._q || Promise.resolve()).then(() => ref.update(data)); return this; }
  delete(ref) { this._q = (this._q || Promise.resolve()).then(() => ref.delete()); return this; }
}

const firestore = function () {
  return {
    collection: (n) => new CollRef(n),
    batch: () => new Batch(),
    runTransaction: (fn) => {
      const tx = new Txn();
      return Promise.resolve()
        .then(() => fn(tx))
        .then((res) => (tx._q || Promise.resolve()).then(() => res));
    },
  };
};
firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;

let _authUser = { email: 'piyushmishra3734@gmail.com', uid: 'owner-uid' };
const firebase = {
  initializeApp() {},
  firestore,
  auth() { return { currentUser: _authUser }; },
};
firebase.firestore.FieldValue = FieldValue;
firebase.firestore.Timestamp = Timestamp;

/* ---- minimal browser-ish globals so UI files can be *parsed/loaded* ---- */
const noopEl = {
  classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  style: {}, dataset: {}, appendChild() {}, removeChild() {}, focus() {}, reset() {},
  textContent: '', value: '', innerHTML: '',
};
const documentStub = {
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement() { return Object.assign({}, noopEl); },
  addEventListener() {},
  body: { appendChild() {}, removeChild() {}, style: {} },
};
const locationStub = { hash: '', href: '', replace() {} };
const historyStub = { replaceState() {} };

function makeWindow() {
  const w = {};
  w.window = w;
  w.document = documentStub;
  w.location = locationStub;
  w.history = historyStub;
  w.navigator = { onLine: true };
  w.firebase = firebase;
  w.console = console;
  w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
  w.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  w.alert = () => {};
  w.encodeURIComponent = encodeURIComponent;
  w.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} };
  w.Blob = function () {};
  /* TOS stub — auth gateway; onReady never fires in QA (we drive pipelines directly) */
  w.TOS = { onReady() {}, _ready: false };
  return w;
}

module.exports = { DB, coll, firebase, firestore, FieldValue, Timestamp, makeWindow,
  setAuthUser: (u) => { _authUser = u; }, deepClone, resetDB: () => { for (const k of Object.keys(DB)) delete DB[k]; } };

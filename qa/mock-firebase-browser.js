/* ============================================================
   MOCK FIREBASE (compat surface) for in-browser UI testing.
   Injected in place of the gstatic CDN + firebase-config.js so the
   real dashboard/owner pages boot offline with seeded data, a working
   onSnapshot, transactions and batches. Auto-signs-in based on
   window.__MOCK_ROLE ('owner' | 'customer').
   ============================================================ */
(function () {
  'use strict';
  var listeners = [];                 // active onSnapshot callbacks
  function notifyAll() { listeners.slice().forEach(function (l) { try { l(); } catch (e) {} }); }

  var DB;
  function coll(n) { DB = window.__MOCK_DB = window.__MOCK_DB || {}; return (DB[n] = DB[n] || {}); }

  function Timestamp(ms) { this._ms = ms; }
  Timestamp.prototype.toDate = function () { return new Date(this._ms); };
  Timestamp.fromDate = function (d) { return new Timestamp(d.getTime()); };
  Timestamp.now = function () { return new Timestamp(Date.now()); };

  var SERVER = '__SERVER_TS__';
  var FieldValue = { serverTimestamp: function () { return SERVER; } };

  function clone(v) {
    if (v === SERVER) return new Timestamp(Date.now());
    if (v instanceof Timestamp) return new Timestamp(v._ms);
    if (Array.isArray(v)) return v.map(clone);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) if (v.hasOwnProperty(k)) o[k] = clone(v[k]); return o; }
    return v;
  }

  function Snap(id, data) { this.id = id; this._d = data; this.exists = data !== undefined; }
  Snap.prototype.data = function () { return this._d ? clone(this._d) : undefined; };

  function DocRef(c, id) { this.c = c; this.id = id; }
  DocRef.prototype.collection = function (sub) { return new CollRef(this.c + '/' + this.id + '/' + sub); };
  DocRef.prototype.get = function () { return Promise.resolve(new Snap(this.id, coll(this.c)[this.id])); };
  DocRef.prototype.set = function (d, o) { var c = coll(this.c); if (o && o.merge && c[this.id]) c[this.id] = Object.assign({}, c[this.id], clone(d)); else c[this.id] = clone(d); notifyAll(); return Promise.resolve(); };
  DocRef.prototype.update = function (d) { var c = coll(this.c); if (!c[this.id]) return Promise.reject(new Error('no doc')); c[this.id] = Object.assign({}, c[this.id], clone(d)); notifyAll(); return Promise.resolve(); };
  DocRef.prototype.delete = function () { delete coll(this.c)[this.id]; notifyAll(); return Promise.resolve(); };
  DocRef.prototype.onSnapshot = function (cb, err) {
    var self = this;
    function emit() { cb(new Snap(self.id, coll(self.c)[self.id])); }
    listeners.push(emit); setTimeout(emit, 0);
    return function () { var i = listeners.indexOf(emit); if (i >= 0) listeners.splice(i, 1); };
  };

  function Query(c, filters, lim) { this.c = c; this.filters = filters || []; this._lim = lim || null; }
  Query.prototype.where = function (f, op, v) { return new Query(this.c, this.filters.concat([{ f: f, op: op, v: v }]), this._lim); };
  Query.prototype.orderBy = function () { return this; };
  Query.prototype.limit = function (n) { var q = new Query(this.c, this.filters, n); return q; };
  Query.prototype._run = function () {
    var c = coll(this.c), out = [];
    for (var id in c) if (c.hasOwnProperty(id)) {
      var d = c[id], keep = true;
      for (var i = 0; i < this.filters.length; i++) {
        var f = this.filters[i], val = d ? d[f.f] : undefined;
        if (f.op === '==' && val !== f.v) keep = false;
        if (f.op === 'in' && !(Array.isArray(f.v) && f.v.indexOf(val) !== -1)) keep = false;
      }
      if (keep) out.push(new Snap(id, d));
    }
    if (this._lim) out = out.slice(0, this._lim);
    return out;
  };
  Query.prototype.get = function () { var docs = this._run(); return Promise.resolve({ empty: docs.length === 0, size: docs.length, docs: docs, forEach: function (cb) { docs.forEach(cb); } }); };
  Query.prototype.onSnapshot = function (cb, err) {
    var self = this;
    function emit() { var docs = self._run(); cb({ empty: docs.length === 0, size: docs.length, docs: docs, forEach: function (c) { docs.forEach(c); } }); }
    listeners.push(emit); setTimeout(emit, 0);
    return function () { var i = listeners.indexOf(emit); if (i >= 0) listeners.splice(i, 1); };
  };

  function CollRef(n) { Query.call(this, n, [], null); this.n = n; }
  CollRef.prototype = Object.create(Query.prototype);
  CollRef.prototype.constructor = CollRef;
  CollRef.prototype.doc = function (id) { if (id === undefined) id = 'auto-' + Math.random().toString(36).slice(2, 9); return new DocRef(this.n, id); };
  CollRef.prototype.add = function (d) { var id = 'auto-' + Math.random().toString(36).slice(2, 9); coll(this.n)[id] = clone(d); notifyAll(); return Promise.resolve(new DocRef(this.n, id)); };

  function Batch() { this.ops = []; }
  Batch.prototype.set = function (r, d, o) { this.ops.push(function () { return r.set(d, o); }); return this; };
  Batch.prototype.update = function (r, d) { this.ops.push(function () { return r.update(d); }); return this; };
  Batch.prototype.delete = function (r) { this.ops.push(function () { return r.delete(); }); return this; };
  Batch.prototype.commit = function () { return this.ops.reduce(function (p, op) { return p.then(op); }, Promise.resolve()).then(notifyAll); };

  function Txn() {}
  Txn.prototype.get = function (r) { return r.get(); };
  Txn.prototype.set = function (r, d, o) { this._q = (this._q || Promise.resolve()).then(function () { return r.set(d, o); }); return this; };
  Txn.prototype.update = function (r, d) { this._q = (this._q || Promise.resolve()).then(function () { return r.update(d); }); return this; };
  Txn.prototype.delete = function (r) { this._q = (this._q || Promise.resolve()).then(function () { return r.delete(); }); return this; };

  function firestore() {
    return {
      collection: function (n) { return new CollRef(n); },
      collectionGroup: function (n) { return new Query(n, [], null); },
      batch: function () { return new Batch(); },
      runTransaction: function (fn) { var tx = new Txn(); return Promise.resolve().then(function () { return fn(tx); }).then(function (res) { return (tx._q || Promise.resolve()).then(function () { notifyAll(); return res; }); }); },
    };
  }
  firestore.FieldValue = FieldValue;
  firestore.Timestamp = Timestamp;

  /* ---- auth ---- */
  function resolveUser() {
    var ROLE = window.__MOCK_ROLE || 'owner';
    return ROLE === 'owner'
      ? { uid: 'owner-uid', email: 'piyushmishra3734@gmail.com', displayName: 'Owner', photoURL: null, phoneNumber: null, providerData: [{ providerId: 'password' }] }
      : { uid: 'cust-A-uid', email: 'cust@acme.test', displayName: 'Acme Customer', photoURL: null, phoneNumber: null, providerData: [{ providerId: 'password' }] };
  }

  function auth() {
    var u = resolveUser();
    return {
      currentUser: u,
      onAuthStateChanged: function (cb) { setTimeout(function () { cb(resolveUser()); }, 0); return function () {}; },
      signInWithPopup: function () { return Promise.resolve({ user: resolveUser() }); },
      signInWithEmailAndPassword: function () { return Promise.resolve({ user: resolveUser() }); },
      createUserWithEmailAndPassword: function () { return Promise.resolve({ user: resolveUser() }); },
      sendPasswordResetEmail: function () { return Promise.resolve(); },
      signOut: function () { return Promise.resolve(); },
    };
  }
  auth.GoogleAuthProvider = function () {};

  window.firebase = {
    apps: [{ name: '[DEFAULT]' }],
    initializeApp: function () {},
    firestore: firestore,
    auth: auth,
    functions: function () {
      return {
        httpsCallable: function (name) {
          if (name === 'orbitInsight') {
            return function (payload) {
              var role = (window.__MOCK_ROLE === 'owner') ? 'owner' : 'customer';
              window.__ORBIT_INSIGHT_CALLED = (window.__ORBIT_INSIGHT_CALLED || 0) + 1;
              window.__ORBIT_INSIGHT_CTX = payload && payload.context;
              var ctx = (payload && payload.context) || {};
              if (role === 'owner') {
                if (ctx.page === 'accounting' && ctx.hash === 'outstanding') {
                  return Promise.resolve({ data: { insight: { text: 'You have ₹4.2 lakh outstanding. Acme Traders has crossed 90 days — follow up first.', suggest: { label: 'Draft a reminder for Acme Traders', message: 'Draft a payment reminder for Acme Traders' } } } });
                }
                return Promise.resolve({ data: { insight: null } });
              }
              return Promise.resolve({ data: { insight: { text: 'Welcome back 👋 Your shipment has left Indore and is on its way. Expected delivery: tomorrow. Looks like everything is on schedule.\nNeed your invoice or LR?', stateKey: 'EGC-1|in_transit|tomorrow', suggest: { label: 'Download Invoice or LR', message: 'Download my invoice and LR' } } } });
            };
          }
          if (name === 'orbitMorningBrief') {
            return function () {
              var role = (window.__MOCK_ROLE === 'owner') ? 'owner' : 'customer';
              if (role !== 'owner') return Promise.reject(new Error('permission-denied'));
              window.__ORBIT_BRIEF_CALLED = true;
              return Promise.resolve({ data: {
                ownerName: 'Piyush',
                narration: 'Good morning, Piyush. 2 deliveries are in progress and ₹4.14 lakh is outstanding. ACME Transport has been waiting 70 days — follow up first.',
                brief: { greeting: 'Good morning, Piyush.', items: [{ kind: 'pending_deliveries', text: '2 deliveries in progress.' }], recommendations: ['Follow up ACME first.'] },
              } });
            };
          }
          return function (payload) {
            /* Deterministic mock of the orbitAI Cloud Function so the UI can be
               tested offline. Echoes role + a canned answer; emits a navigate
               action when the message mentions tracking/orders. */
            var role = (window.__MOCK_ROLE === 'owner') ? 'owner' : 'customer';
            var msg = (payload && payload.message || '').toLowerCase();
            var actions = [];
            if (/track|where is/.test(msg)) actions.push({ kind: 'navigate', target: role === 'owner' ? 'orders' : 'tracking', action: role === 'owner' ? null : 'track_shipment', query: 'INV-2026-0001' });
            if (/manual order|create.*order/.test(msg) && role === 'owner') actions.push({ kind: 'draft_manual_order', draft: { pickup: 'Indore', delivery: 'Mumbai', freight: 12000 } });
            window.__ORBIT_LAST_PAYLOAD = payload;
            var explanatory = /explain|gst|tds|what is|charges/i.test(msg);
            var replyText = explanatory
              ? 'Mock Orbit AI reply for a ' + role + '. GST is a tax added to your freight invoice; for example on a ₹10,000 freight you charge ₹1,800 GST, and the debit and credit entries keep your ledger balanced. This is the journal entry behind every invoice.'
              : 'Mock Orbit AI reply for a ' + role + '.';
            return Promise.resolve({ data: { text: replyText, actions: actions, role: role } });
          };
        },
      };
    },
  };
  window.firebase.firestore.FieldValue = FieldValue;
  window.firebase.firestore.Timestamp = Timestamp;

  /* config-file equivalents the app expects as globals */
  window.fbDB = firestore();
  var _authObj = auth();
  Object.defineProperty(_authObj, 'currentUser', { get: function () { return resolveUser(); } });
  window.fbAuth = _authObj;
  window.__MOCK_NOTIFY = notifyAll;
})();

/* ============================================================================
   Orbit AI — DATA ACCESS LAYER (the security boundary)
   ----------------------------------------------------------------------------
   This module is the ONLY way Orbit AI reads business data. Every method takes
   an already-verified `auth` context ({ uid, email, isOwner }) derived from the
   Firebase ID token on the server — NEVER from anything the client claimed.

   The cardinal rule, mirroring firestore.rules exactly:
     • OWNER  → may read all records.
     • CUSTOMER → may read ONLY records where customerUid === their uid.

   Customer scoping is applied as a hard Firestore `where('customerUid','==',uid)`
   filter on the query itself, so the database — not the prompt, not the model —
   enforces it. The LLM literally never receives a document the user could not
   already read through the existing rules. A prompt-injection attempt cannot
   widen this, because the scope is bound to the verified uid before any tool
   runs and is re-applied on every single query.

   This file has NO dependency on Gemini and NO knowledge of prompts. It is pure
   data access + scoping, so it can be unit-tested in isolation (see test/).
   ============================================================================ */
'use strict';

/* The collections the AI is permitted to read, and HOW each is scoped for a
   customer. `ownerOnly: true` means a customer may never read it at all (these
   mirror the isOwner()-gated collections in firestore.rules). `scopeField`
   is the field that must equal the customer's uid. */
const READABLE = {
  orders:         { scopeField: 'customerUid' },
  invoices:       { scopeField: 'customerUid' },
  lorryReceipts:  { scopeField: 'customerUid' },
  quotes:         { scopeField: 'customerUid' },
  notifications:  { scopeField: 'customerUid' },
  // Owner-only (sensitive cross-customer / financial / audit):
  journalEntries: { ownerOnly: true },
  accounts:       { ownerOnly: true },
  parties:        { ownerOnly: true },
  accountingSettings: { ownerOnly: true },
  auditLogs:      { ownerOnly: true },
  companies:      { ownerOnly: true },   // directory reveals other customers' data
  ownerNotifications: { ownerOnly: true },
  customerProfiles: { ownerOnly: true }, // a customer reads only their OWN profile (handled separately)
};

class AccessDenied extends Error {
  constructor(msg) { super(msg); this.name = 'AccessDenied'; this.code = 'permission-denied'; }
}

class DataAccess {
  /**
   * @param {FirebaseFirestore.Firestore} db  Admin SDK Firestore
   * @param {{uid:string,email:string,isOwner:boolean}} auth  VERIFIED context
   */
  constructor(db, auth) {
    if (!auth || !auth.uid) throw new AccessDenied('Unauthenticated.');
    this.db = db;
    this.auth = auth;
  }

  /* Build a base query for a collection, applying customer scoping. Throws for
     owner-only collections when the caller is not the owner. */
  _scoped(collection) {
    const rule = READABLE[collection];
    if (!rule) throw new AccessDenied('Collection not readable via Orbit AI: ' + collection);
    let q = this.db.collection(collection);
    if (this.auth.isOwner) return q;                 // owner: unrestricted
    if (rule.ownerOnly) throw new AccessDenied('This information is restricted to the owner.');
    return q.where(rule.scopeField, '==', this.auth.uid);   // customer: hard scope
  }

  /* Defense-in-depth: even after a scoped query, re-verify each doc belongs to
     the customer before returning it. Belt and suspenders. */
  _guard(collection, docData) {
    if (this.auth.isOwner) return docData;
    const rule = READABLE[collection] || {};
    if (rule.ownerOnly) throw new AccessDenied('Restricted.');
    if (docData && docData[rule.scopeField] !== this.auth.uid) {
      throw new AccessDenied('Cross-account access blocked.');
    }
    return docData;
  }

  async _docsFrom(query, collection, limit) {
    const snap = await (limit ? query.limit(limit) : query).get();
    const out = [];
    snap.forEach((d) => out.push(this._guard(collection, Object.assign({ _id: d.id }, d.data()))));
    return out;
  }

  /* ---- generic getters (all scoped) ---- */
  async getDoc(collection, id) {
    const rule = READABLE[collection];
    if (!rule) throw new AccessDenied('Not readable: ' + collection);
    if (!this.auth.isOwner && rule.ownerOnly) throw new AccessDenied('Restricted to owner.');
    const snap = await this.db.collection(collection).doc(id).get();
    if (!snap.exists) return null;
    const data = Object.assign({ _id: snap.id }, snap.data());
    /* For a customer, a doc that exists but belongs to someone else must look
       EXACTLY like "not found" — never confirm another customer's record
       exists. So return null instead of throwing on the ownership mismatch. */
    if (!this.auth.isOwner && rule.scopeField && data[rule.scopeField] !== this.auth.uid) {
      return null;
    }
    return data;
  }

  async list(collection, { limit = 50, where = [] } = {}) {
    let q = this._scoped(collection);
    for (const [f, op, v] of where) q = q.where(f, op, v);
    return this._docsFrom(q, collection, limit);
  }

  /* ---- domain-specific, intention-revealing reads ---- */

  async findInvoice(invoiceId) {
    // exact id first
    const direct = await this.getDoc('invoices', invoiceId);
    if (direct) return direct;
    // fall back to invoiceNumber match within scope
    let q = this._scoped('invoices').where('invoiceNumber', '==', invoiceId);
    const rows = await this._docsFrom(q, 'invoices', 1);
    return rows[0] || null;
  }

  async findByLr(lrNumber) {
    const lr = await this.getDoc('lorryReceipts', lrNumber);
    if (lr) return lr;
    let q = this._scoped('lorryReceipts').where('lrNumber', '==', lrNumber);
    const rows = await this._docsFrom(q, 'lorryReceipts', 1);
    return rows[0] || null;
  }

  async getOrder(orderId) { return this.getDoc('orders', orderId); }

  async ordersForCustomerName(name) {
    // OWNER-ONLY: searching across customers by name. Customers can't use this.
    if (!this.auth.isOwner) throw new AccessDenied('Searching by company is an owner action.');
    const term = String(name || '').toLowerCase().trim();
    const all = await this._docsFrom(this.db.collection('orders'), 'orders', 500);
    return all.filter((o) =>
      [o.companyName, o.customerName, o.consigneeName, o.consignorName]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(term)));
  }

  async myOrders(limit = 25) { return this.list('orders', { limit }); }
  async myInvoices(limit = 25) { return this.list('invoices', { limit }); }
  async myQuotes(limit = 25) { return this.list('quotes', { limit }); }

  /* Customer profile: a customer may read ONLY their own. */
  async myProfile() {
    const snap = await this.db.collection('customerProfiles').doc(this.auth.uid).get();
    return snap.exists ? Object.assign({ _id: snap.id }, snap.data()) : null;
  }

  /* ---- accounting source data (OWNER ONLY) ---- */
  async accountingBundle() {
    if (!this.auth.isOwner) throw new AccessDenied('Accounting is restricted to the owner.');
    const [entries, accounts, parties, settings] = await Promise.all([
      this._docsFrom(this.db.collection('journalEntries'), 'journalEntries', 5000),
      this._docsFrom(this.db.collection('accounts'), 'accounts', 500),
      this._docsFrom(this.db.collection('parties'), 'parties', 1000),
      this.db.collection('accountingSettings').doc('config').get(),
    ]);
    return {
      entries,
      accounts,
      parties,
      settings: settings.exists ? settings.data() : null,
    };
  }
}

module.exports = { DataAccess, AccessDenied, READABLE };

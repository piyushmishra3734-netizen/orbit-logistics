/* ============================================================
   PHASE3-CORE.JS — Shared Quote/Order logic
   Express Goods Carrier — Phase 3 (Upgraded)

   Used by BOTH dashboard.js (customer) and owner-dashboard.js
   (owner). Single source of truth for statuses, labels, IDs.
   ============================================================ */

(function () {
  'use strict';

  window.EGC = window.EGC || {};

  /* OWNER IDENTITY */
  var OWNER_EMAIL = 'piyushmishra3734@gmail.com';
  window.EGC.OWNER_EMAIL = OWNER_EMAIL;
  window.EGC.isOwnerEmail = function (email) {
    return !!email && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
  };

  /* STATUS DEFINITIONS */
  window.EGC.QUOTE_STATUS = {
    PENDING:           'pending_review',
    REVISED:           'revised_by_owner',
    CUSTOMER_ACCEPTED: 'customer_accepted',
    CUSTOMER_REJECTED: 'customer_rejected',
    APPROVED:          'approved',
    REJECTED:          'rejected',
    CANCELLED:         'cancelled'
  };

  window.EGC.ORDER_STATUS = {
    APPROVED:       'approved',
    TRUCK_ASSIGNED: 'truck_assigned',
    LOADING:        'loading',
    IN_TRANSIT:     'in_transit',
    DELIVERED:      'delivered'
  };

  window.EGC.ORDER_STATUS_SEQUENCE = [
    'approved', 'truck_assigned', 'loading', 'in_transit', 'delivered'
  ];

  /* Customer-facing labels */
  var QUOTE_LABELS = {
    pending_review:    'Pending Review',
    revised_by_owner:  'Awaiting Your Acceptance',
    customer_accepted: 'Awaiting Approval',
    customer_rejected: 'Revision Rejected',
    approved:          'Approved',
    rejected:          'Rejected',
    cancelled:         'Cancelled'
  };

  /* Owner-facing labels */
  var QUOTE_LABELS_OWNER = {
    pending_review:    'Pending Review',
    revised_by_owner:  'Awaiting Customer',
    customer_accepted: 'Customer Accepted',
    customer_rejected: 'Customer Rejected',
    approved:          'Approved',
    rejected:          'Rejected',
    cancelled:         'Cancelled'
  };

  var ORDER_LABELS = {
    approved:       'Approved',
    truck_assigned: 'Truck Assigned',
    loading:        'Loading',
    in_transit:     'In Transit',
    delivered:      'Delivered'
  };

  window.EGC.quoteStatusLabel      = function (s) { return QUOTE_LABELS[s] || s; };
  window.EGC.quoteStatusLabelOwner = function (s) { return QUOTE_LABELS_OWNER[s] || s; };
  window.EGC.orderStatusLabel      = function (s) { return ORDER_LABELS[s] || s; };

  window.EGC.quoteStatusClass = function (s) {
    if (s === 'approved') return 'st-ok';
    if (s === 'customer_accepted') return 'st-waiting';
    if (s === 'rejected' || s === 'customer_rejected' || s === 'cancelled') return 'st-bad';
    if (s === 'revised_by_owner') return 'st-revised';
    return 'st-pending';
  };

  window.EGC.orderStatusClass = function (s) {
    if (s === 'delivered') return 'st-ok';
    if (s === 'in_transit' || s === 'loading' || s === 'truck_assigned') return 'st-progress';
    return 'st-pending';
  };

  /* SEQUENTIAL ID GENERATION */
  function pad4(n) { return ('0000' + n).slice(-4); }

  function nextSequentialId(counterName, prefix) {
    var year = new Date().getFullYear();
    var ref = fbDB.collection('counters').doc(counterName);
    return fbDB.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var data = snap.exists ? snap.data() : null;
        var seq = 1;
        if (data && data.year === year) { seq = (data.lastSeq || 0) + 1; }
        tx.set(ref, { year: year, lastSeq: seq }, { merge: true });
        return prefix + '-' + year + '-' + pad4(seq);
      });
    });
  }

  window.EGC.nextQuoteId   = function () { return nextSequentialId('quotes', 'Q'); };
  window.EGC.nextOrderId   = function () { return nextSequentialId('orders', 'EGC'); };
  window.EGC.nextInvoiceId = function () { return nextSequentialId('invoices', 'INV'); };

  /* NOTIFICATION HELPERS */
  /* ============================================================
     RELIABLE FOLLOW-UP (B3)
     Business-critical records (quote/order/invoice/LR) are written
     atomically in a transaction. Audit logs + notifications are
     follow-ups: they must NOT be inside that transaction (to avoid
     contention) but must also never silently disappear.

     EGC.reliable(fn, label) runs a promise-returning side effect with
     exponential-backoff retries. If it still fails, the intent is
     persisted to localStorage and replayed on the next page load, so a
     transient outage can't lose an audit entry or a customer notice.
     ============================================================ */
  var RELIABLE_KEY = 'egc_reliable_queue_v1';
  var RELIABLE_MAX_RETRIES = 4;     /* ~ up to 0.5s,1s,2s,4s backoff */

  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(RELIABLE_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(RELIABLE_KEY, JSON.stringify(q.slice(-200))); } catch (e) {}
  }
  function enqueueFailure(kind, args) {
    var q = loadQueue();
    q.push({ kind: kind, args: args, ts: Date.now() });
    saveQueue(q);
  }

  /* Replay a persisted intent. Only serializable intents are queued, so
     we reconstruct the call from {kind,args} rather than a closure. */
  function replayIntent(item) {
    if (item.kind === 'notification') {
      var a = item.args;
      return rawCreateNotification(a.customerUid, a.type, a.message, a.meta);
    }
    if (item.kind === 'audit') {
      var b = item.args;
      return window.EGC.logAudit(b.action, b.summary, b.details);
    }
    if (item.kind === 'activity') {
      var c = item.args;
      return window.EGC.logActivity(c.customerUid, c.type, c.message, c.meta);
    }
    return Promise.resolve();
  }

  window.EGC.reliable = function (fn, opts) {
    opts = opts || {};
    var attempt = 0;
    function run() {
      return Promise.resolve().then(fn).catch(function (err) {
        attempt++;
        if (attempt <= RELIABLE_MAX_RETRIES) {
          var delay = 250 * Math.pow(2, attempt);   /* 0.5s, 1s, 2s, 4s */
          return new Promise(function (res) { setTimeout(res, delay); }).then(run);
        }
        console.error('[EGC] reliable op failed after retries:', opts.label || '', err && err.message);
        if (opts.persist) enqueueFailure(opts.persist.kind, opts.persist.args);
        /* Swallow — a failed follow-up must never break the main flow. */
        return null;
      });
    }
    return run();
  };

  /* Drain any persisted failures from a previous session. Call once at
     startup (safe to call when signed out — writes simply no-op on rules). */
  window.EGC.flushReliableQueue = function () {
    var q = loadQueue();
    if (!q.length) return Promise.resolve();
    saveQueue([]);   /* take ownership; failures re-enqueue themselves */
    return q.reduce(function (p, item) {
      return p.then(function () {
        return window.EGC.reliable(function () { return replayIntent(item); },
          { label: 'replay:' + item.kind, persist: { kind: item.kind, args: item.args } });
      });
    }, Promise.resolve());
  };

  /* Convenience wrappers that make the common follow-ups reliable +
     durable in one call, used by the approval / status / payment flows. */
  window.EGC.reliableNotify = function (customerUid, type, message, meta) {
    return window.EGC.reliable(
      function () { return rawCreateNotification(customerUid, type, message, meta); },
      { label: 'notify:' + type, persist: { kind: 'notification', args: { customerUid: customerUid, type: type, message: message, meta: meta || {} } } }
    );
  };
  window.EGC.reliableAudit = function (action, summary, details) {
    return window.EGC.reliable(
      function () { return window.EGC.logAudit(action, summary, details); },
      { label: 'audit:' + action, persist: { kind: 'audit', args: { action: action, summary: summary, details: details || {} } } }
    );
  };
  window.EGC.reliableActivity = function (customerUid, type, message, meta) {
    return window.EGC.reliable(
      function () { return window.EGC.logActivity(customerUid, type, message, meta); },
      { label: 'activity:' + type, persist: { kind: 'activity', args: { customerUid: customerUid, type: type, message: message, meta: meta || {} } } }
    );
  };

  /* Internal raw notification writer (no auto-audit) so replay/reliable
     paths don't double-log. The public createNotification keeps its
     existing auto-audit behaviour for backward compatibility. */
  function rawCreateNotification(customerUid, type, message, meta) {
    return fbDB.collection('notifications').add({
      customerUid: customerUid,
      type:        type,
      message:     message,
      meta:        meta || {},
      read:        false,
      createdAt:   firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  window.EGC.createNotification = function (customerUid, type, message, meta) {
    /* Every notification automatically produces an audit trail entry too,
       so "Notification sent" is always covered without scattering calls. */
    window.EGC.logAudit('notification_sent', message, {
      targetType: 'notification',
      targetId:   customerUid,
      newValue:   type
    });
    return rawCreateNotification(customerUid, type, message, meta);
  };

  /* ============================================================
     AUDIT LOG — Phase 4 Upgraded
     Business-grade, entity-linked, export-ready audit system.
     - Every entry is linked to its entity (order/quote/invoice/payment)
     - Orders & quotes have their own timeline sub-collections
     - Global auditLogs collection remains for master audit view
     - Append-only: no update/delete permitted by Firestore rules
     ============================================================ */

  var AUDIT_LABELS = {
    quote_submitted:     'Quote Submitted',
    quote_revised:       'Quote Revised',
    quote_accepted:      'Quote Accepted',
    quote_rejected:      'Quote Rejected',
    order_created:       'Order Created',
    status_changed:      'Status Changed',
    notification_sent:   'Notification Sent',
    invoice_generated:   'Invoice Generated',
    lr_generated:        'Lorry Receipt Generated',
    shipment_updated:    'Shipment Updated',
    payment_recorded:    'Payment Recorded',
    truck_assigned:      'Truck Assigned',
    loading_started:     'Loading Started',
    in_transit:          'In Transit',
    delivered:           'Delivered'
  };

  /* Maps entity-level event to a display icon class for timelines */
  var AUDIT_TIMELINE_ICONS = {
    quote_submitted:   'tl-submit',
    quote_revised:     'tl-revise',
    quote_accepted:    'tl-accept',
    quote_rejected:    'tl-reject',
    order_created:     'tl-create',
    status_changed:    'tl-status',
    truck_assigned:    'tl-truck',
    loading_started:   'tl-loading',
    in_transit:        'tl-transit',
    delivered:         'tl-done',
    invoice_generated: 'tl-invoice',
    payment_recorded:  'tl-payment',
    notification_sent: 'tl-notif'
  };

  window.EGC.AUDIT_LABELS        = AUDIT_LABELS;
  window.EGC.AUDIT_TIMELINE_ICONS = AUDIT_TIMELINE_ICONS;
  window.EGC.auditActionLabel     = function (a) { return AUDIT_LABELS[a] || a; };

  /**
   * Record a global audit log entry AND write to the entity-specific timeline.
   *
   * @param {string} action     — one of the AUDIT_LABELS keys
   * @param {string} summary    — short human-readable description
   * @param {object} [details]  — {
   *   targetType,   // 'order' | 'quote' | 'invoice' | 'payment' | 'notification'
   *   targetId,     // entity ID: e.g. 'EGC-2026-0006', 'Q-2026-0003', 'INV-2026-0001'
   *   orderId,      // if this event belongs to an order timeline (optional)
   *   quoteId,      // if this event belongs to a quote timeline (optional)
   *   previousValue,
   *   newValue,
   *   meta          // any extra data for future AI analysis
   * }
   */
  window.EGC.logAudit = function (action, summary, details) {
    var user = (window.firebase && firebase.auth) ? firebase.auth().currentUser : null;
    details = details || {};

    var entry = {
      action:         action,
      actionLabel:    window.EGC.auditActionLabel(action),
      summary:        summary || '',
      actorUid:       user ? user.uid : null,
      actorEmail:     user ? user.email : 'system',
      actorRole:      user ? (window.EGC.isOwnerEmail(user.email) ? 'owner' : 'customer') : 'system',
      targetType:     details.targetType || null,
      targetId:       details.targetId   || null,
      orderId:        details.orderId    || null,
      quoteId:        details.quoteId    || null,
      previousValue:  details.previousValue !== undefined ? details.previousValue : null,
      newValue:       details.newValue      !== undefined ? details.newValue      : null,
      meta:           details.meta          || {},
      createdAt:      firebase.firestore.FieldValue.serverTimestamp()
    };

    var writes = [];

    /* 1. Global master audit log (always) */
    writes.push(
      fbDB.collection('auditLogs').add(entry).catch(function (err) {
        console.error('[EGC] audit master write failed:', err.message);
      })
    );

    /* 2. Order-specific timeline (when orderId is present) */
    if (details.orderId) {
      writes.push(
        fbDB.collection('orderTimelines').doc(details.orderId)
          .collection('events').add(entry)
          .catch(function (err) {
            console.error('[EGC] order timeline write failed:', err.message);
          })
      );
    }

    /* 3. Quote-specific timeline (when quoteId is present) */
    if (details.quoteId) {
      writes.push(
        fbDB.collection('quoteTimelines').doc(details.quoteId)
          .collection('events').add(entry)
          .catch(function (err) {
            console.error('[EGC] quote timeline write failed:', err.message);
          })
      );
    }

    return Promise.all(writes);
  };

  /* ACTIVITY LOG HELPERS */
  window.EGC.logActivity = function (customerUid, type, message, meta) {
    return fbDB
      .collection('activityLog').doc(customerUid)
      .collection('entries').add({
        type:      type,
        message:   message,
        meta:      meta || {},
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
  };

  /* FORMATTING HELPERS */
  window.EGC.fmtDate = function (val) {
    if (!val) return '—';
    var d;
    if (val.toDate) d = val.toDate();
    else if (val instanceof Date) d = val;
    else d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  window.EGC.fmtWhen = function (ts) {
    if (!ts || !ts.toDate) return 'Just now';
    var diff = Date.now() - ts.toDate().getTime();
    var mins = Math.round(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hr' + (hrs > 1 ? 's' : '') + ' ago';
    var days = Math.round(hrs / 24);
    return days + ' day' + (days > 1 ? 's' : '') + ' ago';
  };

  window.EGC.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

})();

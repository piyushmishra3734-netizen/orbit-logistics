/* ============================================================
   OWNER-DASHBOARD.JS — Express Goods Carrier — Phase 3

   FIXED:
   - Approve button is ONLY shown for pending_review OR customer_accepted
     (NOT for revised_by_owner — owner must wait for customer response)
   - All owner actions now create Firestore notifications + activity log
     entries so the customer dashboard updates in real time.
   - Uses EGC.quoteStatusLabelOwner() for owner-side labels.
   ============================================================ */

(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------------------------------------------------------
     TABS
  --------------------------------------------------------- */
  function openTab(name) {
    $all('.dash-tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === name); });
    $all('.dash-panel').forEach(function (p) { p.classList.toggle('on', p.id === 'panel-' + name); });
  }
  $all('.dash-tab').forEach(function (t) {
    t.addEventListener('click', function () { openTab(t.dataset.tab); history.replaceState(null, '', '#' + t.dataset.tab); });
  });
  var initialTab = (location.hash || '').replace('#', '');
  if (['pending', 'orders', 'allquotes', 'invoices', 'lr', 'audit'].indexOf(initialTab) !== -1) openTab(initialTab);

  /* ---------------------------------------------------------
     TOAST
  --------------------------------------------------------- */
  function toast(ok, text) {
    var host = $('#toastHost');
    if (!host) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (ok ? 'ok' : 'bad');
    el.textContent = text;
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 320);
    }, 3200);
  }

  /* ---------------------------------------------------------
     OWNER ACCESS GUARD
  --------------------------------------------------------- */
  TOS.onReady(function (user) {
    var guard  = $('#guard');
    var denied = $('#denied');
    var main   = $('#dashMain');

    if (!user || !EGC.isOwnerEmail(user.email)) {
      if (guard)  guard.style.display = 'none';
      if (denied) denied.style.display = 'flex';
      return;
    }

    if (guard) guard.classList.add('fade-out');
    if (main)  { main.style.display = 'block'; requestAnimationFrame(function () { main.classList.add('visible'); }); }
    setTimeout(function () { if (guard) guard.style.display = 'none'; }, 380);

    /* B3: replay any audit/notification follow-ups that failed in a prior
       session so the audit trail and customer notices can't silently vanish. */
    if (EGC.flushReliableQueue) EGC.flushReliableQueue();

    /* Accounting: ensure the Chart of Accounts + settings exist (idempotent),
       then load settings into cache for the posting engine. */
    if (window.ACC && ACC.ensureSeeded) ACC.ensureSeeded();

    loadPendingQuotes();
    loadRevisedQuotes();
    loadOwnerOrders();
    loadAllQuotes();
    loadAuditLogs();
    loadInvoices();
    loadLorryReceipts();
  });

  /* ===========================================================
     PENDING QUOTES — action-required cards
  =========================================================== */
  var pendingUnsub    = null;
  var revisedUnsub    = null;
  var pendingCache    = {};
  var pendingQuotesData = [];
  var revisedQuotesData = [];

  /* ---------------------------------------------------------
     Build card HTML.
     KEY RULE: Approve button shown ONLY for:
       - status === 'pending_review'
       - status === 'customer_accepted'
     Revise button shown ONLY for status === 'pending_review'
     For 'revised_by_owner' cards: no approve, no revise, only reject
  --------------------------------------------------------- */
  function pendingCardHTML(q) {
    var when = EGC.fmtWhen(q.createdAt);
    var isPending          = q.status === EGC.QUOTE_STATUS.PENDING;
    var isCustomerAccepted = q.status === EGC.QUOTE_STATUS.CUSTOMER_ACCEPTED;
    var isRevised          = q.status === EGC.QUOTE_STATUS.REVISED;

    /* banner at the top of the card */
    var topBanner = '';
    if (isCustomerAccepted) {
      topBanner = (
        '<div class="revision-banner revision-accepted">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>' +
          ' Customer accepted the revised quote — approve now to create the order' +
        '</div>'
      );
    }

    var statusBadge = isPending
      ? '<span class="st-badge st-pending"><span class="st-dot"></span>Pending Review</span>'
      : isCustomerAccepted
        ? '<span class="st-badge st-ok"><span class="st-dot"></span>Customer Accepted</span>'
        : '<span class="st-badge st-revised"><span class="st-dot"></span>Awaiting Customer</span>';

    /* Action buttons — only owner actions that make sense at this stage */
    var approveBtn = (isPending || isCustomerAccepted)
      ? '<button class="btn-ok" type="button" onclick="OWN.toggleApprove(\'' + q.quoteId + '\')">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Approve &amp; Price' +
        '</button>'
      : '';

    var reviseBtn = isPending
      ? '<button class="btn-modify" type="button" onclick="OWN.toggleModify(\'' + q.quoteId + '\')">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Send Revised Quote' +
        '</button>'
      : '';

    /* Awaiting cards get an info note instead of revise btn */
    var awaitingNote = isRevised
      ? '<div class="ocard-notes" style="margin-bottom:0;color:var(--muted2);font-size:12.5px;">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          'Waiting for the customer to accept or reject the revision.' +
        '</div>'
      : '';

    return (
      '<div class="ocard" data-qid="' + q.quoteId + '">' +
        topBanner +
        '<div class="ocard-top">' +
          '<div><div class="ocard-id">' + EGC.esc(q.quoteId) + '</div><div class="ocard-when">' + when + '</div></div>' +
          statusBadge +
        '</div>' +
        '<div class="ocard-route">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3 3 0 003-3v-2a3 3 0 00-3-3H9a3 3 0 01-3-3V6.5"/></svg>' +
          '<span>' + EGC.esc(q.pickup) + ' &rarr; ' + EGC.esc(q.delivery) + '</span>' +
        '</div>' +
        '<div class="ocard-grid">' +
          '<div class="ocard-field"><span>Customer</span><strong>' + EGC.esc(q.customerName) + '</strong></div>' +
          (q.shipmentType === 'personal'
            ? '<div class="ocard-field"><span>Receiver</span><strong>' + EGC.esc(q.receiverName || '—') + '</strong></div>'
            : '<div class="ocard-field"><span>Consignor</span><strong>' + EGC.esc(q.companyName || '—') + '</strong></div>' +
              '<div class="ocard-field"><span>Consignee</span><strong>' + EGC.esc(q.consigneeName || '—') + '</strong></div>') +
          '<div class="ocard-field"><span>Weight</span><strong>' + EGC.esc(q.weight) + ' kg</strong></div>' +
          '<div class="ocard-field"><span>Packages</span><strong>' + EGC.esc(q.packages) + '</strong></div>' +
          '<div class="ocard-field"><span>Material</span><strong>' + EGC.esc(q.materialType) + '</strong></div>' +
          '<div class="ocard-field"><span>Pickup Date</span><strong>' + EGC.fmtDate(q.pickupDate) + '</strong></div>' +
          '<div class="ocard-field"><span>Phone</span><strong>' + EGC.esc(q.customerPhone || '—') + '</strong></div>' +
          '<div class="ocard-field"><span>Email</span><strong>' + EGC.esc(q.customerEmail || '—') + '</strong></div>' +
          (q.revisedPrice ? '<div class="ocard-field"><span>Revised Price</span><strong style="color:var(--amber);">&#8377;' + EGC.esc(q.revisedPrice) + '</strong></div>' : '') +
        '</div>' +
        (q.notes ? '<div class="ocard-notes"><strong>Notes:</strong> ' + EGC.esc(q.notes) + '</div>' : '') +
        (q.ownerComment ? '<div class="ocard-notes revision-comment"><strong>Your revision note:</strong> ' + EGC.esc(q.ownerComment) + '</div>' : '') +
        awaitingNote +
        '<div class="ocard-actions">' +
          approveBtn +
          reviseBtn +
          '<button class="btn-danger" type="button" onclick="OWN.toggleReject(\'' + q.quoteId + '\')">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Reject' +
          '</button>' +
        '</div>' +

        /* APPROVE & PRICE PANEL — price is REQUIRED before documents are
           generated. Prevents zero-value invoice/LR being created. */
        '<div class="modify-panel" id="approve-' + q.quoteId + '">' +
          '<div class="modify-panel-header" style="color:var(--green,#39d98a);">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="15" height="15"><polyline points="20 6 9 17 4 12"/></svg>' +
            'Approve &amp; Generate Documents' +
          '</div>' +
          '<div class="sf-fd">' +
            '<label style="font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:6px;">Freight Price (\u20B9) \u2014 required</label>' +
            '<input type="number" min="1" step="1" id="aPrice-' + q.quoteId + '" value="' + EGC.esc(q.revisedPrice || '') + '" placeholder="Enter agreed freight amount">' +
          '</div>' +
          '<div class="ocard-notes" style="margin:10px 0 0;color:var(--muted2);font-size:12px;">' +
            'On approve, an Order, Invoice and Lorry Receipt will be generated automatically with this freight. Additional charges (FOV, labour, GST, etc.) can be added afterwards in Manage Shipment.' +
          '</div>' +
          '<div class="ocard-actions" style="margin-top:12px;">' +
            '<button class="btn-ok btn-sm" type="button" onclick="OWN.approve(\'' + q.quoteId + '\')">Confirm &amp; Generate</button>' +
            '<button class="btn-ghost btn-sm" type="button" onclick="OWN.toggleApprove(\'' + q.quoteId + '\')">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div class="modify-panel" id="modify-' + q.quoteId + '">' +
          '<div class="modify-panel-header">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
            'Send Revised Quote to Customer' +
          '</div>' +
          '<div class="modify-grid">' +
            '<input type="text" id="mPickup-' + q.quoteId + '" value="' + EGC.esc(q.pickup) + '" placeholder="Pickup location">' +
            '<input type="text" id="mDelivery-' + q.quoteId + '" value="' + EGC.esc(q.delivery) + '" placeholder="Delivery location">' +
            '<input type="text" id="mWeight-' + q.quoteId + '" value="' + EGC.esc(q.weight) + '" placeholder="Weight (kg)">' +
            '<input type="text" id="mPackages-' + q.quoteId + '" value="' + EGC.esc(q.packages) + '" placeholder="Number of packages">' +
            '<input type="text" id="mPickupDate-' + q.quoteId + '" value="' + EGC.esc(q.pickupDate || '') + '" placeholder="Pickup date">' +
            '<input type="text" id="mPrice-' + q.quoteId + '" value="' + EGC.esc(q.revisedPrice || '') + '" placeholder="Revised price (\u20B9) \u2014 optional">' +
          '</div>' +
          '<div class="sf-fd" style="margin-top:12px;">' +
            '<label style="font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:6px;">Note / explanation to customer</label>' +
            '<textarea id="mComment-' + q.quoteId + '" placeholder="e.g. Route adjusted for weight limit. Revised price reflects fuel surcharge.">' + EGC.esc(q.ownerComment || '') + '</textarea>' +
          '</div>' +
          '<div class="modify-notes"><textarea id="mNotes-' + q.quoteId + '" placeholder="Shipment notes (optional)">' + EGC.esc(q.notes || '') + '</textarea></div>' +
          '<div class="ocard-actions">' +
            '<button class="btn-ok btn-sm" type="button" onclick="OWN.sendRevision(\'' + q.quoteId + '\')">Send to Customer</button>' +
            '<button class="btn-ghost btn-sm" type="button" onclick="OWN.toggleModify(\'' + q.quoteId + '\')">Cancel</button>' +
          '</div>' +
        '</div>' +

        /* REJECT PANEL */
        '<div class="modify-panel" id="reject-' + q.quoteId + '">' +
          '<div class="modify-panel-header" style="color:#ff7070;">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            'Reject Quote' +
          '</div>' +
          '<div class="sf-fd"><label style="font-family:\'IBM Plex Mono\';font-size:10px;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;display:block;margin-bottom:6px;">Note to customer (optional)</label>' +
            '<textarea id="rNote-' + q.quoteId + '" placeholder="e.g. Route currently unavailable, please call us to discuss alternatives."></textarea>' +
          '</div>' +
          '<div class="ocard-actions">' +
            '<button class="btn-danger btn-sm" type="button" onclick="OWN.confirmReject(\'' + q.quoteId + '\')">Confirm Rejection</button>' +
            '<button class="btn-ghost btn-sm" type="button" onclick="OWN.toggleReject(\'' + q.quoteId + '\')">Cancel</button>' +
          '</div>' +
        '</div>' +

        '<div class="fst" id="qmsg-' + q.quoteId + '"></div>' +
      '</div>'
    );
  }

  /* ---------------------------------------------------------
     Merge + render pending sections
  --------------------------------------------------------- */
  function mergePendingAndRevised() {
    var all = pendingQuotesData.concat(revisedQuotesData);
    all.sort(function (a, b) {
      var at = (a.createdAt && a.createdAt.toDate) ? a.createdAt.toDate().getTime() : 0;
      var bt = (b.createdAt && b.createdAt.toDate) ? b.createdAt.toDate().getTime() : 0;
      return bt - at;
    });

    var actionRequired = all.filter(function (q) {
      return q.status === EGC.QUOTE_STATUS.PENDING || q.status === EGC.QUOTE_STATUS.CUSTOMER_ACCEPTED;
    });
    var awaitingCustomer = all.filter(function (q) {
      return q.status === EGC.QUOTE_STATUS.REVISED;
    });

    var pendingCount  = actionRequired.length;
    var revisedCount  = awaitingCustomer.length;
    var totalCount    = pendingCount + revisedCount;

    var pendingEl    = $('#statPending');
    var tabCountEl   = $('#pendingTabCount');
    var awaitingBadge = $('#awaitingCount');
    if (pendingEl)    pendingEl.textContent    = String(pendingCount);
    if (tabCountEl)   tabCountEl.textContent   = String(totalCount);
    if (awaitingBadge) awaitingBadge.textContent = String(revisedCount);

    renderPendingSection(actionRequired, 'actionList',   pendingCount);
    renderPendingSection(awaitingCustomer, 'awaitingList', revisedCount);

    var awaitingHeader = $('#awaitingCustomerSection');
    if (awaitingHeader) awaitingHeader.style.display = revisedCount ? 'block' : 'none';
  }

  function renderPendingSection(quotes, listId, count) {
    var list = $('#' + listId);
    if (!list) return;
    if (!count) {
      if (listId === 'actionList') {
        list.innerHTML = (
          '<div class="empty">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            '<p>No pending quotes. New customer requests will appear here instantly.</p>' +
          '</div>'
        );
      } else {
        list.innerHTML = '';
      }
      return;
    }
    list.innerHTML = quotes.map(pendingCardHTML).join('');
  }

  function loadPendingQuotes() {
    if (pendingUnsub) { pendingUnsub(); pendingUnsub = null; }
    pendingUnsub = fbDB.collection('quotes')
      .where('status', '==', 'pending_review')
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        pendingQuotesData = [];
        snap.forEach(function (doc) {
          var d = doc.data();
          pendingCache[d.quoteId] = d;
          pendingQuotesData.push(d);
        });
        mergePendingAndRevised();
      }, function (err) {
        console.error('[OWN] pending listener:', err.code, err.message);
        var list = $('#actionList');
        if (list) list.innerHTML = (
          '<div class="empty"><p style="color:#ff7070;">Could not load pending quotes.<br><small>' + err.message + '</small></p>' +
          '<p style="margin-top:12px;font-size:13px;">Check Firestore indexes.</p></div>'
        );
      });
  }

  function loadRevisedQuotes() {
    if (revisedUnsub) { revisedUnsub(); revisedUnsub = null; }
    revisedUnsub = fbDB.collection('quotes')
      .where('status', 'in', ['revised_by_owner', 'customer_accepted'])
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        revisedQuotesData = [];
        snap.forEach(function (doc) {
          var d = doc.data();
          pendingCache[d.quoteId] = d;
          revisedQuotesData.push(d);
        });
        mergePendingAndRevised();
      }, function (err) {
        console.error('[OWN] revised listener:', err.code, err.message);
      });
  }

  /* ---------------------------------------------------------
     TOGGLE PANELS
  --------------------------------------------------------- */
  window.OWN = window.OWN || {};

  window.OWN.toggleApprove = function (qid) {
    var panel = $('#approve-' + qid);
    var modifyPanel = $('#modify-' + qid);
    var rejectPanel = $('#reject-' + qid);
    if (modifyPanel) modifyPanel.classList.remove('open');
    if (rejectPanel) rejectPanel.classList.remove('open');
    if (panel) {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        var inp = $('#aPrice-' + qid);
        if (inp) { inp.focus(); inp.select(); }
      }
    }
  };

  window.OWN.toggleModify = function (qid) {
    var panel = $('#modify-' + qid);
    var rejectPanel = $('#reject-' + qid);
    var approvePanel = $('#approve-' + qid);
    if (rejectPanel) rejectPanel.classList.remove('open');
    if (approvePanel) approvePanel.classList.remove('open');
    if (panel) panel.classList.toggle('open');
  };

  window.OWN.toggleReject = function (qid) {
    var panel = $('#reject-' + qid);
    var modifyPanel = $('#modify-' + qid);
    var approvePanel = $('#approve-' + qid);
    if (modifyPanel) modifyPanel.classList.remove('open');
    if (approvePanel) approvePanel.classList.remove('open');
    if (panel) panel.classList.toggle('open');
  };

  /* =========================================================================
     SHARED ORDER ENGINE  (Phase 6)
     ----------------------------------------------------------------------
     ONE pipeline that turns a finished order object into the full set of
     downstream records + side-effects. BOTH the customer-quote approval
     path and the owner Manual Order path call this, so the two converge on
     an identical Order → Invoice → LR → Accounting → Ledger → Outstanding →
     Reports → Excel → Audit → Notifications result. There is no second
     implementation to drift.

     Inputs:
       orderData : a fully-built order (from SHIP.buildOrder). Must already
                   have orderId/invoiceId/lrNumber set and status APPROVED.
       ids       : { orderId, invoiceId, lrNumber, docketNo }
       ctx       : {
                     quoteRef           : (optional) DocumentReference of the
                                          quote to flip to APPROVED in the SAME
                                          transaction (quote path only),
                     expectFreshStatus  : (optional) guard – throw if the quote
                                          is already approved (quote path),
                     freight            : freight figure for audit text,
                     notify             : bool – send customer notification +
                                          activity (only when a real customerUid
                                          exists; phone customers have none),
                     onAudit            : 'quote' | 'manual' – which audit lines,
                     advanceForReceipt  : number – advance to auto-post as a
                                          receipt (defaults to order's advance)
                   }
     Returns a Promise resolving to orderId.

     The transaction writes order + invoice + LR atomically (and flips the
     quote when present). Audit / notification / accounting are reliable
     post-commit follow-ups (B3) — never block the result, never silently
     vanish, idempotent so retries can't double-post.
  ========================================================================= */
  window.OWN.runOrderPipeline = function (orderData, ids, ctx) {
    ctx = ctx || {};
    var orderId   = ids.orderId;
    var invoiceId = ids.invoiceId;
    var lrNumber  = ids.lrNumber;
    var docketNo  = ids.docketNo;
    var now = new Date();
    var due = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

    var invoiceRecord = {
      invoiceId:     invoiceId,
      invoiceNumber: invoiceId,
      orderId:       orderId,
      quoteId:       orderData.quoteId || null,
      lrNumber:      lrNumber,
      customerUid:   orderData.customerUid || null,
      invoiceDate:   firebase.firestore.Timestamp.fromDate(now),
      dueDate:       firebase.firestore.Timestamp.fromDate(due),
      createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:     firebase.firestore.FieldValue.serverTimestamp()
    };
    var lrRecord = {
      lrNumber:     lrNumber,
      docketNumber: docketNo,
      orderId:      orderId,
      quoteId:      orderData.quoteId || null,
      invoiceId:    invoiceId,
      customerUid:  orderData.customerUid || null,
      lrDate:       firebase.firestore.Timestamp.fromDate(now),
      createdAt:    firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp()
    };

    var commit;
    if (ctx.quoteRef) {
      /* Quote path: re-read the quote INSIDE the transaction and abort if it
         was already approved, so no duplicate/orphan order can be created. */
      commit = fbDB.runTransaction(function (tx) {
        return tx.get(ctx.quoteRef).then(function (snap) {
          if (!snap.exists) throw new Error('Quote no longer exists.');
          var fresh = snap.data();
          if (fresh.status === EGC.QUOTE_STATUS.APPROVED || fresh.orderId) throw new Error('ALREADY_APPROVED');
          if (fresh.status === EGC.QUOTE_STATUS.REVISED) throw new Error('Cannot approve — waiting for the customer to accept the revision.');
          tx.set(fbDB.collection('orders').doc(orderId), orderData);
          tx.set(fbDB.collection('invoices').doc(invoiceId), invoiceRecord);
          tx.set(fbDB.collection('lorryReceipts').doc(lrNumber), lrRecord);
          tx.update(ctx.quoteRef, {
            status:    EGC.QUOTE_STATUS.APPROVED,
            orderId:   orderId,
            invoiceId: invoiceId,
            lrNumber:  lrNumber,
            freight:   ctx.freight,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
      });
    } else {
      /* Manual path: no quote to guard. The IDs are freshly allocated and
         unique, so a plain batched set cannot collide or duplicate. */
      var batch = fbDB.batch();
      batch.set(fbDB.collection('orders').doc(orderId), orderData);
      batch.set(fbDB.collection('invoices').doc(invoiceId), invoiceRecord);
      batch.set(fbDB.collection('lorryReceipts').doc(lrNumber), lrRecord);
      commit = batch.commit();
    }

    return commit.then(function () {
      /* Prime the SSoT cache so the just-created order renders instantly. */
      if (SHIP.primeOrder) SHIP.primeOrder(orderData);
      var amount = SHIP.computeCharges(orderData).grandTotal;
      var route  = (orderData.pickup || '') + ' \u2192 ' + (orderData.delivery || '');

      /* Notifications + activity — only when a real customer account exists.
         Owner manual phone orders have no customerUid, so we skip those (an
         unreadable notification would just be noise) but still audit fully. */
      if (ctx.notify && orderData.customerUid) {
        var notifMsg = 'Your ' + (ctx.onAudit === 'manual' ? 'order' : 'quote ' + (orderData.quoteId || '')) +
          ' has been ' + (ctx.onAudit === 'manual' ? 'created' : 'approved') +
          '. Order ' + orderId + ' created with invoice ' + invoiceId + ' and Lorry Receipt ' + lrNumber + '.';
        EGC.reliableNotify(orderData.customerUid, 'order_created', notifMsg,
          { quoteId: orderData.quoteId || null, orderId: orderId, invoiceId: invoiceId, lrNumber: lrNumber });
        EGC.reliableActivity(orderData.customerUid, 'order_created',
          'Order ' + orderId + ' created for ' + route, { quoteId: orderData.quoteId || null, orderId: orderId });
        EGC.reliableAudit('notification_sent', notifMsg,
          { targetType: 'notification', targetId: orderData.customerUid, orderId: orderId, quoteId: orderData.quoteId || null, newValue: 'order_created' });
      }

      /* Audit trail — always written (owner-readable). */
      if (ctx.onAudit === 'manual') {
        EGC.reliableAudit('order_created', 'Manual order ' + orderId + ' created by owner (phone booking).', {
          targetType: 'order', targetId: orderId, orderId: orderId,
          previousValue: null, newValue: orderId
        });
      } else {
        EGC.reliableAudit('quote_accepted', 'Quote ' + (orderData.quoteId || '') + ' approved by owner at \u20B9' + ctx.freight + ' freight.', {
          targetType: 'quote', targetId: orderData.quoteId || '', quoteId: orderData.quoteId || '',
          previousValue: ctx.previousQuoteStatus || null, newValue: 'approved'
        });
        EGC.reliableAudit('order_created', 'Order ' + orderId + ' created from quote ' + (orderData.quoteId || '') + '.', {
          targetType: 'order', targetId: orderId, orderId: orderId, quoteId: orderData.quoteId || null,
          previousValue: null, newValue: orderId
        });
      }
      EGC.reliableAudit('invoice_generated', 'Invoice ' + invoiceId + ' (' + lrNumber + ') generated for order ' + orderId + '.', {
        targetType: 'invoice', targetId: invoiceId, orderId: orderId, quoteId: orderData.quoteId || null,
        previousValue: null, newValue: { invoiceId: invoiceId, lrNumber: lrNumber, amount: amount }
      });
      EGC.reliableAudit('lr_generated', 'Lorry Receipt ' + lrNumber + ' generated for order ' + orderId + '.', {
        targetType: 'lorryReceipt', targetId: lrNumber, orderId: orderId, quoteId: orderData.quoteId || null,
        previousValue: null, newValue: { lrNumber: lrNumber, docketNumber: docketNo }
      });

      /* ── AUTOMATIC ACCOUNTING ──
         Post the Sales journal entry from the order (SSoT) and, if money was
         already received (advance and/or part-payment), a Receipt entry for
         that total. The customer ledger / outstanding / reports all derive
         from these. Reliable + idempotent. */
      if (window.ACC && ACC.autoPostSales) {
        EGC.reliable(function () {
          return ACC.loadSettings().then(function () {
            return ACC.autoPostSales(orderData).then(function () {
              var ch = SHIP.computeCharges(orderData);
              var paid = (ctx.advanceForReceipt != null) ? ctx.advanceForReceipt : (ch.advance + ch.received);
              if (paid > 0) return ACC.autoPostReceipt(orderData, paid, ctx.paymentMode || 'bank');
            });
          });
        }, { label: 'autopost:sales:' + orderId,
             persist: { kind: 'audit', args: { action: 'autopost_pending', summary: 'Auto-post sales pending for ' + orderId, details: { orderId: orderId } } } });
      }
      return orderId;
    });
  };

  /* ---------------------------------------------------------
     APPROVE — validates a required freight price, then creates
     order + invoice + LR + notifications + audit. Guarded against
     double-submit and re-approval so documents are never duplicated
     and never generated with a zero price.
  --------------------------------------------------------- */
  var _approving = {};   /* in-flight lock keyed by quoteId */

  window.OWN.approve = function (qid) {
    var msg = $('#qmsg-' + qid);
    var q = pendingCache[qid];
    if (!q) { return; }

    /* Guard A: block double-submit while a prior approval is in flight. */
    if (_approving[qid]) { return; }

    /* Guard B: only pending_review or customer_accepted can be approved. */
    if (q.status === EGC.QUOTE_STATUS.REVISED) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'Cannot approve yet — waiting for customer to accept the revision first.'; }
      return;
    }
    if (q.status === EGC.QUOTE_STATUS.APPROVED) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'This quote has already been approved.'; }
      return;
    }

    /* Guard C: freight price is REQUIRED — no zero-value documents. */
    var priceEl = $('#aPrice-' + qid);
    var freight = INV.toNum(priceEl ? priceEl.value : (q.revisedPrice || 0));
    if (!(freight > 0)) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'Enter a freight price greater than \u20B90 before approving.'; }
      var apOpen = $('#approve-' + qid);
      if (apOpen && !apOpen.classList.contains('open')) apOpen.classList.add('open');
      if (priceEl) priceEl.focus();
      return;
    }

    _approving[qid] = true;
    var confirmBtn = $('#approve-' + qid) ? $('#approve-' + qid).querySelector('.btn-ok') : null;
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Generating\u2026'; }

    Promise.all([EGC.nextOrderId(), EGC.nextInvoiceId(), INV.nextLrNumber(), LR.nextDocketNumber()]).then(function (ids) {
      /* IDs are allocated before the transaction. If the transaction aborts
         (rare race: quote already approved), the numbers are consumed but
         unused, leaving a GAP — acceptable and auditable. A DUPLICATE number
         would not be. We deliberately prefer a gap over a duplicate. */
      var allocated = { orderId: ids[0], invoiceId: ids[1], lrNumber: ids[2], docketNo: ids[3] };

      /* Build the canonical ORDER from FRESH quote data (SSoT). We re-read
         the quote inside the pipeline transaction, but build the order from
         the freshest data we hold here; the pipeline's in-transaction guard
         still aborts on an already-approved quote, so this can't bake stale
         data into a duplicate. */
      var orderData = SHIP.buildOrder({
        orderId:   allocated.orderId,
        quoteId:   q.quoteId || qid,
        invoiceId: allocated.invoiceId,
        lrNumber:  allocated.lrNumber,
        quote:     q,
        pricing:   { freight: freight }
      });
      orderData.status           = EGC.ORDER_STATUS.APPROVED;
      orderData.invoiceGenerated = true;
      orderData.lrGenerated      = true;

      return window.OWN.runOrderPipeline(orderData, allocated, {
        quoteRef:           fbDB.collection('quotes').doc(qid),
        freight:            freight,
        previousQuoteStatus: q.status,
        notify:             true,
        onAudit:            'quote'
      });
    }).then(function (orderId) {
      if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Approved \u2014 Order ' + orderId + ' created with invoice \u20B9' + freight + ' freight.'; }
      toast(true, q.quoteId + ' approved \u2192 ' + orderId);
      var ap = $('#approve-' + qid); if (ap) ap.classList.remove('open');
    }).catch(function (err) {
      if (err && err.message === 'ALREADY_APPROVED') {
        if (msg) { msg.className = 'fst er'; msg.textContent = 'This quote was already approved (no duplicate documents were created).'; }
        toast(false, qid + ' was already approved');
      } else {
        if (msg) { msg.className = 'fst er'; msg.textContent = (err && err.message) || 'Could not approve quote.'; }
        toast(false, 'Approval failed for ' + qid);
      }
    }).finally(function () {
      _approving[qid] = false;
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm & Generate'; }
    });
  };

  /* ---------------------------------------------------------
     SEND REVISED QUOTE → status: revised_by_owner
     Only for pending_review quotes
  --------------------------------------------------------- */
  window.OWN.sendRevision = function (qid) {
    var msg       = $('#qmsg-' + qid);
    var pickup    = $('#mPickup-'    + qid) ? $('#mPickup-'    + qid).value.trim() : '';
    var delivery  = $('#mDelivery-'  + qid) ? $('#mDelivery-'  + qid).value.trim() : '';
    var weight    = $('#mWeight-'    + qid) ? $('#mWeight-'    + qid).value.trim() : '';
    var packages  = $('#mPackages-'  + qid) ? $('#mPackages-'  + qid).value.trim() : '';
    var pickupDate= $('#mPickupDate-'+ qid) ? $('#mPickupDate-'+ qid).value.trim() : '';
    var price     = $('#mPrice-'     + qid) ? $('#mPrice-'     + qid).value.trim() : '';
    var comment   = $('#mComment-'   + qid) ? $('#mComment-'   + qid).value.trim() : '';
    var notes     = $('#mNotes-'     + qid) ? $('#mNotes-'     + qid).value.trim() : '';

    if (!pickup || !delivery) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'Pickup and delivery are required.'; }
      return;
    }

    var q = pendingCache[qid];
    if (!q) { return; }

    /* Only allow revision if status is pending_review */
    if (q.status !== EGC.QUOTE_STATUS.PENDING) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'Revision can only be sent for pending quotes.'; }
      return;
    }

    var updates = {
      status:       EGC.QUOTE_STATUS.REVISED,
      pickup:       pickup,
      delivery:     delivery,
      weight:       weight,
      packages:     packages,
      pickupDate:   pickupDate || null,
      revisedPrice: price || null,
      ownerComment: comment || null,
      notes:        notes || null,
      revisedAt:    firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:    firebase.firestore.FieldValue.serverTimestamp(),

      /* Preserve the customer's original request so the dashboard can
         show an Original → Revised comparison. Additive only — does
         not change any existing field or behavior. */
      originalPickup:     q.pickup,
      originalDelivery:   q.delivery,
      originalWeight:     q.weight,
      originalPackages:   q.packages,
      originalPickupDate: q.pickupDate || null
    };

    fbDB.collection('quotes').doc(qid).update(updates)
      .then(function () {
        var panel = $('#modify-' + qid);
        if (panel) panel.classList.remove('open');
        if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Revised quote sent to customer. Waiting for their response.'; }
        toast(true, qid + ' \u2014 revision sent to customer');

        /* Notification to customer */
        var notifMsg = 'Your quote ' + qid + ' has been revised by the team. Please review and accept or reject the revision.';
        EGC.createNotification(q.customerUid, 'quote_revised', notifMsg, { quoteId: qid });
        EGC.logActivity(q.customerUid, 'quote_revised',
          'Quote ' + qid + ' was revised: ' + pickup + ' \u2192 ' + delivery,
          { quoteId: qid });

        /* Audit trail */
        EGC.logAudit('quote_revised',
          'Quote ' + qid + ' revised: ' + q.pickup + ' \u2192 ' + q.delivery + ' became ' + pickup + ' \u2192 ' + delivery + '.',
          {
            targetType: 'quote', targetId: qid, quoteId: qid,
            previousValue: { pickup: q.pickup, delivery: q.delivery, weight: q.weight, packages: q.packages, price: q.revisedPrice || null },
            newValue:      { pickup: pickup, delivery: delivery, weight: weight, packages: packages, price: price || null }
          });
      })
      .catch(function (err) {
        if (msg) { msg.className = 'fst er'; msg.textContent = err.message || 'Could not send revision.'; }
      });
  };

  /* ---------------------------------------------------------
     REJECT QUOTE
  --------------------------------------------------------- */
  window.OWN.confirmReject = function (qid) {
    var msg  = $('#qmsg-' + qid);
    var note = $('#rNote-' + qid) ? ($('#rNote-' + qid).value.trim() || null) : null;
    var q    = pendingCache[qid];

    fbDB.collection('quotes').doc(qid).update({
      status:    EGC.QUOTE_STATUS.REJECTED,
      ownerNote: note,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Quote rejected.'; }
      toast(true, qid + ' rejected.');

      if (q) {
        var notifMsg = 'Your quote ' + qid + ' has been rejected.' + (note ? ' Note: ' + note : '');
        EGC.createNotification(q.customerUid, 'quote_rejected', notifMsg, { quoteId: qid, ownerNote: note });
        EGC.logActivity(q.customerUid, 'quote_rejected',
          'Quote ' + qid + ' was rejected' + (note ? ': ' + note : ''),
          { quoteId: qid });
        EGC.logAudit('quote_rejected', 'Quote ' + qid + ' rejected by owner.' + (note ? ' Note: ' + note : ''), {
          targetType: 'quote', targetId: qid, quoteId: qid,
          previousValue: q.status, newValue: 'rejected'
        });
      }
    }).catch(function (err) {
      if (msg) { msg.className = 'fst er'; msg.textContent = err.message || 'Could not reject quote.'; }
    });
  };

  /* ===========================================================
     ORDERS PANEL
  =========================================================== */
  var ordersUnsub       = null;
  var ownerOrdersCache  = [];
  var orderFilter       = 'all';

  function statusOptionsHTML(current) {
    return EGC.ORDER_STATUS_SEQUENCE.map(function (s) {
      return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + EGC.orderStatusLabel(s) + '</option>';
    }).join('');
  }

  function ownerOrderCardHTML(o) {
    var badge    = '<span class="st-badge ' + EGC.orderStatusClass(o.status) + '"><span class="st-dot"></span>' + EGC.orderStatusLabel(o.status) + '</span>';
    var priceRow = o.revisedPrice
      ? '<div class="ocard-field"><span>Revised Price</span><strong style="color:var(--amber);">&#8377;' + EGC.esc(o.revisedPrice) + '</strong></div>'
      : '';
    /* Delivered but still unpaid? Surface it persistently so the owner never
       forgets to collect — the classic transport cash-flow leak. One click goes
       straight to Record Payment (prefilled). Shown only when truly outstanding. */
    var collectBand = '';
    if (o.status === 'delivered' && o.invoiceId) {
      try {
        var cc = SHIP.computeCharges(o);
        if (cc && cc.outstanding > 0) {
          collectBand = '<div class="ocard-collect">' +
            '<span>Delivered \u2014 \u20B9' + INV.fmtMoney(cc.outstanding) + ' still to collect</span>' +
            '<button class="btn-a btn-sm" type="button" onclick="OWN.recordPayment(\'' + o.invoiceId + '\')">Record payment</button>' +
            '</div>';
        }
      } catch (e) { /* non-blocking */ }
    }
    return (
      '<div class="ocard">' +
        '<div class="ocard-top">' +
          '<div><div class="ocard-id">' + EGC.esc(o.orderId) + '</div><div class="ocard-when">' + EGC.fmtWhen(o.createdAt) + ' &middot; from ' + EGC.esc(o.quoteId || '') + '</div></div>' +
          badge +
        '</div>' +
        '<div class="ocard-route">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3 3 0 003-3v-2a3 3 0 00-3-3H9a3 3 0 01-3-3V6.5"/></svg>' +
          '<span>' + EGC.esc(o.pickup) + ' &rarr; ' + EGC.esc(o.delivery) + '</span>' +
        '</div>' +
        collectBand +
        '<div class="ocard-grid">' +
          '<div class="ocard-field"><span>Customer</span><strong>' + EGC.esc(o.customerName) + '</strong></div>' +
          (o.shipmentType === 'personal'
            ? '<div class="ocard-field"><span>Receiver</span><strong>' + EGC.esc(o.consigneeName || '—') + '</strong></div>'
            : '<div class="ocard-field"><span>Consignor</span><strong>' + EGC.esc(o.consignorName || o.companyName || '—') + '</strong></div>' +
              '<div class="ocard-field"><span>Consignee</span><strong>' + EGC.esc(o.consigneeName || '—') + '</strong></div>') +
          '<div class="ocard-field"><span>Weight</span><strong>' + EGC.esc(o.weight) + ' kg</strong></div>' +
          '<div class="ocard-field"><span>Packages</span><strong>' + EGC.esc(o.packages) + '</strong></div>' +
          priceRow +
        '</div>' +
        '<div class="ocard-actions" style="align-items:center;">' +
          '<select class="ostatus-select" id="ostat-' + o.orderId + '" onchange="OWN.updateOrderStatus(\'' + o.orderId + '\')">' +
            statusOptionsHTML(o.status) +
          '</select>' +
          '<button class="btn-timeline btn-sm" type="button" onclick="OWN.openOrderTimeline(\'' + o.orderId + '\')" title="View full order timeline">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Timeline</button>' +
          (o.invoiceGenerated
            ? '<span class="st-badge st-ok" style="margin-left:auto;"><span class="st-dot"></span>Invoice Generated</span>'
            : '<span class="st-badge st-pending" style="margin-left:auto;"><span class="st-dot"></span>Invoice Pending</span>') +
        '</div>' +
        '<div class="fst" id="omsg-' + o.orderId + '"></div>' +
      '</div>'
    );
  }

  function renderOwnerOrders() {
    var list = $('#ownerOrderList');
    if (!list) return;
    var filtered = orderFilter === 'all'
      ? ownerOrdersCache
      : ownerOrdersCache.filter(function (o) { return o.status === orderFilter; });

    if (!filtered.length) {
      var firstRun = (orderFilter === 'all');
      list.innerHTML = (
        '<div class="empty">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="6" width="14" height="10"/><path d="M15 9h4l3 3v4h-7"/></svg>' +
          (firstRun
            ? '<p>No orders yet. When a customer calls with a booking, create it here \u2014 the invoice, Lorry Receipt and accounting entries are generated automatically.</p>' +
              '<button class="btn-a" type="button" onclick="OWN.openManualOrder()" style="margin:0 auto;">' +
                '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
                'Create your first order</button>'
            : '<p>No orders with this status.</p>') +
        '</div>'
      );
      return;
    }
    list.innerHTML = filtered.map(ownerOrderCardHTML).join('');
  }

  $all('#orderFilterChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $all('#orderFilterChips .chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      orderFilter = chip.dataset.filter;
      renderOwnerOrders();
    });
  });

  function loadOwnerOrders() {
    if (ordersUnsub) { ordersUnsub(); ordersUnsub = null; }
    ordersUnsub = fbDB.collection('orders')
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var orders = [];
        snap.forEach(function (doc) {
          var o = doc.data();
          orders.push(o);
          /* Keep the SSoT cache hot so document projections render instantly
             and always reflect the latest order edits. */
          if (window.SHIP) SHIP.primeOrder(o);
        });
        ownerOrdersCache = orders;

        var delivered = orders.filter(function (o) { return o.status === 'delivered'; }).length;
        var active    = orders.length - delivered;
        $('#statApproved').textContent  = String(orders.length);
        $('#statOrders').textContent    = String(active);
        $('#statDelivered').textContent = String(delivered);

        renderOwnerOrders();
        /* Orders are the SSoT — when one changes, the invoice and LR cards
           (which project from it) must re-render too. */
        if (typeof renderInvoices === 'function') renderInvoices();
        if (typeof renderLorryReceipts === 'function') renderLorryReceipts();
      }, function (err) {
        console.error('[OWN] orders listener:', err.message);
      });
  }

  window.OWN.updateOrderStatus = function (orderId) {
    var sel = $('#ostat-' + orderId);
    var msg = $('#omsg-' + orderId);
    if (!sel) return;

    /* Find the order to get customerUid */
    var order = ownerOrdersCache.filter(function (o) { return o.orderId === orderId; })[0];
    var previousStatus = order ? order.status : null;

    fbDB.collection('orders').doc(orderId).update({
      status:    sel.value,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () {
      if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Status updated to ' + EGC.orderStatusLabel(sel.value) + '.'; }
      toast(true, orderId + ' \u2192 ' + EGC.orderStatusLabel(sel.value));

      /* Notify customer of order status change — reliable follow-up (B3). */
      if (order) {
        var notifMsg = 'Order ' + orderId + ' status updated to: ' + EGC.orderStatusLabel(sel.value) + '.';
        EGC.reliableNotify(order.customerUid, 'order_status_update', notifMsg, { orderId: orderId, status: sel.value });
        EGC.reliableActivity(order.customerUid, 'order_status_update',
          'Order ' + orderId + ' is now ' + EGC.orderStatusLabel(sel.value),
          { orderId: orderId, status: sel.value });
        EGC.reliableAudit('notification_sent', notifMsg, { targetType: 'notification', targetId: order.customerUid, orderId: orderId, newValue: 'order_status_update' });
      }

      /* Audit trail — use specific action key for status so timeline icons work */
      var statusActionMap = {
        truck_assigned: 'truck_assigned',
        loading:        'loading_started',
        in_transit:     'in_transit',
        delivered:      'delivered'
      };
      var specificAction = statusActionMap[sel.value] || 'status_changed';
      EGC.reliableAudit(specificAction,
        'Order ' + orderId + ' status changed from ' + EGC.orderStatusLabel(previousStatus) + ' to ' + EGC.orderStatusLabel(sel.value) + '.',
        { targetType: 'order', targetId: orderId, orderId: orderId, previousValue: previousStatus, newValue: sel.value });

    }).catch(function (err) {
      if (msg) { msg.className = 'fst er'; msg.textContent = err.message || 'Could not update status.'; }
    });
  };

  /* ---------------------------------------------------------
     GENERATE INVOICE — DEPRECATED MANUAL PATH.
     Invoices + LRs are now created automatically at approval as
     thin SSoT documents (see OWN.approve). This older path built a
     FAT invoice record via INV.buildRecord and allocated an LR number
     WITHOUT creating an LR document — both of which break the single
     source of truth and can duplicate documents. It is intentionally
     disabled. The only legitimate remaining use is recovering an order
     that somehow has no invoice at all; that case is handled safely
     below by creating thin invoice + LR records (never duplicates).
  --------------------------------------------------------- */
  window.OWN.generateInvoice = function (orderId) {
    var msg   = $('#omsg-' + orderId);
    var order = ownerOrdersCache.filter(function (o) { return o.orderId === orderId; })[0];
    if (!order) return;

    /* Refuse if an invoice already exists — never create a duplicate. */
    if (order.invoiceGenerated || order.invoiceId) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'An invoice already exists for this order. Edit it in Manage Shipment instead.'; }
      return;
    }

    /* Safe recovery: create THIN invoice + LR records (SSoT), mirroring
       the approval flow, guarded by a transaction so it can't duplicate. */
    Promise.all([EGC.nextInvoiceId(), INV.nextLrNumber(), LR.nextDocketNumber()]).then(function (ids) {
      var invoiceId = ids[0];
      var lrNumber  = ids[1];
      var docketNo  = ids[2];
      var now = new Date();
      var due = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000);

      var invoiceRecord = {
        invoiceId: invoiceId, invoiceNumber: invoiceId, orderId: orderId,
        quoteId: order.quoteId || null, lrNumber: lrNumber, customerUid: order.customerUid,
        invoiceDate: firebase.firestore.Timestamp.fromDate(now),
        dueDate: firebase.firestore.Timestamp.fromDate(due),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      var lrRecord = {
        lrNumber: lrNumber, docketNumber: docketNo, orderId: orderId,
        quoteId: order.quoteId || null, invoiceId: invoiceId, customerUid: order.customerUid,
        lrDate: firebase.firestore.Timestamp.fromDate(now),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      var orderRef = fbDB.collection('orders').doc(orderId);
      return fbDB.runTransaction(function (tx) {
        return tx.get(orderRef).then(function (snap) {
          if (!snap.exists) throw new Error('Order no longer exists.');
          var cur = snap.data();
          if (cur.invoiceGenerated || cur.invoiceId) throw new Error('ALREADY_HAS_INVOICE');
          tx.set(fbDB.collection('invoices').doc(invoiceId), invoiceRecord);
          tx.set(fbDB.collection('lorryReceipts').doc(lrNumber), lrRecord);
          tx.update(orderRef, {
            invoiceGenerated: true, lrGenerated: true,
            invoiceId: invoiceId, lrNumber: lrNumber,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
      }).then(function () { return invoiceId; });
    }).then(function (invoiceId) {
      if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Invoice ' + invoiceId + ' and Lorry Receipt generated.'; }
      toast(true, 'Invoice ' + invoiceId + ' generated for ' + orderId);

      var notifMsg = 'Invoice ' + invoiceId + ' has been generated for order ' + orderId + '.';
      EGC.createNotification(order.customerUid, 'invoice_generated', notifMsg, { orderId: orderId, invoiceId: invoiceId });
      EGC.logActivity(order.customerUid, 'invoice_generated',
        'Invoice ' + invoiceId + ' generated for order ' + orderId, { orderId: orderId, invoiceId: invoiceId });
      EGC.logAudit('invoice_generated', 'Invoice ' + invoiceId + ' generated for order ' + orderId + '.', {
        targetType: 'invoice', targetId: invoiceId, orderId: orderId, quoteId: order.quoteId || null,
        previousValue: null, newValue: { invoiceId: invoiceId }
      });
    }).catch(function (err) {
      if (err && err.message === 'ALREADY_HAS_INVOICE') {
        if (msg) { msg.className = 'fst er'; msg.textContent = 'An invoice already exists for this order (no duplicate created).'; }
      } else if (msg) { msg.className = 'fst er'; msg.textContent = (err && err.message) || 'Could not generate invoice.'; }
    });
  };

  /* ===========================================================
     ALL QUOTES — full history
  =========================================================== */
  var allQuotesUnsub = null;

  function allQuoteRowHTML(q) {
    var badge = '<span class="st-badge ' + EGC.quoteStatusClass(q.status) + '"><span class="st-dot"></span>' + EGC.quoteStatusLabelOwner(q.status) + '</span>';
    var revisionRow = q.revisedPrice
      ? '<div class="qrow-meta" style="margin-top:4px;"><span style="color:var(--amber);">&#8377;' + EGC.esc(q.revisedPrice) + ' revised</span></div>'
      : '';
    return (
      '<div class="qrow" style="grid-template-columns:1fr;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">' +
          '<div>' +
            '<div class="qrow-id qrow-id-link" onclick="OWN.openQuoteTimeline(\'' + EGC.esc(q.quoteId) + '\')" title="View quote timeline">' + EGC.esc(q.quoteId) +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="margin-left:5px;vertical-align:-1px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div>' +
            '<div class="qrow-route">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3 3 0 003-3v-2a3 3 0 00-3-3H9a3 3 0 01-3-3V6.5"/></svg>' +
              '<span>' + EGC.esc(q.pickup) + ' &rarr; ' + EGC.esc(q.delivery) + '</span>' +
            '</div>' +
            '<div class="qrow-meta"><span>' + EGC.esc(q.customerName) + '</span><span>' + EGC.esc(q.companyName || '') + '</span></div>' +
            revisionRow +
          '</div>' +
          '<div class="qrow-right">' + badge + '<div class="qrow-date">' + EGC.fmtWhen(q.createdAt) + '</div></div>' +
        '</div>' +
      '</div>'
    );
  }

  function loadAllQuotes() {
    var list = $('#allQuotesList');
    if (allQuotesUnsub) { allQuotesUnsub(); allQuotesUnsub = null; }
    allQuotesUnsub = fbDB.collection('quotes')
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var quotes = [];
        snap.forEach(function (doc) { quotes.push(doc.data()); });
        if (!quotes.length) {
          if (list) list.innerHTML = '<div class="empty"><p>No quotes submitted yet.</p></div>';
          return;
        }
        if (list) list.innerHTML = quotes.map(allQuoteRowHTML).join('');
      }, function (err) {
        console.error('[OWN] all-quotes listener:', err.message);
      });
  }

  /* ===========================================================
     AUDIT LOGS — Phase 4 Upgraded
     - Entity-linked entries
     - Order & Quote specific timeline drawers
     - Checkbox multi-select + bulk export
     - Date range filter
     - PDF & Excel export (client-side, no deps)
  =========================================================== */
  var AUDIT_PAGE_SIZE   = 50;
  var auditLimitCount   = AUDIT_PAGE_SIZE;
  var auditUnsub        = null;
  var auditLogsCache    = [];
  var auditCategory     = 'all';
  var auditSearchTerm   = '';
  var auditDateFrom     = '';
  var auditDateTo       = '';
  var selectedAuditIds  = {};   /* { docId: entryObject } for export */

  var AUDIT_CATEGORY_MAP = {
    quote_submitted:   'quote',
    quote_revised:     'quote',
    quote_accepted:    'quote',
    quote_rejected:    'quote',
    order_created:     'order',
    status_changed:    'order',
    truck_assigned:    'order',
    loading_started:   'order',
    in_transit:        'order',
    delivered:         'order',
    notification_sent: 'notification',
    invoice_generated: 'invoice',
    payment_recorded:  'invoice'
  };

  var AUDIT_PILL_CLASS = {
    quote:        'apill-quote',
    order:        'apill-order',
    notification: 'apill-notif',
    invoice:      'apill-invoice'
  };

  function subscribeAuditLogs(limitCount) {
    if (auditUnsub) { auditUnsub(); auditUnsub = null; }
    auditUnsub = fbDB.collection('auditLogs')
      .orderBy('createdAt', 'desc')
      .limit(limitCount)
      .onSnapshot(function (snap) {
        var logs = [];
        snap.forEach(function (doc) { var d = doc.data(); d._docId = doc.id; logs.push(d); });
        auditLogsCache = logs;
        renderAuditLogs(snap.size >= limitCount);
      }, function (err) {
        console.error('[OWN] audit log listener:', err.code, err.message);
        var tbody = $('#auditLogBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><p style="color:#ff7070;">Could not load audit logs.<br><small>' + err.message + '</small></p></div></td></tr>';
      });
  }

  function loadAuditLogs() {
    auditLimitCount = AUDIT_PAGE_SIZE;
    subscribeAuditLogs(auditLimitCount);
  }

  window.OWN.loadMoreAudit = function () {
    var btn = $('#auditLoadMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading\u2026'; }
    auditLimitCount += AUDIT_PAGE_SIZE;
    subscribeAuditLogs(auditLimitCount);
  };

  $all('#auditFilterChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $all('#auditFilterChips .chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      auditCategory = chip.dataset.filter;
      selectedAuditIds = {};
      renderAuditLogs();
    });
  });

  var auditSearchInput = $('#auditSearch');
  if (auditSearchInput) {
    auditSearchInput.addEventListener('input', function () {
      auditSearchTerm = auditSearchInput.value.trim().toLowerCase();
      selectedAuditIds = {};
      renderAuditLogs();
    });
  }

  var auditDateFromEl = $('#auditDateFrom');
  var auditDateToEl   = $('#auditDateTo');
  if (auditDateFromEl) auditDateFromEl.addEventListener('change', function () { auditDateFrom = auditDateFromEl.value; selectedAuditIds = {}; renderAuditLogs(); });
  if (auditDateToEl)   auditDateToEl.addEventListener('change',   function () { auditDateTo   = auditDateToEl.value;   selectedAuditIds = {}; renderAuditLogs(); });

  window.OWN.clearAuditDates = function () {
    auditDateFrom = ''; auditDateTo = '';
    if (auditDateFromEl) auditDateFromEl.value = '';
    if (auditDateToEl)   auditDateToEl.value   = '';
    renderAuditLogs();
  };

  function fmtAuditTs(ts) {
    if (!ts || !ts.toDate) return '\u2014';
    var d = ts.toDate();
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function fmtAuditValue(v) {
    if (v == null) return '\u2014';
    if (typeof v === 'object') {
      try { return Object.keys(v).map(function (k) { return k + ': ' + v[k]; }).join(', '); }
      catch (e) { return JSON.stringify(v); }
    }
    return String(v);
  }

  function auditMatchesFilters(entry) {
    if (auditCategory !== 'all' && AUDIT_CATEGORY_MAP[entry.action] !== auditCategory) return false;
    if ((auditDateFrom || auditDateTo) && entry.createdAt && entry.createdAt.toDate) {
      var dStr = entry.createdAt.toDate().toISOString().slice(0, 10);
      if (auditDateFrom && dStr < auditDateFrom) return false;
      if (auditDateTo   && dStr > auditDateTo)   return false;
    }
    if (!auditSearchTerm) return true;
    var haystack = [
      entry.actionLabel, entry.action, entry.summary,
      entry.actorEmail, entry.actorRole,
      entry.targetId, entry.orderId, entry.quoteId,
      fmtAuditValue(entry.previousValue), fmtAuditValue(entry.newValue)
    ].join(' ').toLowerCase();
    return haystack.indexOf(auditSearchTerm) !== -1;
  }

  function auditEntityLink(entry) {
    if (entry.orderId) {
      return '<span class="audit-entity-link" onclick="OWN.openOrderTimeline(\'' + EGC.esc(entry.orderId) + '\')" title="View order timeline">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
        EGC.esc(entry.orderId) + '</span>';
    }
    if (entry.quoteId) {
      return '<span class="audit-entity-link aql" onclick="OWN.openQuoteTimeline(\'' + EGC.esc(entry.quoteId) + '\')" title="View quote timeline">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
        EGC.esc(entry.quoteId) + '</span>';
    }
    if (entry.targetId) return '<span class="audit-entity-plain"><span class="aep-type">' + EGC.esc(entry.targetType || '') + '</span>' + EGC.esc(entry.targetId) + '</span>';
    return '\u2014';
  }

  function auditRowHTML(entry) {
    var cat     = AUDIT_CATEGORY_MAP[entry.action] || 'order';
    var pillCls = AUDIT_PILL_CLASS[cat] || 'apill-order';
    var sel     = !!selectedAuditIds[entry._docId];
    var userHTML = '<div class="audit-user">' + EGC.esc(entry.actorRole || 'system') +
        '<span class="au-email">' + EGC.esc(entry.actorEmail || 'system') + '</span></div>';
    var diffHTML = (entry.previousValue != null || entry.newValue != null)
      ? '<span class="audit-diff">' + EGC.esc(fmtAuditValue(entry.previousValue)) + ' \u2192 ' + EGC.esc(fmtAuditValue(entry.newValue)) + '</span>'
      : '\u2014';
    return (
      '<tr class="audit-row' + (sel ? ' row-selected' : '') + '">' +
        '<td class="audit-check-cell"><input type="checkbox" class="audit-cb" data-id="' + EGC.esc(entry._docId) + '"' + (sel ? ' checked' : '') + ' onchange="OWN.toggleAuditSelect(this)"></td>' +
        '<td class="audit-when">' + fmtAuditTs(entry.createdAt) + '</td>' +
        '<td>' + userHTML + '</td>' +
        '<td><span class="audit-action-pill ' + pillCls + '">' + EGC.esc(entry.actionLabel || entry.action) + '</span></td>' +
        '<td>' + auditEntityLink(entry) + '</td>' +
        '<td>' + diffHTML + '</td>' +
        '<td class="audit-summary">' + EGC.esc(entry.summary || '\u2014') + '</td>' +
      '</tr>'
    );
  }

  function renderAuditLogs(hasMore) {
    var tbody    = $('#auditLogBody');
    var empty    = $('#auditEmpty');
    var moreWrap = $('#auditLoadMoreWrap');
    var moreBtn  = $('#auditLoadMoreBtn');
    if (!tbody) return;

    var filtered = auditLogsCache.filter(auditMatchesFilters);

    if (!filtered.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      tbody.innerHTML = filtered.map(auditRowHTML).join('');
    }

    updateSelectionToolbar(filtered);

    var showMore = !!hasMore && auditCategory === 'all' && !auditSearchTerm && !auditDateFrom && !auditDateTo;
    if (moreWrap) moreWrap.style.display = showMore ? 'block' : 'none';
    if (moreBtn)  { moreBtn.disabled = false; moreBtn.textContent = 'Load More Logs'; }
  }

  function updateSelectionToolbar(filtered) {
    var bar     = $('#auditSelBar');
    var countEl = $('#auditSelCount');
    var count   = Object.keys(selectedAuditIds).length;
    if (bar)     bar.style.display = count > 0 ? 'flex' : 'none';
    if (countEl) countEl.textContent = count + ' record' + (count === 1 ? '' : 's') + ' selected';

    var saBox = $('#auditSelectAll');
    if (saBox) {
      var allSelected = filtered.length > 0 && filtered.every(function (e) { return selectedAuditIds[e._docId]; });
      saBox.checked       = allSelected;
      saBox.indeterminate = count > 0 && !allSelected;
    }
  }

  window.OWN.toggleAuditSelect = function (cb) {
    var id = cb.dataset.id;
    var entry = auditLogsCache.filter(function (e) { return e._docId === id; })[0];
    if (cb.checked && entry) selectedAuditIds[id] = entry;
    else                     delete selectedAuditIds[id];
    var row = cb.closest('tr');
    if (row) row.classList.toggle('row-selected', cb.checked);
    updateSelectionToolbar(auditLogsCache.filter(auditMatchesFilters));
  };

  window.OWN.toggleSelectAllAudit = function (cb) {
    var filtered = auditLogsCache.filter(auditMatchesFilters);
    filtered.forEach(function (e) {
      if (cb.checked) selectedAuditIds[e._docId] = e;
      else            delete selectedAuditIds[e._docId];
    });
    renderAuditLogs();
  };

  window.OWN.clearAuditSelection = function () {
    selectedAuditIds = {};
    renderAuditLogs();
  };

  /* ── Export helpers ── */
  var AUDIT_CSV_HEADERS = ['Timestamp','Actor Role','Actor Email','Action','Target Type','Target ID','Order ID','Quote ID','Previous Value','New Value','Summary'];

  function auditToRows(entries) {
    return entries.map(function (e) {
      return [
        (e.createdAt && e.createdAt.toDate) ? e.createdAt.toDate().toLocaleString('en-IN') : '',
        e.actorRole  || '',
        e.actorEmail || '',
        e.actionLabel || e.action || '',
        e.targetType  || '',
        e.targetId    || '',
        e.orderId     || '',
        e.quoteId     || '',
        fmtAuditValue(e.previousValue),
        fmtAuditValue(e.newValue),
        e.summary     || ''
      ];
    });
  }

  function downloadExcel(rows, filename) {
    var esc = function (v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    var headerHtml = AUDIT_CSV_HEADERS.map(function (h) { return '<th style="background:#1a2235;color:#f5930a;font-weight:bold;border:1px solid #333;padding:6px;">' + esc(h) + '</th>'; }).join('');
    var rowsHtml   = rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td style="border:1px solid #ccc;padding:5px;mso-number-format:\'\\@\';">' + esc(c) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
      '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>' +
      '<x:Name>Audit Log</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet>' +
      '</x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>' +
      '<table>' + '<thead><tr>' + headerHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></body></html>';
    var blob = new Blob(['\ufeff', html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  }

  function downloadPDF(rows, title, subtitle, timelineMode) {
    var esc = function (v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    var body;
    if (timelineMode) {
      /* Vertical timeline layout for a single order/quote */
      body = '<div class="tl">' + rows.map(function (r) {
        return '<div class="tle">' +
          '<div class="tlt">' + esc(r[0]) + '</div>' +
          '<div class="tlbox"><div class="tll">' + esc(r[3]) + '</div>' +
          '<div class="tlw">' + esc(r[1]) + ' \u00B7 ' + esc(r[2]) + '</div>' +
          (r[10] ? '<div class="tls">' + esc(r[10]) + '</div>' : '') + '</div></div>';
      }).join('') + '</div>';
    } else {
      var headerHtml = AUDIT_CSV_HEADERS.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('');
      var rowsHtml   = rows.map(function (r, i) {
        return '<tr' + (i % 2 ? ' class="alt"' : '') + '>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>';
      }).join('');
      body = '<table><thead><tr>' + headerHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
    }
    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + esc(title) + '</title><style>' +
      'body{font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#111;margin:24px;}' +
      '.head{border-bottom:3px solid #f5930a;padding-bottom:10px;margin-bottom:16px;}' +
      '.brand{font-size:11px;color:#f5930a;font-weight:bold;letter-spacing:1px;text-transform:uppercase;}' +
      'h1{font-size:17px;margin:4px 0 2px;}' +
      '.sub{font-size:11px;color:#555;}' +
      'table{width:100%;border-collapse:collapse;}' +
      'th{background:#1a2235;color:#f5930a;text-align:left;padding:6px 8px;font-size:8.5px;text-transform:uppercase;letter-spacing:.4px;}' +
      'td{padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top;word-break:break-word;max-width:130px;}' +
      'tr.alt td{background:#f7f8fa;}' +
      '.tl{margin-top:8px;}' +
      '.tle{display:flex;gap:14px;margin-bottom:2px;}' +
      '.tlt{width:130px;flex:none;font-size:10px;color:#666;padding-top:10px;}' +
      '.tlbox{border-left:2px solid #f5930a;padding:8px 0 12px 16px;position:relative;flex:1;}' +
      '.tlbox:before{content:"";position:absolute;left:-6px;top:11px;width:10px;height:10px;border-radius:50%;background:#f5930a;}' +
      '.tll{font-size:12px;font-weight:bold;color:#1a2235;}' +
      '.tlw{font-size:9.5px;color:#888;margin-top:2px;}' +
      '.tls{font-size:10px;color:#444;margin-top:4px;}' +
      '.foot{margin-top:22px;font-size:9px;color:#999;border-top:1px solid #eee;padding-top:8px;}' +
      '@media print{@page{margin:12mm;' + (timelineMode ? 'size:A4 portrait;' : 'size:A4 landscape;') + '}}' +
      '</style></head><body>' +
      '<div class="head"><div class="brand">Express Goods Carrier</div><h1>' + esc(title) + '</h1><div class="sub">' + esc(subtitle) + '</div></div>' +
      body +
      '<div class="foot">This is a permanent, append-only business audit record generated by Express Goods Carrier. Audit entries cannot be edited or deleted.</div>' +
      '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { toast(false, 'Pop-up blocked — allow pop-ups to export PDF.'); return; }
    w.document.write(html); w.document.close();
    setTimeout(function () { w.focus(); w.print(); }, 450);
  }

  /* ── Master log export actions ── */
  window.OWN.exportSelectedPDF = function () {
    var sel = Object.keys(selectedAuditIds).map(function (k) { return selectedAuditIds[k]; });
    if (!sel.length) { toast(false, 'Select at least one audit entry first.'); return; }
    sel.sort(function (a, b) {
      var ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
      var tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
      return ta - tb;
    });
    downloadPDF(auditToRows(sel), 'Selected Audit Records (' + sel.length + ')',
      'Exported ' + new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }));
    toast(true, 'PDF ready — ' + sel.length + ' records.');
  };

  window.OWN.exportSelectedExcel = function () {
    var sel = Object.keys(selectedAuditIds).map(function (k) { return selectedAuditIds[k]; });
    if (!sel.length) { toast(false, 'Select at least one audit entry first.'); return; }
    downloadExcel(auditToRows(sel), 'egc-audit-selected-' + new Date().toISOString().slice(0,10) + '.xls');
    toast(true, 'Excel downloaded — ' + sel.length + ' records.');
  };

  window.OWN.exportFilteredExcel = function () {
    var filtered = auditLogsCache.filter(auditMatchesFilters);
    if (!filtered.length) { toast(false, 'No audit log rows to export.'); return; }
    downloadExcel(auditToRows(filtered), 'egc-audit-log-' + new Date().toISOString().slice(0,10) + '.xls');
    toast(true, 'Exported ' + filtered.length + ' records to Excel.');
  };

  window.OWN.exportFilteredPDF = function () {
    var filtered = auditLogsCache.filter(auditMatchesFilters);
    if (!filtered.length) { toast(false, 'No audit log rows to export.'); return; }
    downloadPDF(auditToRows(filtered), 'Master Audit Log',
      new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }) + ' \u00B7 ' + filtered.length + ' records');
    toast(true, 'PDF ready — ' + filtered.length + ' records.');
  };

  /* ── Timeline drawer (shared render for order & quote) ── */
  function renderTimeline(events, kind, entityId) {
    if (!events.length) return '<div class="tl-empty">No timeline events recorded yet.</div>';
    var exportRow = '<div class="tl-export-row">' +
      '<button class="btn-ghost btn-sm" onclick="OWN.export' + kind + 'TimelinePDF(\'' + EGC.esc(entityId) + '\')">Export Full Timeline (PDF)</button>' +
      '<button class="btn-ghost btn-sm" onclick="OWN.export' + kind + 'TimelineExcel(\'' + EGC.esc(entityId) + '\')">Export (Excel)</button>' +
      '</div>';
    var items = events.map(function (e, i) {
      var iconCls = EGC.AUDIT_TIMELINE_ICONS[e.action] || 'tl-default';
      var ts = (e.createdAt && e.createdAt.toDate) ? e.createdAt.toDate() : null;
      var timeStr = ts ? ts.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true }) : '\u2014';
      var dateStr = ts ? ts.toLocaleDateString('en-IN', { day:'2-digit', month:'short' }) : '';
      var isLast  = i === events.length - 1;
      return (
        '<div class="tl-event' + (isLast ? ' tl-last' : '') + '">' +
          '<div class="tl-spine"><div class="tl-dot ' + iconCls + '"></div>' + (isLast ? '' : '<div class="tl-line"></div>') + '</div>' +
          '<div class="tl-content">' +
            '<div class="tl-time">' + EGC.esc(timeStr) + (dateStr ? ' <span class="tl-date">\u00B7 ' + EGC.esc(dateStr) + '</span>' : '') + '</div>' +
            '<div class="tl-label">' + EGC.esc(e.actionLabel || e.action) + '</div>' +
            '<div class="tl-who">' + EGC.esc(e.actorRole || 'system') + (e.actorEmail ? ' \u00B7 ' + EGC.esc(e.actorEmail) : '') + '</div>' +
            (e.summary ? '<div class="tl-summary">' + EGC.esc(e.summary) + '</div>' : '') +
          '</div>' +
        '</div>'
      );
    }).join('');
    return exportRow + '<div class="timeline">' + items + '</div>';
  }

  function openTimelineDrawer(collection, kind, entityId, heading, subhead) {
    var drawer  = $('#timelineDrawer');
    var hEl     = $('#tlDrawerHeading');
    var subEl   = $('#tlDrawerSubhead');
    var body    = $('#tlDrawerBody');
    if (!drawer) return;
    hEl.textContent   = heading;
    subEl.textContent = subhead;
    body.innerHTML    = '<div class="tl-loading">Loading timeline\u2026</div>';
    drawer.classList.add('open');
    document.body.style.overflow = 'hidden';

    fbDB.collection(collection).doc(entityId).collection('events')
      .orderBy('createdAt', 'asc').get()
      .then(function (snap) {
        var events = [];
        snap.forEach(function (doc) { events.push(doc.data()); });
        body.innerHTML = renderTimeline(events, kind, entityId);
      })
      .catch(function (err) {
        body.innerHTML = '<div class="tl-empty" style="color:#ff7070;">Could not load timeline: ' + EGC.esc(err.message) + '</div>';
      });
  }

  window.OWN.openOrderTimeline = function (orderId) {
    openTimelineDrawer('orderTimelines', 'Order', orderId, 'Order ' + orderId, 'Complete order lifecycle');
  };
  window.OWN.openQuoteTimeline = function (quoteId) {
    openTimelineDrawer('quoteTimelines', 'Quote', quoteId, 'Quote ' + quoteId, 'Complete quote history');
  };
  window.OWN.closeTimeline = function () {
    var drawer = $('#timelineDrawer');
    if (drawer) { drawer.classList.remove('open'); document.body.style.overflow = ''; }
  };

  function fetchTimelineRows(collection, docId, cb) {
    fbDB.collection(collection).doc(docId).collection('events')
      .orderBy('createdAt', 'asc').get()
      .then(function (snap) {
        var events = []; snap.forEach(function (doc) { events.push(doc.data()); });
        cb(null, events);
      })
      .catch(function (err) { cb(err, []); });
  }

  window.OWN.exportOrderTimelinePDF = function (orderId) {
    fetchTimelineRows('orderTimelines', orderId, function (err, events) {
      if (err || !events.length) { toast(false, 'No timeline data to export.'); return; }
      downloadPDF(auditToRows(events), 'Order ' + orderId + ' — Audit Timeline',
        'Complete lifecycle \u00B7 ' + events.length + ' events \u00B7 ' + new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }), true);
      toast(true, 'Order timeline PDF ready.');
    });
  };
  window.OWN.exportOrderTimelineExcel = function (orderId) {
    fetchTimelineRows('orderTimelines', orderId, function (err, events) {
      if (err || !events.length) { toast(false, 'No timeline data to export.'); return; }
      downloadExcel(auditToRows(events), 'egc-order-' + orderId + '-timeline.xls');
      toast(true, 'Order timeline Excel downloaded.');
    });
  };
  window.OWN.exportQuoteTimelinePDF = function (quoteId) {
    fetchTimelineRows('quoteTimelines', quoteId, function (err, events) {
      if (err || !events.length) { toast(false, 'No timeline data to export.'); return; }
      downloadPDF(auditToRows(events), 'Quote ' + quoteId + ' — History Timeline',
        'Complete history \u00B7 ' + events.length + ' events \u00B7 ' + new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }), true);
      toast(true, 'Quote timeline PDF ready.');
    });
  };
  window.OWN.exportQuoteTimelineExcel = function (quoteId) {
    fetchTimelineRows('quoteTimelines', quoteId, function (err, events) {
      if (err || !events.length) { toast(false, 'No timeline data to export.'); return; }
      downloadExcel(auditToRows(events), 'egc-quote-' + quoteId + '-timeline.xls');
      toast(true, 'Quote timeline Excel downloaded.');
    });
  };

  /* ===========================================================
     INVOICES PANEL (Owner) — Phase 5
     Real-time list, search, view/print/PDF, payment status update.
  =========================================================== */
  var invUnsub        = null;
  var ownerInvCache   = [];
  var invSearchTerm   = '';
  var invStatusFilter = 'all';

  function loadInvoices() {
    if (invUnsub) { invUnsub(); invUnsub = null; }
    invUnsub = fbDB.collection('invoices')
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var rows = [];
        snap.forEach(function (doc) { var d = doc.data(); d._docId = doc.id; rows.push(d); });
        ownerInvCache = rows;
        renderInvoices();
        updateInvStats();
      }, function (err) {
        console.error('[OWN] invoices listener:', err.code, err.message);
        var list = $('#ownerInvoiceList');
        if (list) list.innerHTML = '<div class="empty"><p style="color:#ff7070;">Could not load invoices.<br><small>' + err.message + '</small></p></div>';
      });
  }

  function updateInvStats() {
    var out = 0, paid = 0, pend = 0;
    ownerInvCache.forEach(function (invDoc) {
      /* Project from the master ORDER (SSoT). Thin invoice docs carry NO
         amounts or payment status, so aggregating them raw would report
         zero outstanding and count every invoice as pending. */
      var order = SHIP.getOrderSync ? SHIP.getOrderSync(invDoc.orderId) : null;
      var inv = SHIP.toInvoiceView(order, invDoc);
      var t = INV.computeTotals(inv);
      out += t.outstanding;
      if (INV.effectiveStatus(inv) === 'paid') paid++; else pend++;
    });
    var o = $('#invStatOutstanding'); if (o) o.textContent = '\u20B9' + INV.fmtMoney(out);
    var p = $('#invStatPaid');        if (p) p.textContent = paid;
    var n = $('#invStatPending');     if (n) n.textContent = pend;
  }

  $all('#invFilterChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $all('#invFilterChips .chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      invStatusFilter = chip.dataset.filter;
      renderInvoices();
    });
  });

  var invSearchInput = $('#invSearch');
  if (invSearchInput) {
    invSearchInput.addEventListener('input', function () {
      invSearchTerm = invSearchInput.value.trim().toLowerCase();
      renderInvoices();
    });
  }

  function invMatches(invDoc) {
    var order = SHIP.getOrderSync ? SHIP.getOrderSync(invDoc.orderId) : null;
    var inv = SHIP.toInvoiceView(order, invDoc);
    if (invStatusFilter !== 'all' && INV.effectiveStatus(inv) !== invStatusFilter) return false;
    if (!invSearchTerm) return true;
    var hay = [inv.invoiceNumber, inv.lrNumber, inv.orderId, inv.quoteId,
      inv.customerName, inv.customerCompany, inv.customerGst].join(' ').toLowerCase();
    return hay.indexOf(invSearchTerm) !== -1;
  }

  function invStatusPill(inv) {
    var s = INV.effectiveStatus(inv);
    return '<span class="pay-pill ' + INV.paymentClass(s) + '">' + INV.paymentLabel(s) + '</span>';
  }

  function ownerInvoiceCardHTML(invDoc) {
    /* Project from the master ORDER (SSoT); fall back to thin/legacy doc. */
    var order = SHIP.getOrderSync ? SHIP.getOrderSync(invDoc.orderId) : null;
    var inv = SHIP.toInvoiceView(order, invDoc);
    var t = INV.computeTotals(inv);
    var id = EGC.esc(invDoc._docId);
    /* due date as yyyy-mm-dd for the date input */
    var dueVal = '';
    if (inv.dueDate && inv.dueDate.toDate) {
      var d = inv.dueDate.toDate();
      dueVal = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }
    function numv(v) { return (v === 0 || v) ? v : ''; }

    return (
      '<div class="inv-card">' +
        '<div class="inv-card-top">' +
          '<div><div class="inv-id">' + EGC.esc(inv.invoiceNumber) + '</div>' +
            '<div class="inv-sub">' + EGC.esc(inv.lrNumber || '') + ' \u00B7 ' + EGC.esc(inv.orderId || '') + ' \u00B7 ' + EGC.fmtWhen(inv.createdAt) + '</div></div>' +
          invStatusPill(inv) +
        '</div>' +
        '<div class="inv-card-grid">' +
          '<div class="inv-field"><span>Customer</span><strong>' + EGC.esc(inv.customerName || '\u2014') + '</strong></div>' +
          '<div class="inv-field"><span>Company</span><strong>' + EGC.esc(inv.customerCompany || '\u2014') + '</strong></div>' +
          '<div class="inv-field"><span>Route</span><strong>' + EGC.esc(inv.fromLocation || '') + ' \u2192 ' + EGC.esc(inv.toLocation || '') + '</strong></div>' +
          '<div class="inv-field"><span>Invoice Value</span><strong style="color:var(--amber);">\u20B9' + INV.fmtMoney(t.invoiceValue) + '</strong></div>' +
          '<div class="inv-field"><span>Received</span><strong>\u20B9' + INV.fmtMoney(inv.receivedAmount) + '</strong></div>' +
          '<div class="inv-field"><span>Outstanding</span><strong style="color:' + (t.outstanding > 0 ? '#ff9f43' : 'var(--green)') + ';">\u20B9' + INV.fmtMoney(t.outstanding) + '</strong></div>' +
        '</div>' +
        '<div class="inv-card-actions">' +
          '<button class="btn-ghost btn-sm" onclick="OWN.viewInvoice(\'' + id + '\')">View</button>' +
          '<button class="btn-ghost btn-sm" onclick="OWN.printInvoice(\'' + id + '\')">Print / PDF</button>' +
          (inv.orderId ? '<button class="btn-ghost btn-sm" onclick="OWN.manageShipmentFromInvoice(\'' + id + '\')">Manage Shipment</button>' : '') +
          (t.outstanding > 0 ? '<button class="btn-ghost btn-sm" onclick="OWN.recordPayment(\'' + id + '\')" title="Record a payment received against this invoice">Record Payment</button>' : '') +
          '<button class="btn-a btn-sm" style="margin-left:auto;" onclick="OWN.toggleInvoiceEdit(\'' + id + '\')" id="invedit-btn-' + id + '">Invoice Settings</button>' +
        '</div>' +

        /* ── INVOICE-DOCUMENT-ONLY SETTINGS ──
           Shared shipment data (vehicle, charges, payment, parties) is no
           longer edited here — it lives on the order and is managed via
           "Manage Shipment". This panel holds ONLY invoice-specific fields. */
        '<div class="inv-edit-panel" id="invedit-' + id + '" style="display:none;">' +
          '<div class="inv-edit-title">Invoice settings \u2014 document-specific fields only</div>' +
          '<div class="inv-edit-grid">' +
            '<label>Due Date<input type="date" id="ed-due-' + id + '" value="' + dueVal + '"></label>' +
          '</div>' +
          '<div class="inv-ssot-note">Vehicle, charges, payment status and party details are shared shipment data. ' +
            (inv.orderId ? 'Edit them in <a href="#" onclick="OWN.manageShipmentFromInvoice(\'' + id + '\');return false;">Manage Shipment</a> \u2014 changes flow to the invoice, LR, accounting and both dashboards automatically.' : 'They are stored on the order.') +
          '</div>' +
          '<div class="inv-edit-actions">' +
            '<button class="btn-a btn-sm" onclick="OWN.saveInvoiceEdits(\'' + id + '\')">Save Changes</button>' +
            '<button class="btn-ghost btn-sm" onclick="OWN.toggleInvoiceEdit(\'' + id + '\')">Cancel</button>' +
            '<span class="inv-edit-hint">Saving updates the invoice date shown on the PDF and dashboards.</span>' +
          '</div>' +
        '</div>' +

        '<div class="fst" id="invmsg-' + id + '"></div>' +
      '</div>'
    );
  }

  function renderInvoices() {
    var list  = $('#ownerInvoiceList');
    var empty = $('#ownerInvoiceEmpty');
    if (!list) return;
    var filtered = ownerInvCache.filter(invMatches);
    if (!filtered.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = filtered.map(ownerInvoiceCardHTML).join('');
  }

  function findInv(docId) { return ownerInvCache.filter(function (i) { return i._docId === docId; })[0]; }

  window.OWN.viewInvoice = function (docId) {
    var inv = findInv(docId);
    if (inv) SHIP.openInvoice(inv, false).then(function (ok) { if (!ok) toast(false, 'Allow pop-ups to view the invoice.'); });
  };
  window.OWN.printInvoice = function (docId) {
    var inv = findInv(docId);
    if (inv) SHIP.openInvoice(inv, true).then(function (ok) { if (!ok) toast(false, 'Allow pop-ups to print the invoice.'); });
  };

  /* One-click: from an unpaid invoice card, jump to Receive Payment in
     Accounting with the customer and outstanding amount pre-filled. Saves the
     owner ~4 clicks on the single most repeated daily action. The owner still
     reviews and posts — nothing is auto-saved. */
  window.OWN.recordPayment = function (docId) {
    var invDoc = findInv(docId);
    if (!invDoc) { toast(false, 'Invoice still loading — try again in a moment.'); return; }
    var order = SHIP.getOrderSync ? SHIP.getOrderSync(invDoc.orderId) : null;
    var inv = SHIP.toInvoiceView(order, invDoc);
    var t = INV.computeTotals(inv);
    var customer = inv.customerCompany || inv.customerName || '';
    var amount = t.outstanding > 0 ? t.outstanding : '';
    var params = 'partyName=' + encodeURIComponent(customer) +
                 (amount ? '&amount=' + encodeURIComponent(amount) : '') +
                 (inv.invoiceNumber ? '&inv=' + encodeURIComponent(inv.invoiceNumber) : '') +
                 (invDoc.orderId ? '&orderId=' + encodeURIComponent(invDoc.orderId) : '');
    window.location.href = 'accounting.html#receipt?' + params;
  };

  window.OWN.toggleInvoiceEdit = function (docId) {
    var panel = $('#invedit-' + docId);
    var btn   = $('#invedit-btn-' + docId);
    if (!panel) return;
    var open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (btn) btn.textContent = open ? 'Invoice Settings' : 'Close Settings';
  };

  /* Jump from an invoice to the unified Manage Shipment editor (on the
     matching LR card) — shared data is edited in ONE place. */
  window.OWN.manageShipmentFromInvoice = function (docId) {
    var inv = findInv(docId);
    if (!inv || !inv.orderId) { toast(false, 'No linked order for this invoice.'); return; }
    var lr = ownerLrCache.filter(function (l) { return l.orderId === inv.orderId; })[0];
    if (!lr) { toast(false, 'Shipment record still loading — try again in a moment.'); return; }
    openTab('lr');
    var lrSearch = $('#lrSearch');
    if (lrSearch) { lrSearch.value = inv.orderId; lrSearchTerm = inv.orderId.toLowerCase(); renderLorryReceipts(); }
    setTimeout(function () {
      window.OWN.toggleLrEdit(lr._docId);
      var card = $('#lredit-' + lr._docId);
      if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
  };

  /* Invoice settings save — ONLY document-specific fields (due date).
     All shared shipment/payment data is managed via the order (SSoT). */
  window.OWN.saveInvoiceEdits = function (docId) {
    var inv = findInv(docId);
    if (!inv) return;
    var msg = $('#invmsg-' + docId);

    function val(id) { var el = $('#ed-' + id + '-' + docId); return el ? el.value : ''; }
    var dueStr = val('due');

    var update = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (dueStr) {
      var parts = dueStr.split('-');
      var dd = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      update.dueDate = firebase.firestore.Timestamp.fromDate(dd);
    }

    fbDB.collection('invoices').doc(inv.invoiceId).update(update).then(function () {
      if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Invoice settings saved.'; }
      toast(true, (inv.invoiceNumber || inv.invoiceId) + ' updated');
      EGC.logAudit('invoice_generated',
        'Invoice ' + (inv.invoiceNumber || inv.invoiceId) + ' settings updated (due date).',
        { targetType: 'invoice', targetId: inv.invoiceId, orderId: inv.orderId, quoteId: inv.quoteId,
          previousValue: null, newValue: dueStr || null });
      var panel = $('#invedit-' + docId);
      var btn   = $('#invedit-btn-' + docId);
      if (panel) panel.style.display = 'none';
      if (btn) btn.textContent = 'Invoice Settings';
    }).catch(function (err) {
      if (msg) { msg.className = 'fst er'; msg.textContent = err.message || 'Could not save invoice settings.'; }
    });
  };

  /* =========================================================
     LORRY RECEIPTS (owner)
     Real-time list, search, view/download (LR + combined), and an
     edit panel for all owner-editable transport fields. Saving writes
     back to Firestore, which auto-syncs the LR preview, both dashboards,
     and the downloadable PDFs via the existing onSnapshot listeners.
  ========================================================= */
  var lrUnsub        = null;
  var ownerLrCache   = [];
  var lrSearchTerm   = '';
  var lrTypeFilter   = 'all';

  function loadLorryReceipts() {
    if (lrUnsub) { lrUnsub(); lrUnsub = null; }
    lrUnsub = fbDB.collection('lorryReceipts')
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var rows = [];
        snap.forEach(function (doc) { var d = doc.data(); d._docId = doc.id; rows.push(d); });
        ownerLrCache = rows;
        renderLorryReceipts();
      }, function (err) {
        console.error('[OWN] lorryReceipts listener:', err.code, err.message);
        var list = $('#ownerLrList');
        if (list) list.innerHTML = '<div class="empty"><p style="color:#ff7070;">Could not load Lorry Receipts.<br><small>' + err.message + '</small></p></div>';
      });
  }

  var lrSearchInput = $('#lrSearch');
  if (lrSearchInput) {
    lrSearchInput.addEventListener('input', function () {
      lrSearchTerm = lrSearchInput.value.trim().toLowerCase();
      renderLorryReceipts();
    });
  }
  $all('#lrFilterChips .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $all('#lrFilterChips .chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      lrTypeFilter = chip.dataset.filter;
      renderLorryReceipts();
    });
  });

  function lrMatches(lr) {
    if (lrTypeFilter !== 'all' && (lr.shipmentType || 'commercial') !== lrTypeFilter) return false;
    if (!lrSearchTerm) return true;
    var hay = [lr.orderId, lr.lrNumber, lr.docketNumber, lr.invoiceId,
      lr.consignorName, lr.consigneeName, lr.vehicleNumber, lr.driverName,
      lr.fromLocation, lr.toLocation].join(' ').toLowerCase();
    return hay.indexOf(lrSearchTerm) !== -1;
  }

  function ownerLrCardHTML(lrDoc) {
    /* Project the card + editor from the master ORDER (SSoT). The order
       is primed in cache by the orders listener; fall back to the thin
       doc for legacy records. */
    var order = SHIP.getOrderSync ? SHIP.getOrderSync(lrDoc.orderId) : null;
    var lr = SHIP.toLrView(order, lrDoc);
    var t  = LR.computeTotals(lr);
    var id = EGC.esc(lrDoc._docId);
    var stype = lr.shipmentType || 'commercial';
    function numv(v) { return (v === 0 || v) ? v : ''; }

    return (
      '<div class="lr-card">' +
        '<div class="lr-card-top">' +
          '<div><div class="lr-id">' + EGC.esc(lr.lrNumber) + '</div>' +
            '<div class="lr-sub">Docket ' + EGC.esc(lr.docketNumber || '\u2014') + ' \u00B7 ' + EGC.esc(lr.orderId || '') + ' \u00B7 ' + EGC.fmtWhen(lrDoc.createdAt) + '</div></div>' +
          '<span class="lr-type-pill ' + stype + '">' + stype + '</span>' +
        '</div>' +
        '<div class="lr-card-grid">' +
          '<div class="lr-field"><span>Consignor</span><strong>' + EGC.esc(lr.consignorName || '\u2014') + '</strong></div>' +
          '<div class="lr-field"><span>Consignee</span><strong>' + EGC.esc(lr.consigneeName || '\u2014') + '</strong></div>' +
          '<div class="lr-field"><span>Route</span><strong>' + EGC.esc(lr.fromLocation || '') + ' \u2192 ' + EGC.esc(lr.toLocation || '') + '</strong></div>' +
          '<div class="lr-field"><span>Vehicle</span><strong>' + EGC.esc(lr.vehicleNumber || '\u2014') + '</strong></div>' +
          '<div class="lr-field"><span>Driver</span><strong>' + EGC.esc(lr.driverName || '\u2014') + '</strong></div>' +
          '<div class="lr-field"><span>Grand Total</span><strong style="color:var(--amber);">\u20B9' + LR.fmtMoneyOrZero(t.grandTotal) + '</strong></div>' +
        '</div>' +
        '<div class="lr-card-actions doc-dl-group">' +
          '<button class="btn-doc" onclick="OWN.viewLR(\'' + id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>View</button>' +
          '<button class="btn-doc" onclick="OWN.printLR(\'' + id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>LR PDF</button>' +
          '<button class="btn-doc" onclick="OWN.printCombined(\'' + id + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>Combined PDF</button>' +
          '<button class="btn-a btn-sm" style="margin-left:auto;" onclick="OWN.toggleLrEdit(\'' + id + '\')" id="lredit-btn-' + id + '">Manage Shipment</button>' +
        '</div>' +

        /* ── UNIFIED "MANAGE SHIPMENT" PANEL — writes to the ORDER ──
           Single editor for ALL shared shipment data. Replaces the old
           separate Invoice-edit and LR-edit screens. Saving updates the
           order, which re-projects to Invoice, LR, both dashboards,
           Accounting, Excel, Reports and the PDFs. */
        '<div class="lr-edit-panel" id="lredit-' + id + '" style="display:none;">' +
          '<div class="lr-edit-title">Manage Shipment \u2014 single source of truth for ' + EGC.esc(lr.orderId || '') + '</div>' +

          '<div class="ms-section">Consignor (From)</div>' +
          '<div class="lr-edit-grid">' +
            '<label>Company / Name<input type="text" id="lr-cnorname-' + id + '" value="' + EGC.esc(lr.consignorName || '') + '"></label>' +
            '<label>Contact Person<input type="text" id="lr-cnorcp-' + id + '" value="' + EGC.esc(lr.consignorContactPerson || '') + '"></label>' +
            '<label>Mobile<input type="text" id="lr-cnorcontact-' + id + '" value="' + EGC.esc(lr.consignorContact || '') + '"></label>' +
            '<label>Email<input type="text" id="lr-cnoremail-' + id + '" value="' + EGC.esc(lr.consignorEmail || '') + '"></label>' +
            '<label>GSTIN<input type="text" id="lr-cnorgst-' + id + '" value="' + EGC.esc(lr.consignorGstin || '') + '"></label>' +
            '<label class="lr-edit-wide">Address<input type="text" id="lr-cnoraddr-' + id + '" value="' + EGC.esc(lr.consignorAddress || '') + '"></label>' +
          '</div>' +

          '<div class="ms-section">Consignee (To)</div>' +
          '<div class="lr-edit-grid">' +
            '<label>Company / Name<input type="text" id="lr-cneename-' + id + '" value="' + EGC.esc(lr.consigneeName || '') + '"></label>' +
            '<label>Contact Person<input type="text" id="lr-cneecp-' + id + '" value="' + EGC.esc(lr.consigneeContactPerson || '') + '"></label>' +
            '<label>Mobile<input type="text" id="lr-cneecontact-' + id + '" value="' + EGC.esc(lr.consigneeContact || '') + '"></label>' +
            '<label>Email<input type="text" id="lr-cneeemail-' + id + '" value="' + EGC.esc(lr.consigneeEmail || '') + '"></label>' +
            '<label>GSTIN<input type="text" id="lr-cneegst-' + id + '" value="' + EGC.esc(lr.consigneeGstin || '') + '"></label>' +
            '<label class="lr-edit-wide">Address<input type="text" id="lr-cneeaddr-' + id + '" value="' + EGC.esc(lr.consigneeAddress || '') + '"></label>' +
          '</div>' +

          '<div class="ms-section">Transport</div>' +
          '<div class="lr-edit-grid">' +
            '<label>Vehicle Number<input type="text" id="lr-vehicle-' + id + '" value="' + EGC.esc(lr.vehicleNumber || '') + '" placeholder="e.g. RJ-20GB-4602"></label>' +
            '<label>Vehicle Type<input type="text" id="lr-vtype-' + id + '" value="' + EGC.esc(lr.vehicleType || '') + '" placeholder="e.g. 14ft / Container"></label>' +
            '<label>Driver Name<input type="text" id="lr-driver-' + id + '" value="' + EGC.esc(lr.driverName || '') + '"></label>' +
            '<label>Driver Mobile<input type="text" id="lr-drivermob-' + id + '" value="' + EGC.esc(lr.driverMobile || '') + '"></label>' +
            '<label>Transport Mode<input type="text" id="lr-tmode-' + id + '" value="' + EGC.esc(lr.transportMode || 'Road') + '"></label>' +
            '<label>Dispatch Mode<input type="text" id="lr-dispatch-' + id + '" value="' + EGC.esc(lr.dispatchMode || 'Door') + '"></label>' +
            '<label>E-Way Bill Number (optional)<input type="text" id="lr-eway-' + id + '" value="' + EGC.esc(lr.ewayBill || '') + '" placeholder="Shown on LR &amp; Invoice only if provided"></label>' +
            '<label>Estimated Delivery Date (optional)<input type="date" id="lr-eta-' + id + '" value="' + EGC.esc(lr.estimatedDelivery || '') + '"></label>' +
          '</div>' +

          '<div class="ms-section">Cargo</div>' +
          '<div class="lr-edit-grid">' +
            '<label>Actual Weight (KG)<input type="text" id="lr-aweight-' + id + '" value="' + EGC.esc(lr.actualWeight || '') + '"></label>' +
            '<label>Charged Weight (KG) \u2014 drives billing<input type="text" id="lr-cweight-' + id + '" value="' + EGC.esc(lr.chargedWeight || '') + '"></label>' +
            '<label>Package Count<input type="text" id="lr-pkg-' + id + '" value="' + EGC.esc(lr.packageCount || '') + '"></label>' +
            '<label>Packing Method<input type="text" id="lr-packing-' + id + '" value="' + EGC.esc(lr.packingMethod || '') + '" placeholder="e.g. Bundles"></label>' +
            '<label class="lr-edit-wide">Material Description<input type="text" id="lr-material-' + id + '" value="' + EGC.esc(lr.materialDescription || '') + '"></label>' +
          '</div>' +

          '<div class="ms-section">Charges</div>' +
          '<div class="lr-edit-grid">' +
            '<label>Freight (\u20B9)<input type="number" min="0" id="lr-freight-' + id + '" value="' + numv(lr.freight) + '"></label>' +
            '<label>F.O.V (\u20B9)<input type="number" min="0" id="lr-fov-' + id + '" value="' + numv(lr.fov) + '"></label>' +
            '<label>Labour (\u20B9)<input type="number" min="0" id="lr-labour-' + id + '" value="' + numv(lr.labour) + '"></label>' +
            '<label>Local Collection (\u20B9)<input type="number" min="0" id="lr-localcol-' + id + '" value="' + numv(lr.localCollection) + '"></label>' +
            '<label>Door Delivery (\u20B9)<input type="number" min="0" id="lr-doordel-' + id + '" value="' + numv(lr.doorDelivery) + '"></label>' +
            '<label>Docket Charges (\u20B9)<input type="number" min="0" id="lr-docket-' + id + '" value="' + numv(lr.docketCharges) + '"></label>' +
            '<label>Discount (\u20B9)<input type="number" min="0" id="lr-discount-' + id + '" value="' + numv(lr.discount) + '"></label>' +
            '<label>SGST %<input type="number" min="0" step="0.1" id="lr-sgst-' + id + '" value="' + numv(lr.sgstRate) + '"></label>' +
            '<label>CGST %<input type="number" min="0" step="0.1" id="lr-cgst-' + id + '" value="' + numv(lr.cgstRate) + '"></label>' +
          '</div>' +

          '<div class="ms-section">Payment</div>' +
          '<div class="lr-edit-grid">' +
            '<label>Advance Received (\u20B9)<input type="number" min="0" id="lr-advance-' + id + '" value="' + numv(lr.advanceReceived) + '"></label>' +
            '<label>Amount Received (\u20B9)<input type="number" min="0" id="lr-received-' + id + '" value="' + numv(lr.receivedAmount) + '"></label>' +
            '<label>Payment Status<select id="lr-status-' + id + '">' +
              ['pending', 'partial', 'paid', 'overdue'].map(function (s) {
                return '<option value="' + s + '"' + (lr.paymentStatus === s ? ' selected' : '') + '>' + LR.paymentLabel(s) + '</option>';
              }).join('') +
            '</select></label>' +
            '<label>GST To Be Paid By<input type="text" id="lr-gstby-' + id + '" value="' + EGC.esc(lr.gstPayableBy || 'Consignee') + '"></label>' +
          '</div>' +

          '<div class="ms-section">Notes</div>' +
          '<div class="lr-edit-grid">' +
            '<label class="lr-edit-wide">Insurance Details<input type="text" id="lr-insurance-' + id + '" value="' + EGC.esc(lr.insuranceDetails || '') + '" placeholder="Policy no, insurer, value"></label>' +
            '<label class="lr-edit-wide">Special Instructions<textarea id="lr-special-' + id + '">' + EGC.esc(lr.specialInstructions || '') + '</textarea></label>' +
            '<label class="lr-edit-wide">Remarks<textarea id="lr-remarks-' + id + '">' + EGC.esc(lr.remarks || '') + '</textarea></label>' +
          '</div>' +

          '<div class="lr-edit-actions">' +
            '<button class="btn-a btn-sm" onclick="OWN.saveLrEdits(\'' + id + '\')">Save Changes</button>' +
            '<button class="btn-ghost btn-sm" onclick="OWN.toggleLrEdit(\'' + id + '\')">Cancel</button>' +
            '<span class="lr-edit-hint">Entered once \u2014 updates Invoice, LR, Accounting, Excel, Reports and both dashboards instantly.</span>' +
          '</div>' +
        '</div>' +

        '<div class="fst" id="lrmsg-' + id + '"></div>' +
      '</div>'
    );
  }

  function renderLorryReceipts() {
    var list  = $('#ownerLrList');
    var empty = $('#ownerLrEmpty');
    if (!list) return;
    var filtered = ownerLrCache.filter(lrMatches);
    if (!filtered.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = filtered.map(ownerLrCardHTML).join('');
  }

  function findLr(docId) { return ownerLrCache.filter(function (l) { return l._docId === docId; })[0]; }
  function findInvoiceForLr(lr) {
    if (!lr) return null;
    return ownerInvCache.filter(function (i) {
      return (lr.invoiceId && i.invoiceId === lr.invoiceId) ||
             (lr.orderId && i.orderId === lr.orderId);
    })[0] || null;
  }

  window.OWN.viewLR = function (docId) {
    var lr = findLr(docId);
    if (lr) SHIP.openLr(lr, false).then(function (ok) { if (!ok) toast(false, 'Allow pop-ups to view the Lorry Receipt.'); });
  };
  window.OWN.printLR = function (docId) {
    var lr = findLr(docId);
    if (lr) SHIP.openLr(lr, true).then(function (ok) { if (!ok) toast(false, 'Allow pop-ups to print the Lorry Receipt.'); });
  };
  window.OWN.printCombined = function (docId) {
    var lr  = findLr(docId);
    var inv = findInvoiceForLr(lr);
    if (!lr) return;
    if (!inv) { toast(false, 'Invoice for this LR not loaded yet — try again in a moment.'); return; }
    SHIP.openCombined(inv, lr, true).then(function (ok) { if (!ok) toast(false, 'Allow pop-ups to print the combined PDF.'); });
  };

  window.OWN.toggleLrEdit = function (docId) {
    var panel = $('#lredit-' + docId);
    var btn   = $('#lredit-btn-' + docId);
    if (!panel) return;
    var open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (btn) btn.textContent = open ? 'Manage Shipment' : 'Close Editor';
  };

  window.OWN.saveLrEdits = function (docId) {
    var lrDoc = findLr(docId);
    if (!lrDoc) return;
    var msg = $('#lrmsg-' + docId);
    if (!lrDoc.orderId) {
      if (msg) { msg.className = 'fst er'; msg.textContent = 'This Lorry Receipt is not linked to an order and cannot be managed here.'; }
      return;
    }

    function val(id)  { var el = $('#lr-' + id + '-' + docId); return el ? el.value : ''; }
    function numv(id) { return INV.toNum(val(id)); }

    /* ── H3 VALIDATION ── Prevent invalid business data from reaching the
       Order (and therefore every document, the ledger and reports). All
       numeric fields are bounded; the most important guard is that a discount
       can never exceed the charge subtotal (which would make GST and the
       invoice total negative). */
    var vFreight = numv('freight'), vFov = numv('fov'), vLabour = numv('labour'),
        vLocal = numv('localcol'), vDoor = numv('doordel'), vDocket = numv('docket'),
        vDiscount = numv('discount'), vSgst = numv('sgst'), vCgst = numv('cgst'),
        vAdvance = numv('advance'), vReceived = numv('received'),
        vAweight = INV.toNum(val('aweight')), vCweight = INV.toNum(val('cweight')),
        vPkg = INV.toNum(val('pkg'));
    var chargeSubtotal = vFreight + vFov + vLabour + vLocal + vDoor + vDocket;
    var CAP = 100000000;   /* ₹10 crore upper sanity cap on any single field */
    var verr = null;
    var nonNeg = { Freight: vFreight, FOV: vFov, Labour: vLabour, 'Local collection': vLocal,
                   'Door delivery': vDoor, 'Docket charges': vDocket, Discount: vDiscount,
                   Advance: vAdvance, Received: vReceived };
    Object.keys(nonNeg).forEach(function (k) {
      if (verr) return;
      if (nonNeg[k] < 0) verr = k + ' cannot be negative.';
      else if (nonNeg[k] > CAP) verr = k + ' is unrealistically large.';
    });
    if (!verr && (vSgst < 0 || vSgst > 50)) verr = 'SGST rate must be between 0 and 50%.';
    if (!verr && (vCgst < 0 || vCgst > 50)) verr = 'CGST rate must be between 0 and 50%.';
    if (!verr && vDiscount > chargeSubtotal) verr = 'Discount (\u20B9' + vDiscount + ') cannot exceed the charges subtotal (\u20B9' + chargeSubtotal + ').';
    if (!verr && vAweight < 0) verr = 'Actual weight cannot be negative.';
    if (!verr && vCweight < 0) verr = 'Charged weight cannot be negative.';
    if (!verr && (vAweight > 1000000 || vCweight > 1000000)) verr = 'Weight value is unrealistically large.';
    if (!verr && (vPkg < 0 || vPkg > 100000)) verr = 'Package count is out of range.';
    /* advance + received cannot exceed the grand total of this shipment */
    if (!verr) {
      var taxable = chargeSubtotal - vDiscount;
      var grand = taxable + (taxable * vSgst / 100) + (taxable * vCgst / 100);
      if (vAdvance + vReceived > Math.round(grand) + 1) {
        verr = 'Advance + received (\u20B9' + (vAdvance + vReceived) + ') cannot exceed the grand total (\u20B9' + Math.round(grand) + ').';
      }
    }
    if (verr) {
      if (msg) { msg.className = 'fst er'; msg.textContent = verr; }
      return;
    }
    /* SINGLE SOURCE OF TRUTH: write all shared shipment data to the ORDER.
       Invoice + LR + Accounting + Excel + Reports + both dashboards all
       project from this, so one save updates every connected module. */
    var orderUpdate = {
      /* parties (consignor / consignee) */
      consignorName:          val('cnorname').trim(),
      consignorContactPerson: val('cnorcp').trim(),
      consignorContact:       val('cnorcontact').trim(),
      consignorEmail:         val('cnoremail').trim(),
      consignorGstin:         val('cnorgst').trim(),
      consignorAddress:       val('cnoraddr').trim(),
      consigneeName:          val('cneename').trim(),
      consigneeContactPerson: val('cneecp').trim(),
      consigneeContact:       val('cneecontact').trim(),
      consigneeEmail:         val('cneeemail').trim(),
      consigneeGstin:         val('cneegst').trim(),
      consigneeAddress:       val('cneeaddr').trim(),
      /* transport */
      vehicleNumber:       val('vehicle').trim(),
      vehicleType:         val('vtype').trim(),
      driverName:          val('driver').trim(),
      driverMobile:        val('drivermob').trim(),
      transportMode:       val('tmode').trim() || 'Road',
      dispatchMode:        val('dispatch').trim() || 'Door',
      ewayBill:            val('eway').trim(),
      estimatedDelivery:   val('eta').trim(),
      /* cargo */
      actualWeight:        val('aweight').trim(),
      chargedWeight:       val('cweight').trim(),
      packages:            val('pkg').trim(),
      packingMethod:       val('packing').trim(),
      materialType:        val('material').trim(),
      /* charges (canonical breakdown) */
      freight:             numv('freight'),
      fov:                 numv('fov'),
      labour:              numv('labour'),
      localCollection:     numv('localcol'),
      doorDelivery:        numv('doordel'),
      docketCharges:       numv('docket'),
      discount:            numv('discount'),
      sgstRate:            numv('sgst'),
      cgstRate:            numv('cgst'),
      /* payment */
      advanceReceived:     numv('advance'),
      receivedAmount:      numv('received'),
      paymentStatus:       val('status') || (SHIP.getOrderSync(lrDoc.orderId) || {}).paymentStatus || 'pending',
      gstPayableBy:        val('gstby').trim() || 'Consignee',
      /* notes */
      insuranceDetails:    val('insurance').trim(),
      specialInstructions: val('special').trim(),
      remarks:             val('remarks').trim(),
      updatedAt:           firebase.firestore.FieldValue.serverTimestamp()
    };
    if (orderUpdate.paymentStatus === 'paid') {
      orderUpdate.paymentDate = firebase.firestore.FieldValue.serverTimestamp();
    }

    /* Bump the documents' updatedAt so their realtime listeners refire and
       re-project from the freshly-saved order. */
    var stamp = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };

    var batch = fbDB.batch();
    batch.update(fbDB.collection('orders').doc(lrDoc.orderId), orderUpdate);
    batch.update(fbDB.collection('lorryReceipts').doc(lrDoc._docId), stamp);
    if (lrDoc.invoiceId) batch.update(fbDB.collection('invoices').doc(lrDoc.invoiceId), stamp);

    /* Capture prior payment totals so accounting can post only the DELTA. */
    var priorRecv = SHIP.computeCharges(SHIP.getOrderSync(lrDoc.orderId) || {}).received +
                    SHIP.computeCharges(SHIP.getOrderSync(lrDoc.orderId) || {}).advance;

    /* Optimistically refresh the local order cache so re-render is instant. */
    var cachedOrder = SHIP.getOrderSync(lrDoc.orderId);
    if (cachedOrder) SHIP.primeOrder(Object.assign({}, cachedOrder, orderUpdate));

    batch.commit().then(function () {
      if (msg) { msg.className = 'fst ok'; msg.textContent = '\u2713 Shipment updated. Invoice, LR, accounting and both dashboards now reflect the changes.'; }
      toast(true, (lrDoc.lrNumber || lrDoc.orderId) + ' updated');

      EGC.reliableNotify(lrDoc.customerUid, 'shipment_updated',
        'Your shipment ' + (lrDoc.orderId || '') + ' was updated with the latest transport and billing details.',
        { lrNumber: lrDoc.lrNumber, orderId: lrDoc.orderId, invoiceId: lrDoc.invoiceId });
      EGC.reliableAudit('notification_sent', 'Shipment ' + (lrDoc.orderId || '') + ' update notice sent.',
        { targetType: 'notification', targetId: lrDoc.customerUid, orderId: lrDoc.orderId, newValue: 'shipment_updated' });
      EGC.reliableAudit('shipment_updated',
        'Shipment ' + lrDoc.orderId + ' updated (vehicle ' + (orderUpdate.vehicleNumber || '\u2014') + ', status ' + LR.paymentLabel(orderUpdate.paymentStatus) + ').',
        { targetType: 'order', targetId: lrDoc.orderId, orderId: lrDoc.orderId, quoteId: lrDoc.quoteId,
          previousValue: null, newValue: { vehicle: orderUpdate.vehicleNumber, paymentStatus: orderUpdate.paymentStatus } });

      var panel = $('#lredit-' + docId);
      var btn   = $('#lredit-btn-' + docId);
      if (panel) panel.style.display = 'none';
      if (btn) btn.textContent = 'Manage Shipment';

      /* ── AUTOMATIC ACCOUNTING (Manage Shipment edits) ──
         The order changed. (1) Resync the Sales entry if charges moved
         (void+repost when unpaid, delta-adjustment when partly paid).
         (2) If the recorded payment increased, post a Receipt for the delta.
         Reliable + idempotent; never blocks the save. */
      if (window.ACC && ACC.autoResyncSales) {
        var freshOrder = SHIP.getOrderSync(lrDoc.orderId) || Object.assign({}, cachedOrder, orderUpdate);
        EGC.reliable(function () {
          return ACC.loadSettings().then(function () {
            return ACC.autoResyncSales(freshOrder).then(function () {
              var newRecv = SHIP.computeCharges(freshOrder).received + SHIP.computeCharges(freshOrder).advance;
              var delta = ACC.round2(newRecv - priorRecv);
              if (delta > 0) {
                var mode = (orderUpdate.paymentMode === 'cash') ? 'cash' : 'bank';
                return ACC.autoPostReceipt(freshOrder, delta, mode);
              }
            });
          });
        }, { label: 'autopost:resync:' + lrDoc.orderId,
             persist: { kind: 'audit', args: { action: 'autopost_pending', summary: 'Accounting resync pending for ' + lrDoc.orderId, details: { orderId: lrDoc.orderId } } } });
      }
    }).catch(function (err) {
      if (msg) { msg.className = 'fst er'; msg.textContent = err.message || 'Could not save shipment changes.'; }
    });
  };

  /* =========================================================================
     OWNER MANUAL ORDER  (Phase 6, Part 1)
     ----------------------------------------------------------------------
     The traditional transport workflow: a customer phones the owner, the
     owner already knows the freight and the parties, and needs the whole
     Order → Invoice → LR → Accounting chain generated in one step with NO
     approval round-trip (the owner IS the approving authority).

     This reuses everything:
       • the SAME quote form fields (personal / commercial, company
         autocomplete + GST autofill via wireMsCompanyAutocomplete),
       • the SAME shared charge / transport / payment fields used by Manage
         Shipment,
       • SHIP.buildOrder to produce a canonical order (with an `owner`
         overrides bundle for the pre-known pricing), and
       • OWN.runOrderPipeline — the EXACT pipeline the quote approval uses.

     The resulting order is indistinguishable from a quote-derived one and
     is fully editable afterwards through Manage Shipment.
  ========================================================================= */
  var _creatingManual = false;

  window.OWN.openManualOrder = function () {
    var modal = $('#manualModal');
    if (!modal) return;
    modal.classList.add('on');
    document.body.style.overflow = 'hidden';
    /* default to commercial, fresh form */
    OWN.manualPickType('commercial');
    var form = $('#manualForm');
    if (form) form.reset();
    OWN.manualPickType('commercial');
    if (window.CO) CO.load();
    var msg = $('#manualMsg'); if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  };

  window.OWN.closeManualOrder = function () {
    var modal = $('#manualModal');
    if (!modal) return;
    modal.classList.remove('on');
    document.body.style.overflow = '';
  };

  window.OWN.manualPickType = function (type) {
    var isPersonal = type === 'personal';
    var hid = $('#mShipmentType'); if (hid) hid.value = type;
    var comm = $('#mCommercialBlock'); if (comm) comm.style.display = isPersonal ? 'none' : 'block';
    var pers = $('#mPersonalBlock');   if (pers) pers.style.display = isPersonal ? 'block' : 'none';
    $all('.m-type-card').forEach(function (c) { c.classList.toggle('on', c.dataset.mtype === type); });
  };

  /* Reusable company autocomplete for the manual-order modal — same
     behaviour as the customer quote form's wireCompanyAutocomplete, bound to
     the modal's field ids. */
  function wireMsCompanyAutocomplete(cfg) {
    var input = $('#' + cfg.nameId);
    var box   = $('#' + cfg.suggestId);
    if (!input || !box) return;
    function setVal(id, v) { var el = $('#' + id); if (el) el.value = v || ''; }
    function fill(co) {
      setVal(cfg.gstId, co.gst); setVal(cfg.addressId, co.registeredAddress);
      setVal(cfg.cityId, co.city); setVal(cfg.stateId, co.state);
      setVal(cfg.contactId, co.contactPerson); setVal(cfg.mobileId, co.phone);
      setVal(cfg.emailId, co.email);
      input.value = co.name; input.dataset.coId = co._id || '';
      box.classList.remove('on'); box.innerHTML = '';
      if (cfg.recall) offerLastShipment(co);
    }
    /* Remove the owner's memory burden: if we remembered this customer's last
       route/consignee/material, offer to reuse it in one click. Never auto-fills
       — the owner taps to accept, or ignores it. */
    function offerLastShipment(co) {
      var holder = $('#' + cfg.recall);
      if (!holder) return;
      holder.innerHTML = '';
      var ls = co.lastShipment;
      if (!ls || !(ls.pickup || ls.delivery || ls.consigneeName)) return;
      var route = (ls.pickup || '?') + ' \u2192 ' + (ls.delivery || '?');
      var bits = [route];
      if (ls.consigneeName) bits.push('to ' + ls.consigneeName);
      if (ls.materialType) bits.push(ls.materialType);
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ms-recall';
      chip.innerHTML = '<span>Same as last time? <strong>' + EGC.esc(bits.join(' \u00B7 ')) + '</strong></span><span class="ms-recall-use">Use</span>';
      chip.addEventListener('click', function () {
        if (ls.pickup) setVal('mPickup', ls.pickup);
        if (ls.delivery) setVal('mDelivery', ls.delivery);
        if (ls.consigneeName) setVal('mConsigneeName', ls.consigneeName);
        if (ls.materialType) { var mt = $('#mMaterial'); if (mt) { mt.value = ls.materialType; } }
        holder.innerHTML = '<span class="ms-recall-done">\u2713 Filled from the last shipment — edit anything that\u2019s different.</span>';
      });
      holder.appendChild(chip);
    }
    function render(matches, term) {
      var html = '';
      matches.forEach(function (co) {
        html += '<div class="co-suggest-item" data-msid="' + EGC.esc(co._id) + '">' +
                  '<div class="co-nm">' + EGC.esc(co.name) + '</div>' +
                  '<div class="co-meta">' + (co.gst ? ('GST ' + EGC.esc(co.gst) + ' \u00B7 ') : '') + EGC.esc(co.city || '') + (co.state ? (', ' + EGC.esc(co.state)) : '') + '</div>' +
                '</div>';
      });
      html += '<div class="co-suggest-add" data-msadd="1">+ Add new company "' + EGC.esc(term) + '"</div>';
      box.innerHTML = html; box.classList.add('on');
    }
    input.addEventListener('input', function () {
      input.dataset.coId = '';
      var term = input.value.trim();
      if (!window.CO || term.length < 2) { box.classList.remove('on'); return; }
      CO.load().then(function () { render(CO.search(term), term); });
    });
    input.addEventListener('focus', function () {
      var term = input.value.trim();
      if (window.CO && term.length >= 2) CO.load().then(function () { render(CO.search(term), term); });
    });
    document.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.co-suggest-item') : null;
      var add  = e.target.closest ? e.target.closest('.co-suggest-add')  : null;
      if (item && box.contains(item)) { var co = CO.findBySlug(item.dataset.msid); if (co) fill(co); }
      else if (add && box.contains(add)) { box.classList.remove('on'); var g = $('#' + cfg.contactId); if (g) g.focus(); }
      else if (!box.contains(e.target) && e.target !== input) { box.classList.remove('on'); }
    });
  }

  window.OWN.submitManualOrder = function () {
    if (_creatingManual) return;
    var msg = $('#manualMsg');
    function fv(id) { var el = $('#' + id); return el ? String(el.value || '').trim() : ''; }
    function setErr(t) { if (msg) { msg.style.display = 'block'; msg.className = 'fst er'; msg.textContent = t; } }
    function setOk(t)  { if (msg) { msg.style.display = 'block'; msg.className = 'fst ok'; msg.textContent = t; } }

    var shipmentType = fv('mShipmentType') || 'commercial';
    var isPersonal   = shipmentType === 'personal';
    var allocated    = null;   // hoisted so the success handler can offer next-step print

    /* ---- assemble a synthetic "quote" object in the SAME shape the customer
            quote form produces, so SHIP.buildOrder maps it identically ---- */
    var quote = {
      shipmentType: shipmentType,
      pickup:       fv('mPickup'),
      delivery:     fv('mDelivery'),
      materialType: fv('mMaterial'),
      weight:       fv('mWeight'),
      packages:     fv('mPackages'),
      pickupDate:   fv('mPickupDate'),
      notes:        fv('mNotes'),
      customerUid:  null
    };

    /* common required fields */
    if (!quote.pickup || !quote.delivery || !quote.materialType || !quote.weight) {
      setErr('Please fill pickup, delivery, material and weight.'); return;
    }

    if (isPersonal) {
      quote.senderName     = fv('mSenderName');
      quote.senderMobile   = fv('mSenderMobile');
      quote.senderEmail    = fv('mSenderEmail');
      quote.pickupAddress  = fv('mPickupAddress');
      quote.receiverName   = fv('mReceiverName');
      quote.receiverMobile = fv('mReceiverMobile');
      quote.deliveryAddress = fv('mDeliveryAddress');
      quote.customerName   = quote.senderName;
      quote.customerPhone  = quote.senderMobile;
      quote.customerEmail  = quote.senderEmail;
      if (!quote.senderName || !quote.senderMobile || !quote.pickupAddress ||
          !quote.receiverName || !quote.receiverMobile || !quote.deliveryAddress) {
        setErr('Please complete sender, receiver and address details.'); return;
      }
    } else {
      /* Consignor (FROM) */
      quote.companyName       = fv('mCompanyName');
      quote.contactPerson     = fv('mContactPerson');
      quote.companyMobile     = fv('mCompanyMobile');
      quote.companyEmail      = fv('mCompanyEmail');
      quote.customerGst       = fv('mGst');
      quote.registeredAddress = fv('mRegAddress');
      quote.city              = fv('mCity');
      quote.state             = fv('mState');
      /* Consignee (TO) */
      quote.consigneeName          = fv('mConsigneeName');
      quote.consigneeContactPerson = fv('mConsigneeContactPerson');
      quote.consigneeContact       = fv('mConsigneeMobile');
      quote.consigneeEmail         = fv('mConsigneeEmail');
      quote.consigneeGstin         = fv('mConsigneeGst');
      quote.consigneeAddress       = fv('mConsigneeAddress');
      quote.consigneeCity          = fv('mConsigneeCity');
      quote.consigneeState         = fv('mConsigneeState');
      quote.customerName           = quote.companyName;
      quote.customerPhone          = quote.companyMobile;
      quote.customerEmail          = quote.companyEmail;
      if (!quote.companyName || !quote.consigneeName) {
        setErr('Please enter both the sender (consignor) and receiver (consignee) company names.'); return;
      }
    }

    /* ---- owner-known pricing & transport (the manual-order extras) ---- */
    var freight = INV.toNum(fv('mFreight'));
    if (!(freight > 0)) { setErr('Enter a freight amount greater than \u20B90.'); return; }

    var owner = {
      freight:         freight,
      haltingCharges:  INV.toNum(fv('mHalting')),
      extraCharges:    INV.toNum(fv('mExtra')),
      discount:        INV.toNum(fv('mDiscount')),
      advanceReceived: INV.toNum(fv('mAdvance')),
      vehicleNumber:   fv('mVehicle'),
      driverName:      fv('mDriver'),
      driverMobile:    fv('mDriverMobile'),
      estimatedDelivery: fv('mEta'),
      ewayBill:        fv('mEway'),
      remarks:         quote.notes
    };

    /* validation parity with Manage Shipment: discount can't exceed charges */
    var chargeSubtotal = owner.freight + owner.haltingCharges + owner.extraCharges;
    if (owner.discount > chargeSubtotal) {
      setErr('Discount (\u20B9' + owner.discount + ') cannot exceed the charges subtotal (\u20B9' + chargeSubtotal + ').'); return;
    }
    if (owner.advanceReceived > chargeSubtotal - owner.discount + 1) {
      setErr('Advance received cannot exceed the order total.'); return;
    }

    _creatingManual = true;
    var btn = $('#manualSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating order\u2026'; }

    /* Save / refresh the commercial companies in the directory (non-blocking),
       exactly like the customer quote form does. */
    var coPromise = Promise.resolve();
    if (!isPersonal && window.CO) {
      var saves = [];
      if (quote.companyName) saves.push(CO.save({
        name: quote.companyName, gst: quote.customerGst, registeredAddress: quote.registeredAddress,
        city: quote.city, state: quote.state, contactPerson: quote.contactPerson,
        email: quote.companyEmail, phone: quote.companyMobile,
        lastShipment: { pickup: quote.pickup, delivery: quote.delivery, consigneeName: quote.consigneeName, materialType: quote.materialType }
      }).catch(function () {}));
      if (quote.consigneeName) saves.push(CO.save({
        name: quote.consigneeName, gst: quote.consigneeGstin, registeredAddress: quote.consigneeAddress,
        city: quote.consigneeCity, state: quote.consigneeState, contactPerson: quote.consigneeContactPerson,
        email: quote.consigneeEmail, phone: quote.consigneeContact
      }).catch(function () {}));
      coPromise = Promise.all(saves).catch(function () {});
    }

    coPromise.then(function () {
      return Promise.all([EGC.nextOrderId(), EGC.nextInvoiceId(), INV.nextLrNumber(), LR.nextDocketNumber()]);
    }).then(function (ids) {
      allocated = { orderId: ids[0], invoiceId: ids[1], lrNumber: ids[2], docketNo: ids[3] };

      var orderData = SHIP.buildOrder({
        orderId:   allocated.orderId,
        quoteId:   null,                 /* no quote — pure owner order */
        invoiceId: allocated.invoiceId,
        lrNumber:  allocated.lrNumber,
        quote:     quote,
        pricing:   { freight: freight },
        owner:     owner                 /* the pre-known pricing/transport */
      });
      orderData.status           = EGC.ORDER_STATUS.APPROVED;
      orderData.invoiceGenerated = true;
      orderData.lrGenerated      = true;

      return window.OWN.runOrderPipeline(orderData, allocated, {
        /* no quoteRef → manual batch path; owner is the authority */
        freight: freight,
        notify:  false,                  /* phone customer has no account */
        onAudit: 'manual'
      });
    }).then(function (orderId) {
      setOk('\u2713 Order ' + orderId + ' created — invoice, Lorry Receipt and accounting entries are ready.');
      toast(true, 'Manual order ' + orderId + ' created');
      var form = $('#manualForm'); if (form) form.reset();
      /* Workflow continuity: a phone booking's natural next step is handing the
         customer their bilty (LR) + invoice. Offer it right here in one click,
         instead of closing and making the owner hunt for the new order. */
      var msgEl = $('#manualMsg');
      if (msgEl && allocated && allocated.lrNumber) {
        var next = document.createElement('div');
        next.style.marginTop = '12px';
        next.style.display = 'flex';
        next.style.gap = '8px';
        next.style.flexWrap = 'wrap';
        next.innerHTML =
          '<button type="button" class="btn-a btn-sm" id="mnext-print">Print LR + Invoice</button>' +
          '<button type="button" class="btn-ghost btn-sm" id="mnext-done">Done</button>';
        msgEl.appendChild(next);
        var pBtn = document.getElementById('mnext-print');
        if (pBtn) pBtn.addEventListener('click', function () {
          // caches refresh via onSnapshot; if the new LR isn't cached yet,
          // printCombined shows a friendly "try again in a moment" toast.
          OWN.printCombined(allocated.lrNumber);
        });
        var dBtn = document.getElementById('mnext-done');
        if (dBtn) dBtn.addEventListener('click', function () { OWN.closeManualOrder(); openTab('orders'); });
      } else {
        setTimeout(function () { OWN.closeManualOrder(); openTab('orders'); }, 1400);
      }
    }).catch(function (err) {
      setErr((err && err.message) || 'Could not create the order.');
      toast(false, 'Manual order failed');
    }).finally(function () {
      _creatingManual = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Create Order'; }
    });
  };

  /* Wire the two company autocompletes in the manual-order modal once. */
  wireMsCompanyAutocomplete({
    nameId: 'mCompanyName', suggestId: 'mCoSuggest',
    gstId: 'mGst', addressId: 'mRegAddress', cityId: 'mCity', stateId: 'mState',
    contactId: 'mContactPerson', mobileId: 'mCompanyMobile', emailId: 'mCompanyEmail',
    recall: 'mRecall'
  });
  wireMsCompanyAutocomplete({
    nameId: 'mConsigneeName', suggestId: 'mCoSuggestTo',
    gstId: 'mConsigneeGst', addressId: 'mConsigneeAddress', cityId: 'mConsigneeCity', stateId: 'mConsigneeState',
    contactId: 'mConsigneeContactPerson', mobileId: 'mConsigneeMobile', emailId: 'mConsigneeEmail'
  });

})();

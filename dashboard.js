/* ============================================================
   DASHBOARD.JS — Customer Dashboard — Express Goods Carrier
   Phase 4 — UI Cleanup & Activity Tab Migration

   FIXED:
   - onSnapshot listeners on quotes, orders, notifications, activityLog
   - Notifications panel with real-time badge count
   - Revised quote shows Accept / Reject Revision buttons
   - Quote History table with all statuses
   - Activity tab with paginated feed from Firestore activityLog
   - Total Shipments counter
   - Removed: Recent Quotes widget (redundant with Quote History)
   - Removed: Recent Activity home card (moved to Activity tab)
   ============================================================ */

(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  window.CUST = window.CUST || {};

  /* ---------------------------------------------------------
     TABS
  --------------------------------------------------------- */
  function openTab(name) {
    $all('.dash-tab').forEach(function (t) { t.classList.toggle('on', t.dataset.tab === name); });
    $all('.dash-panel').forEach(function (p) { p.classList.toggle('on', p.id === 'panel-' + name); });
    history.replaceState(null, '', '#' + name);
  }
  $all('.dash-tab').forEach(function (t) {
    t.addEventListener('click', function () { openTab(t.dataset.tab); });
  });
  /* Land on the most useful view by default. A bare '#home' has no panel, so a
     fresh visit would otherwise show a blank screen — default to the shipment
     overview (their current delivery), which is what a customer opens to see. */
  var KNOWN_TABS = ['shipment', 'quotes', 'orders', 'tracking', 'invoices', 'notifications', 'activity', 'routes', 'profile', 'support'];
  var requested = (location.hash || '').replace('#', '');
  var initialTab = KNOWN_TABS.indexOf(requested) !== -1 ? requested : 'shipment';
  openTab(initialTab);

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
     AUTH + BOOTSTRAP
  --------------------------------------------------------- */
  var currentUser = null;
  var unsubFns    = [];
  var custOrdersCache = [];

  TOS.onReady(function (user) {
    var guard = $('#guard');
    var main  = $('#dashMain');

    if (!user) {
      location.href = 'auth.html';
      return;
    }

    /* Owner → redirect to owner dashboard */
    if (EGC.isOwnerEmail(user.email)) {
      location.href = 'owner-dashboard.html';
      return;
    }

    currentUser = user;

    /* B3: replay any audit/notification follow-ups that failed previously. */
    if (EGC.flushReliableQueue) EGC.flushReliableQueue();

    if (guard) guard.classList.add('fade-out');
    if (main)  { main.style.display = 'block'; requestAnimationFrame(function () { main.classList.add('visible'); }); }
    setTimeout(function () { if (guard) guard.style.display = 'none'; }, 380);

    /* Update header */
    var nameEl   = $('#userName');
    var emailEl  = $('#userEmail');
    var avatarEl = $('#userAvatar');
    if (nameEl)  nameEl.textContent  = user.displayName || user.email.split('@')[0];
    if (emailEl) emailEl.textContent = user.email;
    if (avatarEl && user.photoURL) {
      avatarEl.src = user.photoURL;
      avatarEl.style.display = 'block';
    }

    /* Start all real-time listeners */
    startListeners(user.uid, user.email);
  });

  /* ---------------------------------------------------------
     LISTENERS — all use onSnapshot for real-time updates
  --------------------------------------------------------- */
  function startListeners(uid, email) {
    /* Clean up any previous listeners */
    unsubFns.forEach(function (fn) { fn(); });
    unsubFns = [];

    unsubFns.push(listenQuotes(uid));
    unsubFns.push(listenOrders(uid));
    unsubFns.push(listenNotifications(uid));
    unsubFns.push(listenActivity(uid));
    unsubFns.push(listenInvoices(uid));
  }

  /* ===========================================================
     QUOTES LISTENER
  =========================================================== */
  function listenQuotes(uid) {
    return fbDB.collection('quotes')
      .where('customerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var quotes = [];
        snap.forEach(function (doc) { quotes.push(doc.data()); });

        /* Stats */
        var totalEl = $('#statTotal');
        if (totalEl) totalEl.textContent = String(quotes.length);

        renderQuoteHistory(quotes);
        renderRevisionReview(quotes);
        checkRevisedQuotes(quotes);

      }, function (err) {
        console.error('[DASH][quotes] listener ERROR for uid =', uid, '| code =', err.code, '| message =', err.message);
      });
  }

  /* Quote History table with full detail + action buttons */
  function renderQuoteHistory(quotes) {
    var tbody = $('#quoteHistoryBody');
    var empty = $('#quoteHistoryEmpty');
    if (!tbody) return;

    if (!quotes.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = quotes.map(function (q) {
      var badge = '<span class="st-badge ' + EGC.quoteStatusClass(q.status) + '">' +
        '<span class="st-dot"></span>' + EGC.quoteStatusLabel(q.status) + '</span>';

      /* Revised: show accept/reject buttons */
      var actionCell = '';
      if (q.status === 'revised_by_owner') {
        actionCell = (
          '<td class="qt-actions">' +
            '<button class="btn-ok btn-xs" onclick="CUST.acceptRevision(\'' + q.quoteId + '\')">Accept</button>' +
            '<button class="btn-danger btn-xs" onclick="CUST.rejectRevision(\'' + q.quoteId + '\')">Reject</button>' +
          '</td>'
        );
      } else {
        actionCell = '<td class="qt-actions"></td>';
      }

      /* Revised price indicator */
      var priceCell = q.revisedPrice
        ? '<span class="revised-price-tag">\u20B9' + EGC.esc(q.revisedPrice) + ' revised</span>'
        : '';

      return (
        '<tr>' +
          '<td class="qt-id">' + EGC.esc(q.quoteId) + '</td>' +
          '<td>' + EGC.esc(q.pickup) + '</td>' +
          '<td>' + EGC.esc(q.delivery) + '</td>' +
          '<td>' + EGC.esc(q.materialType || '—') + '</td>' +
          '<td>' + badge + priceCell + '</td>' +
          '<td>' + EGC.fmtDate(q.createdAt) + '</td>' +
          '<td>' + EGC.fmtDate(q.updatedAt) + '</td>' +
          actionCell +
        '</tr>'
      );
    }).join('');
  }

  /* Watch for revised quotes and show prominent banner on home */
  function checkRevisedQuotes(quotes) {
    var revised = quotes.filter(function (q) { return q.status === 'revised_by_owner'; });
    var banner  = $('#revisedAlert');
    if (!banner) return;
    if (revised.length) {
      banner.style.display = 'flex';
      banner.innerHTML = (
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
        '<span>You have <strong>' + revised.length + '</strong> revised quote' + (revised.length > 1 ? 's' : '') + ' waiting for your response.</span>' +
        '<a href="#" class="alert-link" onclick="openTab(\'quotes\');return false;">Review Now \u2192</a>'
      );
    } else {
      banner.style.display = 'none';
    }
  }

  /* ===========================================================
     REVISION REVIEW — clear Original Request -> Owner Revision
     -> Revision Note -> Accept/Reject flow for revised quotes.
     Presentation only — no change to the underlying workflow.
  =========================================================== */
  function plainFieldRow(label, value) {
    return '<div class="rv-field"><span>' + label + '</span><strong>' + EGC.esc(value) + '</strong></div>';
  }

  function changedFieldRow(label, original, revised) {
    var changed = original != null && String(original) !== String(revised);
    return (
      '<div class="rv-field">' +
        '<span>' + label + '</span>' +
        '<strong class="' + (changed ? 'rv-changed' : '') + '">' + EGC.esc(revised) + (changed ? ' <span class="rv-changed-tag">changed</span>' : '') + '</strong>' +
      '</div>'
    );
  }

  function renderRevisionReview(quotes) {
    var section = $('#revisionReviewSection');
    var list    = $('#revisionReviewList');
    if (!section || !list) return;

    var revised = quotes.filter(function (q) { return q.status === 'revised_by_owner'; });

    if (!revised.length) {
      section.style.display = 'none';
      list.innerHTML = '';
      return;
    }
    section.style.display = 'block';

    list.innerHTML = revised.map(function (q) {
      var hasOriginal = q.originalPickup != null;
      var origRoute = hasOriginal ? (q.originalPickup + ' \u2192 ' + q.originalDelivery) : (q.pickup + ' \u2192 ' + q.delivery);
      var newRoute  = q.pickup + ' \u2192 ' + q.delivery;

      return (
        '<div class="rv-card">' +
          '<div class="rv-card-head">' +
            '<div class="rv-card-id">' + EGC.esc(q.quoteId) + '</div>' +
            '<span class="st-badge st-revised"><span class="st-dot"></span>Awaiting Your Response</span>' +
          '</div>' +

          '<div class="rv-step">' +
            '<div class="rv-step-label rv-step-original">Original Request</div>' +
            '<div class="rv-fields">' +
              plainFieldRow('Route', origRoute) +
              plainFieldRow('Weight', (hasOriginal ? q.originalWeight : q.weight) + ' kg') +
              plainFieldRow('Packages', hasOriginal ? q.originalPackages : q.packages) +
            '</div>' +
          '</div>' +

          '<div class="rv-arrow">\u2193</div>' +

          '<div class="rv-step">' +
            '<div class="rv-step-label rv-step-revised">Owner Revision' + (q.revisedPrice ? ' \u2014 \u20B9' + EGC.esc(q.revisedPrice) : '') + '</div>' +
            '<div class="rv-fields">' +
              changedFieldRow('Route', origRoute, newRoute) +
              changedFieldRow('Weight', hasOriginal ? q.originalWeight + ' kg' : null, q.weight + ' kg') +
              changedFieldRow('Packages', hasOriginal ? q.originalPackages : null, q.packages) +
            '</div>' +
          '</div>' +

          (q.ownerComment ? (
            '<div class="rv-arrow">\u2193</div>' +
            '<div class="rv-step">' +
              '<div class="rv-step-label rv-step-note">Revision Note \u2014 why this changed</div>' +
              '<div class="rv-note">' + EGC.esc(q.ownerComment) + '</div>' +
            '</div>'
          ) : '') +

          '<div class="rv-arrow">\u2193</div>' +
          '<div class="rv-step">' +
            '<div class="rv-step-label">Action Required</div>' +
            '<p class="rv-help">Review the changes above. Accept to send this quote back for owner approval, or reject if it no longer works for you.</p>' +
            '<div class="rv-actions">' +
              '<button class="btn-ok" onclick="CUST.acceptRevision(\'' + q.quoteId + '\')">Accept Revision</button>' +
              '<button class="btn-danger" onclick="CUST.rejectRevision(\'' + q.quoteId + '\')">Reject Revision</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ===========================================================
     ORDERS LISTENER
  =========================================================== */
  function listenOrders(uid) {
    return fbDB.collection('orders')
      .where('customerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var orders = [];
        snap.forEach(function (doc) {
          var o = doc.data();
          orders.push(o);
          /* Prime the SSoT cache so the customer's invoice/LR cards and
             downloads project from the master order. */
          if (window.SHIP) SHIP.primeOrder(o);
        });
        custOrdersCache = orders;

        /* Update stats */
        var shipEl = $('#statShipments');
        if (shipEl) shipEl.textContent = String(orders.length);

        var activeEl = $('#statActiveOrders');
        if (activeEl) {
          var active = orders.filter(function (o) { return o.status !== 'delivered'; }).length;
          activeEl.textContent = String(active);
        }

        renderOrderHistory(orders);
        /* SSoT: order changes must refresh the projected invoice cards. */
        if (typeof renderCustInvoices === 'function' && typeof custInvCache !== 'undefined' && custInvCache) renderCustInvoices(custInvCache);
        /* Keep an open Tracking hub showing the latest data. */
        if (typeof refreshTracking === 'function') refreshTracking();

      }, function (err) {
        console.error('[DASH][orders] listener ERROR for uid =', uid, '| code =', err.code, '| message =', err.message);
      });
  }

  /* Build the Quote -> Delivery timeline for an order.
     The order doc only exists once a quote was submitted AND approved,
     so those two steps plus "Order Created" are always complete.
     The remaining steps follow EGC.ORDER_STATUS_SEQUENCE. */
  function buildOrderTimeline(o) {
    var labels = ['Quote Submitted', 'Quote Approved', 'Order Created', 'Truck Assigned', 'Loading', 'In Transit', 'Delivered'];
    var seq    = EGC.ORDER_STATUS_SEQUENCE; /* ['approved','truck_assigned','loading','in_transit','delivered'] */
    var seqIdx = seq.indexOf(o.status);
    if (seqIdx < 0) seqIdx = 0;
    var overallIdx  = 2 + seqIdx; /* offset for the 2 pre-order steps */
    var isDelivered = o.status === 'delivered';

    var html = labels.map(function (label, i) {
      var cls = '';
      if (isDelivered)            cls = 'tl-done';
      else if (i < overallIdx)    cls = 'tl-done';
      else if (i === overallIdx)  cls = 'tl-active';
      var step = '<div class="tl-step ' + cls + '"><div class="tl-dot"></div><div class="tl-label">' + label + '</div></div>';
      if (i < labels.length - 1) step += '<div class="tl-line"></div>';
      return step;
    }).join('');

    return '<div class="order-timeline">' + html + '</div>';
  }

  function renderOrderHistory(orders) {
    var list  = $('#orderHistoryList');
    var empty = $('#orderHistoryEmpty');
    if (!list) return;

    if (!orders.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = orders.map(function (o) {
      var badge = '<span class="st-badge ' + EGC.orderStatusClass(o.status) + '">' +
        '<span class="st-dot"></span>' + EGC.orderStatusLabel(o.status) + '</span>';

      var priceRow = o.revisedPrice
        ? '<div class="orow-meta"><span style="color:var(--amber);">\u20B9' + EGC.esc(o.revisedPrice) + '</span></div>'
        : '';

      return (
        '<div class="order-card">' +
          '<div class="order-card-top">' +
            '<div>' +
              '<div class="order-id">' + EGC.esc(o.orderId) + '</div>' +
              '<div class="order-quote-ref">Quote: ' + EGC.esc(o.quoteId || '') + '</div>' +
            '</div>' +
            badge +
          '</div>' +
          '<div class="order-route">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3 3 0 003-3v-2a3 3 0 00-3-3H9a3 3 0 01-3-3V6.5"/></svg>' +
            '<span>' + EGC.esc(o.pickup) + ' \u2192 ' + EGC.esc(o.delivery) + '</span>' +
          '</div>' +
          priceRow +
          buildOrderTimeline(o) +
          '<div class="order-dates">' +
            '<span>Created: ' + EGC.fmtDate(o.createdAt) + '</span>' +
            '<span>Updated: ' + EGC.fmtDate(o.updatedAt) + '</span>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ===========================================================
     NOTIFICATIONS LISTENER
  =========================================================== */
  function listenNotifications(uid) {
    return fbDB.collection('notifications')
      .where('customerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var notifs = [];
        snap.forEach(function (doc) { notifs.push(Object.assign({ _id: doc.id }, doc.data())); });

        var unreadCount = notifs.filter(function (n) { return !n.read; }).length;

        /* Badge (bell icon) */
        var badge = $('#notifBadge');
        if (badge) {
          badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
          badge.style.display = unreadCount ? 'flex' : 'none';
        }

        /* Stat card on home panel */
        var statEl = $('#statNotifs');
        if (statEl) statEl.textContent = String(unreadCount);

        renderNotifications(notifs);

      }, function (err) {
        console.error('[DASH][notifications] listener ERROR for uid =', uid, '| code =', err.code, '| message =', err.message);
      });
  }

  var notifIconMap = {
    quote_submitted:    { svg: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>', cls: 'ni-submit' },
    quote_revised:      { svg: '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/>', cls: 'ni-revised' },
    quote_approved:     { svg: '<polyline points="20 6 9 17 4 12"/>', cls: 'ni-ok' },
    quote_rejected:     { svg: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', cls: 'ni-bad' },
    order_created:      { svg: '<rect x="1" y="6" width="14" height="10"/><path d="M15 9h4l3 3v4h-7"/>', cls: 'ni-ok' },
    order_status_update:{ svg: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', cls: 'ni-progress' },
    customer_accepted:  { svg: '<polyline points="20 6 9 17 4 12"/>', cls: 'ni-ok' },
    customer_rejected:  { svg: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', cls: 'ni-bad' }
  };

  function renderNotifications(notifs) {
    var list  = $('#notifList');
    var empty = $('#notifEmpty');
    if (!list) return;

    if (!notifs.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = notifs.map(function (n) {
      var ic  = notifIconMap[n.type] || { svg: '<circle cx="12" cy="12" r="10"/>', cls: 'ni-submit' };
      var svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">' + ic.svg + '</svg>';
      var unreadMark = !n.read ? '<span class="notif-unread-dot"></span>' : '';
      return (
        '<div class="notif-item' + (!n.read ? ' notif-unread' : '') + '" onclick="CUST.markRead(\'' + n._id + '\')">' +
          '<div class="notif-icon ' + ic.cls + '">' + svg + '</div>' +
          '<div class="notif-body">' +
            '<div class="notif-msg">' + EGC.esc(n.message) + '</div>' +
            '<div class="notif-when">' + EGC.fmtWhen(n.createdAt) + '</div>' +
          '</div>' +
          unreadMark +
        '</div>'
      );
    }).join('');
  }

  /* ===========================================================
     ACTIVITY LOG LISTENER — paginated (10 initially, Load More)
  =========================================================== */
  var ACTIVITY_PAGE_SIZE  = 10;
  var activityLimitCount  = ACTIVITY_PAGE_SIZE;
  var activityUnsubInner  = null; /* the live onSnapshot unsubscribe for the current page size */

  function subscribeActivity(uid, limitCount) {
    /* Always tear down the previous listener before opening a new one
       at a larger page size — avoids stacking duplicate listeners. */
    if (activityUnsubInner) { activityUnsubInner(); activityUnsubInner = null; }

    activityUnsubInner = fbDB.collection('activityLog').doc(uid).collection('entries')
      .orderBy('createdAt', 'desc')
      .limit(limitCount)
      .onSnapshot(function (snap) {
        var entries = [];
        snap.forEach(function (doc) { entries.push(doc.data()); });
        /* If we got back exactly as many as we asked for, there may be more. */
        renderActivity(entries, snap.size >= limitCount);
      }, function (err) {
        console.error('[DASH] activity listener:', err.code, err.message);
      });
  }

  function listenActivity(uid) {
    activityLimitCount = ACTIVITY_PAGE_SIZE;
    subscribeActivity(uid, activityLimitCount);
    /* Stable unsubscribe handed back to startListeners() for cleanup —
       always closes whichever inner listener is currently live. */
    return function () { if (activityUnsubInner) { activityUnsubInner(); activityUnsubInner = null; } };
  }

  window.CUST.loadMoreActivity = function () {
    if (!currentUser) return;
    var btn = $('#activityLoadMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    activityLimitCount += ACTIVITY_PAGE_SIZE;
    subscribeActivity(currentUser.uid, activityLimitCount);
  };

  var activityIconMap = {
    quote_submitted:    { svg: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>', cls: 'ai-submit' },
    quote_revised:      { svg: '<path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/>', cls: 'ai-revised' },
    quote_approved:     { svg: '<polyline points="20 6 9 17 4 12"/>', cls: 'ai-ok' },
    quote_rejected:     { svg: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', cls: 'ai-bad' },
    order_created:      { svg: '<rect x="1" y="6" width="14" height="10"/><path d="M15 9h4l3 3v4h-7"/>', cls: 'ai-ok' },
    order_status_update:{ svg: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', cls: 'ai-progress' },
    quote_accepted:     { svg: '<polyline points="20 6 9 17 4 12"/>', cls: 'ai-ok' },
    quote_rejected_by_customer: { svg: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', cls: 'ai-bad' }
  };

  function renderActivity(entries, hasMore) {
    var list    = $('#activityList');
    var empty   = $('#activityEmpty');
    var moreWrap = $('#activityLoadMoreWrap');
    var moreBtn  = $('#activityLoadMoreBtn');
    if (!list) return;

    if (!entries.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (moreWrap) moreWrap.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = entries.map(function (e) {
      var ic  = activityIconMap[e.type] || { svg: '<circle cx="12" cy="12" r="10"/>', cls: 'ai-submit' };
      var svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">' + ic.svg + '</svg>';
      return (
        '<div class="activity-item">' +
          '<div class="activity-icon ' + ic.cls + '">' + svg + '</div>' +
          '<div class="activity-body">' +
            '<div class="activity-msg">' + EGC.esc(e.message) + '</div>' +
            '<div class="activity-when">' + EGC.fmtWhen(e.createdAt) + '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    if (moreWrap) moreWrap.style.display = hasMore ? 'block' : 'none';
    if (moreBtn)  { moreBtn.disabled = false; moreBtn.textContent = 'Load More Activity'; }
  }

  /* ===========================================================
     CUSTOMER ACTIONS — Accept / Reject Revision
  =========================================================== */

  /* Accept revision → status: customer_accepted */
  window.CUST.acceptRevision = function (qid) {
    if (!currentUser) return;
    /* Guard: only a quote still in 'revised_by_owner' can be accepted. A stale
       tab must not revert an already-approved/closed quote. Re-read first. */
    var ref = fbDB.collection('quotes').doc(qid);
    ref.get().then(function (snap) {
      if (!snap.exists) { toast(false, 'Quote no longer exists.'); return; }
      var cur = snap.data();
      if (cur.status !== EGC.QUOTE_STATUS.REVISED) {
        toast(false, 'This quote can no longer be changed (status: ' + (cur.status || 'unknown') + ').');
        if (typeof loadQuotes === 'function') loadQuotes();
        return;
      }
      return ref.update({
        status:     EGC.QUOTE_STATUS.CUSTOMER_ACCEPTED,
        updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
        respondedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        toast(true, 'Revision accepted \u2014 waiting for owner approval.');

        EGC.logActivity(currentUser.uid, 'quote_accepted',
          'You accepted the revised quote ' + qid + '.', { quoteId: qid });
        EGC.logAudit('quote_accepted', 'Customer accepted the revised quote ' + qid + '.', {
          targetType: 'quote', targetId: qid, quoteId: qid,
          previousValue: 'revised_by_owner', newValue: 'customer_accepted'
        });
        fbDB.collection('ownerNotifications').add({
          type:      'customer_accepted',
          message:   'Customer accepted revised quote ' + qid + '. Ready to approve.',
          quoteId:   qid, customerUid: currentUser.uid, read: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    }).catch(function (err) {
      toast(false, 'Could not accept revision: ' + err.message);
    });
  };

  /* Reject revision → status: customer_rejected */
  window.CUST.rejectRevision = function (qid) {
    if (!currentUser) return;
    var ref = fbDB.collection('quotes').doc(qid);
    ref.get().then(function (snap) {
      if (!snap.exists) { toast(false, 'Quote no longer exists.'); return; }
      var cur = snap.data();
      if (cur.status !== EGC.QUOTE_STATUS.REVISED) {
        toast(false, 'This quote can no longer be changed (status: ' + (cur.status || 'unknown') + ').');
        if (typeof loadQuotes === 'function') loadQuotes();
        return;
      }
      return ref.update({
        status:     EGC.QUOTE_STATUS.CUSTOMER_REJECTED,
        updatedAt:  firebase.firestore.FieldValue.serverTimestamp(),
        respondedAt: firebase.firestore.FieldValue.serverTimestamp()
      }).then(function () {
        toast(true, 'Revision rejected.');
        EGC.logActivity(currentUser.uid, 'quote_rejected_by_customer',
          'You rejected the revised quote ' + qid + '.', { quoteId: qid });
        EGC.logAudit('quote_rejected', 'Customer rejected the revised quote ' + qid + '.', {
          targetType: 'quote', targetId: qid, quoteId: qid,
          previousValue: 'revised_by_owner', newValue: 'customer_rejected'
        });
        fbDB.collection('ownerNotifications').add({
          type:      'customer_rejected',
          message:   'Customer rejected the revision for quote ' + qid + '.',
          quoteId:   qid, customerUid: currentUser.uid, read: false,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    }).catch(function (err) {
      toast(false, 'Could not reject revision: ' + err.message);
    });
  };

  /* Mark notification as read */
  window.CUST.markRead = function (docId) {
    fbDB.collection('notifications').doc(docId).update({ read: true });
  };

  /* Mark all notifications as read */
  window.CUST.markAllRead = function () {
    if (!currentUser) return;
    fbDB.collection('notifications')
      .where('customerUid', '==', currentUser.uid)
      .where('read', '==', false)
      .get()
      .then(function (snap) {
        var batch = fbDB.batch();
        snap.forEach(function (doc) { batch.update(doc.ref, { read: true }); });
        return batch.commit();
      });
  };

  /* ===========================================================
     QUOTE SUBMISSION FORM (existing feature)
  =========================================================== */
  var qForm = $('#quoteForm');
  if (qForm) {
    qForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!currentUser) return;

      var btn    = qForm.querySelector('button[type=submit]');
      var errEl  = $('#quoteFormErr');
      var okEl   = $('#quoteFormOk');

      function fv(name) { var el = qForm.querySelector('[name=' + name + ']'); return el ? el.value.trim() : ''; }

      var shipmentType = fv('shipmentType') || 'commercial';
      var isPersonal   = shipmentType === 'personal';

      var data = {
        shipmentType: shipmentType,
        pickup:       fv('pickup'),
        delivery:     fv('delivery'),
        materialType: fv('materialType'),
        weight:       fv('weight'),
        packages:     fv('packages'),
        pickupDate:   qForm.querySelector('[name=pickupDate]') ? qForm.querySelector('[name=pickupDate]').value : '',
        notes:        fv('notes')
      };

      /* Validate common required fields first */
      if (!data.pickup || !data.delivery || !data.materialType || !data.weight) {
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Please fill in all required fields.'; }
        return;
      }

      /* Type-specific fields + validation */
      if (isPersonal) {
        data.senderName      = fv('senderName');
        data.senderMobile    = fv('senderMobile');
        data.senderEmail     = fv('senderEmail');
        data.pickupAddress   = fv('pickupAddress');
        data.receiverName    = fv('receiverName');
        data.receiverMobile  = fv('receiverMobile');
        data.deliveryAddress = fv('deliveryAddress');
        data.specialInstructions = data.notes;
        if (!data.senderName || !data.senderMobile || !data.pickupAddress ||
            !data.receiverName || !data.receiverMobile || !data.deliveryAddress) {
          if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Please complete sender, receiver and address details.'; }
          return;
        }
      } else {
        /* ── Consignor (FROM) ── */
        data.companyName       = fv('companyName');
        data.contactPerson     = fv('contactPerson');
        data.companyMobile     = fv('companyMobile');
        data.companyEmail      = fv('companyEmail');
        data.customerGst       = fv('customerGst');
        data.registeredAddress = fv('registeredAddress');
        data.city              = fv('city');
        data.state             = fv('state');
        /* ── Consignee (TO) ── */
        data.consigneeName          = fv('consigneeName');
        data.consigneeContactPerson = fv('consigneeContactPerson');
        data.consigneeContact       = fv('consigneeContact');
        data.consigneeEmail         = fv('consigneeEmail');
        data.consigneeGstin         = fv('consigneeGstin');
        data.consigneeAddress       = fv('consigneeAddress');
        data.consigneeCity          = fv('consigneeCity');
        data.consigneeState         = fv('consigneeState');
        data.specialInstructions = data.notes;
        if (!data.companyName || !data.consigneeName) {
          if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Please enter both the sender (consignor) and receiver (consignee) company names.'; }
          return;
        }
      }
      if (errEl) errEl.style.display = 'none';

      if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

      /* For commercial shipments, save/refresh BOTH companies in the directory
         (consignor + consignee) so each auto-fills next time. Non-blocking. */
      var coPromise = Promise.resolve();
      if (!isPersonal && window.CO) {
        var saves = [];
        if (data.companyName) {
          saves.push(window.CO.save({
            name: data.companyName, gst: data.customerGst,
            registeredAddress: data.registeredAddress, city: data.city, state: data.state,
            contactPerson: data.contactPerson || currentUser.displayName || '',
            email: data.companyEmail || currentUser.email,
            phone: data.companyMobile || currentUser.phoneNumber || ''
          }).catch(function () {}));
        }
        if (data.consigneeName) {
          saves.push(window.CO.save({
            name: data.consigneeName, gst: data.consigneeGstin,
            registeredAddress: data.consigneeAddress, city: data.consigneeCity, state: data.consigneeState,
            contactPerson: data.consigneeContactPerson || '',
            email: data.consigneeEmail || '',
            phone: data.consigneeContact || ''
          }).catch(function () {}));
        }
        coPromise = Promise.all(saves).catch(function () {});
      }

      coPromise.then(function () {
      EGC.nextQuoteId().then(function (quoteId) {
        var quoteData = Object.assign({}, data, {
          quoteId:       quoteId,
          customerUid:   currentUser.uid,
          customerName:  currentUser.displayName || currentUser.email.split('@')[0],
          customerEmail: currentUser.email,
          customerPhone: currentUser.phoneNumber || null,
          companyName:   data.companyName || null,
          status:        EGC.QUOTE_STATUS.PENDING,
          createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt:     firebase.firestore.FieldValue.serverTimestamp()
        });

        return fbDB.collection('quotes').doc(quoteId).set(quoteData).then(function () {
          return Promise.all([
            EGC.createNotification(currentUser.uid, 'quote_submitted',
              'Your quote ' + quoteId + ' has been submitted and is under review.',
              { quoteId: quoteId }),
            EGC.logActivity(currentUser.uid, 'quote_submitted',
              'Quote ' + quoteId + ' submitted: ' + data.pickup + ' \u2192 ' + data.delivery,
              { quoteId: quoteId }),
            EGC.logAudit('quote_submitted', 'Quote ' + quoteId + ' submitted: ' + data.pickup + ' \u2192 ' + data.delivery + '.', {
              targetType: 'quote', targetId: quoteId, quoteId: quoteId,
              previousValue: null, newValue: 'pending_review'
            })
          ]);
        }).then(function () { return quoteId; });
      }).then(function (quoteId) {
        if (okEl)  { okEl.style.display = 'block'; okEl.textContent = '\u2713 Quote ' + quoteId + ' submitted! We will review shortly.'; }
        qForm.reset();
        var step = $('#shipTypeStep'); if (step) step.style.display = 'block';
        qForm.style.display = 'none';
        var vn = $('#coVerifyNote'); if (vn) vn.style.display = 'none';
        var ch = $('#coHint'); if (ch) ch.textContent = '';
        toast(true, quoteId + ' submitted successfully.');
        setTimeout(function () { openTab('quotes'); }, 1800);
      }).catch(function (err) {
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = err.message || 'Could not submit quote.'; }
      }).finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Submit Quote'; }
      });
      });
    });
  }

  /* Sign out */
  var signOutBtn = $('#signOutBtn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', function () {
      firebase.auth().signOut().then(function () { location.href = 'index.html'; });
    });
  }

  /* ===========================================================
     INVOICES LISTENER (Customer) — Phase 5
     Real-time: view, download PDF, print, payment status, history.
  =========================================================== */
  var custInvCache = [];
  var custLrCache  = [];

  function listenInvoices(uid) {
    /* Listen to the customer's Lorry Receipts too, so every order can
       offer Invoice / LR / Combined downloads. Keyed by orderId. */
    fbDB.collection('lorryReceipts')
      .where('customerUid', '==', uid)
      .onSnapshot(function (snap) {
        var rows = [];
        snap.forEach(function (doc) { var d = doc.data(); d._docId = doc.id; rows.push(d); });
        custLrCache = rows;
        renderCustInvoices(custInvCache);
      }, function (err) {
        console.warn('[DASH][lr] listener:', err.code, err.message);
      });

    return fbDB.collection('invoices')
      .where('customerUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .onSnapshot(function (snap) {
        var rows = [];
        snap.forEach(function (doc) { var d = doc.data(); d._docId = doc.id; rows.push(d); });
        custInvCache = rows;
        renderCustInvoices(rows);
      }, function (err) {
        console.error('[DASH][invoices] listener ERROR:', err.code, err.message);
        var list = $('#custInvoiceList');
        if (list) list.innerHTML = '<div class="dcard"><p style="color:#ff7070;">Could not load invoices. ' + EGC.esc(err.message) + '</p></div>';
      });
  }

  function custInvStatusPill(inv) {
    var s = INV.effectiveStatus(inv);
    return '<span class="pay-pill ' + INV.paymentClass(s) + '">' + INV.paymentLabel(s) + '</span>';
  }

  function custInvoiceCardHTML(invDoc) {
    /* Project from the master order (SSoT) so amounts/status are canonical. */
    var order = window.SHIP && SHIP.getOrderSync ? SHIP.getOrderSync(invDoc.orderId) : null;
    var inv = window.SHIP ? SHIP.toInvoiceView(order, invDoc) : invDoc;
    inv._docId = invDoc._docId;
    var t = INV.computeTotals(inv);
    return (
      '<div class="cinv-card">' +
        '<div class="cinv-top">' +
          '<div><div class="cinv-id">' + EGC.esc(inv.invoiceNumber) + '</div>' +
            '<div class="cinv-sub">' + EGC.esc(inv.lrNumber || '') + ' \u00B7 Order ' + EGC.esc(inv.orderId || '') + '</div></div>' +
          custInvStatusPill(inv) +
        '</div>' +
        '<div class="cinv-grid">' +
          '<div class="cinv-field"><span>Route</span><strong>' + EGC.esc(inv.fromLocation || '') + ' \u2192 ' + EGC.esc(inv.toLocation || '') + '</strong></div>' +
          '<div class="cinv-field"><span>Invoice Date</span><strong>' + INV.fmtDMY(inv.invoiceDate) + '</strong></div>' +
          '<div class="cinv-field"><span>Due Date</span><strong>' + INV.fmtDMY(inv.dueDate) + '</strong></div>' +
          '<div class="cinv-field"><span>Invoice Value</span><strong style="color:var(--amber);">\u20B9' + INV.fmtMoney(t.invoiceValue) + '</strong></div>' +
          '<div class="cinv-field"><span>Paid</span><strong>\u20B9' + INV.fmtMoney(inv.receivedAmount) + '</strong></div>' +
          '<div class="cinv-field"><span>Outstanding</span><strong style="color:' + (t.outstanding > 0 ? '#ff9f43' : 'var(--green)') + ';">\u20B9' + INV.fmtMoney(t.outstanding) + '</strong></div>' +
        '</div>' +
        '<div class="cinv-actions doc-dl-group">' +
          '<button class="btn-doc" onclick="CUST.viewInvoice(\'' + EGC.esc(inv._docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>View Invoice</button>' +
          '<button class="btn-doc" onclick="CUST.downloadInvoice(\'' + EGC.esc(inv._docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Invoice PDF</button>' +
          '<button class="btn-doc" onclick="CUST.downloadLR(\'' + EGC.esc(inv._docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Lorry Receipt PDF</button>' +
          '<button class="btn-doc btn-doc-primary" onclick="CUST.downloadCombined(\'' + EGC.esc(inv._docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>Combined PDF</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderCustInvoices(rows) {
    var list  = $('#custInvoiceList');
    var empty = $('#custInvoiceEmpty');
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = rows.map(custInvoiceCardHTML).join('');
  }

  function findCustInv(docId) { return custInvCache.filter(function (i) { return i._docId === docId; })[0]; }
  function findCustLrForInvoice(inv) {
    if (!inv) return null;
    return custLrCache.filter(function (l) {
      return (inv.lrNumber && l.lrNumber === inv.lrNumber) ||
             (inv.orderId && l.orderId === inv.orderId);
    })[0] || null;
  }

  window.CUST.viewInvoice = function (docId) {
    var inv = findCustInv(docId);
    if (inv) SHIP.openInvoice(inv, false).then(function (ok) { if (!ok) alert('Please allow pop-ups to view your invoice.'); });
  };
  window.CUST.downloadInvoice = function (docId) {
    var inv = findCustInv(docId);
    if (inv) SHIP.openInvoice(inv, true).then(function (ok) { if (!ok) alert('Please allow pop-ups to download your invoice.'); });
  };
  window.CUST.downloadLR = function (docId) {
    var inv = findCustInv(docId);
    var lr  = findCustLrForInvoice(inv);
    if (!lr) { alert('Lorry Receipt is being prepared for this order. Please check back shortly.'); return; }
    SHIP.openLr(lr, true).then(function (ok) { if (!ok) alert('Please allow pop-ups to download the Lorry Receipt.'); });
  };
  window.CUST.downloadCombined = function (docId) {
    var inv = findCustInv(docId);
    var lr  = findCustLrForInvoice(inv);
    if (!inv) return;
    if (!lr) { alert('Lorry Receipt is being prepared for this order. Please check back shortly.'); return; }
    SHIP.openCombined(inv, lr, true).then(function (ok) { if (!ok) alert('Please allow pop-ups to download the combined PDF.'); });
  };

  /* ===========================================================
     SHIPMENT TRACKING — Phase 6, Part 2
     ----------------------------------------------------------
     A complete Shipment Hub the customer reaches by entering an
     Invoice Number OR an LR Number. Everything shown is projected
     from the SAME SSoT data the rest of the dashboard uses
     (orders + invoice/LR docs + SHIP projections) — no duplicate
     collections, no new business logic. Downloads reuse the
     existing CUST.download* handlers. Because it reads only the
     customer's own cached invoices/LRs/orders, it automatically
     respects the existing Firestore security rules, and any future
     manual order linked to this account will simply appear here
     with no architectural change.
  =========================================================== */
  var _trackedDocId = null;   /* invoice _docId currently shown, for live refresh */

  function norm(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }

  /* Format a plain YYYY-MM-DD date string as DD-MM-YYYY (ETA is stored as a
     date-input string, not a Firestore timestamp). */
  function fmtYmd(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    return m ? (m[3] + '-' + m[2] + '-' + m[1]) : String(s || '');
  }

  /* Resolve an invoice doc from the customer's caches by invoice OR LR number. */
  function findShipmentByNumber(query) {
    var q = norm(query);
    if (!q) return null;
    /* try invoice number first */
    var inv = custInvCache.filter(function (i) {
      return norm(i.invoiceNumber || i.invoiceId) === q;
    })[0];
    if (inv) return inv;
    /* try LR number → map to its invoice */
    var lr = custLrCache.filter(function (l) { return norm(l.lrNumber) === q; })[0];
    if (lr) {
      var byLr = custInvCache.filter(function (i) {
        return (lr.invoiceId && i.invoiceId === lr.invoiceId) ||
               (lr.orderId && i.orderId === lr.orderId);
      })[0];
      if (byLr) return byLr;
    }
    /* try order id as a convenience */
    var byOrder = custInvCache.filter(function (i) { return norm(i.orderId) === q; })[0];
    return byOrder || null;
  }

  function trkProgress(status) {
    var seq = EGC.ORDER_STATUS_SEQUENCE; /* approved..delivered */
    var idx = seq.indexOf(status); if (idx < 0) idx = 0;
    /* overall journey incl. the 2 pre-order steps = 7 nodes, 6 gaps */
    var overall = 2 + idx;            /* 2..6 */
    return Math.round((overall / 6) * 100);
  }

  function payClassFor(s) {
    return s === 'paid' ? 'pay-paid' : s === 'partial' ? 'pay-partial'
         : s === 'overdue' ? 'pay-overdue' : 'pay-pending';
  }

  function trkCell(label, value) {
    if (value == null || value === '') return '';
    return '<div class="trk-cell"><div class="trk-cl">' + label + '</div><div class="trk-cv">' + EGC.esc(value) + '</div></div>';
  }

  function renderShipmentHub(invDoc) {
    var host = $('#trkResult');
    if (!host) return;
    var order = window.SHIP && SHIP.getOrderSync ? SHIP.getOrderSync(invDoc.orderId) : null;
    var inv   = window.SHIP ? SHIP.toInvoiceView(order, invDoc) : invDoc;
    var lr    = findCustLrForInvoice(invDoc);
    var t     = INV.computeTotals(inv);

    var status      = (order && order.status) || 'approved';
    var statusLabel = EGC.orderStatusLabel(status);
    var statusCls   = EGC.orderStatusClass(status);
    var pct         = trkProgress(status);
    var payStatus   = INV.effectiveStatus(inv);
    var payLabel    = INV.paymentLabel(payStatus);

    /* status badge colours reuse the st-* palette via inline mapping */
    var badgeColor = statusCls === 'st-ok' ? 'background:rgba(61,214,140,.13);color:var(--green);border:1px solid rgba(61,214,140,.3);'
                    : statusCls === 'st-progress' ? 'background:rgba(245,147,10,.13);color:var(--amber);border:1px solid rgba(245,147,10,.3);'
                    : 'background:rgba(138,154,176,.13);color:var(--muted);border:1px solid rgba(138,154,176,.25);';

    var driverName  = (order && order.driverName) || lr && lr.driverName || '';
    var driverMobile= (order && order.driverMobile) || lr && lr.driverMobile || '';
    var vehicle     = (order && order.vehicleNumber) || lr && lr.vehicleNumber || '';
    var eta         = (order && order.estimatedDelivery) || '';

    var docId = invDoc._docId;
    _trackedDocId = docId;

    var html =
      '<div class="trk-hub">' +
        '<div class="trk-hub-top">' +
          '<div class="trk-ids">' +
            '<div class="trk-order">' + EGC.esc(inv.invoiceNumber || inv.invoiceId) + '</div>' +
            '<div class="trk-sub">' + EGC.esc(inv.lrNumber || '') + (inv.orderId ? (' \u00B7 Order ' + EGC.esc(inv.orderId)) : '') + '</div>' +
          '</div>' +
          '<span class="trk-status-badge" style="' + badgeColor + '"><span class="st-dot"></span>' + EGC.esc(statusLabel) + '</span>' +
        '</div>' +

        '<div class="trk-progress-wrap">' +
          '<div class="trk-progress-label"><span>Shipment progress</span><span>' + pct + '%</span></div>' +
          '<div class="trk-progress-bar"><div class="trk-progress-fill" style="width:' + pct + '%;"></div></div>' +
        '</div>' +

        buildOrderTimeline({ status: status }) +

        '<div class="trk-route">' +
          '<div class="trk-route-pt"><div class="trk-rl">Pickup</div><div class="trk-rv">' + EGC.esc(inv.fromLocation || '\u2014') + '</div></div>' +
          '<svg class="trk-route-arrow" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>' +
          '<div class="trk-route-pt" style="text-align:right;"><div class="trk-rl">Delivery</div><div class="trk-rv">' + EGC.esc(inv.toLocation || '\u2014') + '</div></div>' +
        '</div>' +

        '<div class="trk-grid">' +
          trkCell('Payment Status', payLabel) +
          trkCell('Outstanding', '\u20B9' + INV.fmtMoney(t.outstanding)) +
          trkCell('Invoice Value', '\u20B9' + INV.fmtMoney(t.invoiceValue)) +
          trkCell('Vehicle Number', vehicle) +
          trkCell('Driver Name', driverName) +
          trkCell('Driver Mobile', driverMobile) +
          trkCell('Estimated Delivery', eta ? fmtYmd(eta) : '') +
        '</div>' +

        '<div class="trk-section-title">Documents</div>' +
        '<div class="trk-docs">' +
          '<button class="btn-doc" onclick="CUST.downloadInvoice(\'' + EGC.esc(docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Invoice PDF</button>' +
          '<button class="btn-doc" onclick="CUST.downloadLR(\'' + EGC.esc(docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>Lorry Receipt PDF</button>' +
          '<button class="btn-doc btn-doc-primary" onclick="CUST.downloadCombined(\'' + EGC.esc(docId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>Combined PDF</button>' +
        '</div>' +

        '<a class="trk-contact" href="https://wa.me/919826134701?text=' + encodeURIComponent('Hi, I have a question about shipment ' + (inv.invoiceNumber || inv.invoiceId)) + '" target="_blank" rel="noopener">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.1-1.7-.8-1.9-.9-.3-.1-.4-.1-.6.1-.2.3-.7.9-.8 1-.1.2-.3.2-.5.1-.7-.3-1.4-.6-2-1.1-.5-.5-.9-1.1-1.3-1.7-.1-.2 0-.4.1-.5.1-.1.2-.3.4-.4.1-.1.2-.2.2-.4.1-.1 0-.3 0-.4 0-.1-.6-1.5-.8-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.6.3-.7.7-1 1.5-1 2.4.1 1 .5 2 1.1 2.8 1.1 1.6 2.5 2.9 4.2 3.6.5.2 1 .4 1.6.5.5.1 1 .1 1.5 0 .6-.1 1.7-.7 1.9-1.4.2-.6.2-1.1.1-1.2 0-.1-.2-.2-.5-.3zM12 2a10 10 0 00-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1012 2z"/></svg>' +
          'Contact Express Goods Carrier' +
        '</a>' +
      '</div>';

    host.innerHTML = html;
    host.style.display = 'block';
  }

  /* Live refresh of an open hub when orders/invoices change. */
  function refreshTracking() {
    if (!_trackedDocId) return;
    var inv = custInvCache.filter(function (i) { return i._docId === _trackedDocId; })[0];
    if (inv) renderShipmentHub(inv);
  }

  window.CUST.track = function () {
    var input = $('#trkInput');
    var msg   = $('#trkMsg');
    var host  = $('#trkResult');
    var q = input ? input.value : '';
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    if (!norm(q)) {
      if (msg) { msg.style.display = 'block'; msg.className = 'fst er'; msg.textContent = 'Enter an Invoice Number or LR Number to track.'; }
      return;
    }
    var inv = findShipmentByNumber(q);
    if (!inv) {
      _trackedDocId = null;
      if (host) host.style.display = 'none';
      if (msg) { msg.style.display = 'block'; msg.className = 'fst er'; msg.textContent = 'No shipment found for "' + q.trim() + '". Check the number and try again — only shipments on your account are shown.'; }
      return;
    }
    renderShipmentHub(inv);
  };

  window.CUST.trackQuick = function (num) {
    var input = $('#trkInput'); if (input) input.value = num;
    CUST.track();
  };

  /* Populate quick-pick chips with the customer's most recent shipments. */
  function renderTrackRecent() {
    var host = $('#trkRecent');
    if (!host) return;
    var chips = custInvCache.slice(0, 6).map(function (i) {
      var num = i.invoiceNumber || i.invoiceId;
      return '<span class="trk-chip" onclick="CUST.trackQuick(\'' + EGC.esc(num) + '\')">' + EGC.esc(num) + '</span>';
    }).join('');
    host.innerHTML = chips;
  }

  /* Refresh chips whenever the invoice cache re-renders. */
  var _origRenderCustInvoices = renderCustInvoices;
  renderCustInvoices = function (rows) {
    _origRenderCustInvoices(rows);
    renderTrackRecent();
    refreshTracking();
  };

})();

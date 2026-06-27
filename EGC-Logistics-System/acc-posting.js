/* ============================================================================
   ORBIT ACCOUNTING — AUTO-POSTING  (ACC.auto*)
   ----------------------------------------------------------------------------
   Turns shipment events into balanced journal entries automatically, so the
   owner never re-enters anything. Reads the ORDER (SSoT) via SHIP.toAccountingRow
   and posts through ACC.post (which enforces double-entry + immutability).

   FLOW (matches the product spec):
     Order approved        -> SALES entry  (Dr Customer, Cr Freight Income[, GST])
     Advance / payment      -> RECEIPT entry (Dr Bank/Cash, Cr Customer)
     Order amounts changed  -> if unpaid: void+repost sales
                               if paid-in-part: post ADJUSTMENT for the delta only
   Idempotent: every auto entry is tagged with orderId + a postingKey so the same
   event can never double-post (safe under retries / concurrent listeners).
   ============================================================================ */
(function () {
  'use strict';
  if (!window.ACC || !window.SHIP) { console.error('[ACC] auto-posting needs ACC + SHIP'); return; }
  var fbDB = firebase.firestore();
  var round2 = ACC.round2, toNum = ACC.toNum;

  /* Find an existing auto entry for (orderId, kind) so we never double-post. */
  function findAuto(orderId, kind) {
    return fbDB.collection('journalEntries')
      .where('orderId', '==', orderId)
      .where('postingKey', '==', kind)
      .where('status', '==', 'posted')
      .limit(1).get()
      .then(function (s) { return s.empty ? null : Object.assign({ _id: s.docs[0].id }, s.docs[0].data()); });
  }

  /* Build the SALES lines from an order's accounting projection.
     GST-ready: when settings rates > 0, the taxable freight and the SGST/CGST
     output tax are split automatically. At 0% it's a clean Dr Customer / Cr
     Freight Income (+ discount handling). */
  function salesLines(row, party) {
    var s = ACC.settings(), a = s.accounts;
    var freightIncome = round2(
      row.freight + row.fov + row.labour + row.localCollection +
      row.doorDelivery + row.docketCharges + row.haltingCharges + row.extraCharges
    );
    var discount = round2(row.discount);
    var sgst = round2(row.sgst);
    var cgst = round2(row.cgst);
    var grand = round2(row.grandTotal);

    var lines = [];
    /* Debit the customer for the full receivable (grand total). */
    lines.push({ accountCode: a.debtors, debit: grand, credit: 0, party: party, memo: 'Invoice ' + (row.invoiceNumber || '') });
    /* Credit freight income (net of discount shown separately for clarity). */
    lines.push({ accountCode: a.freightIncome, debit: 0, credit: round2(freightIncome - discount), memo: 'Freight & charges' });
    if (discount > 0) {
      /* Discount allowed is an expense debit; keep income gross, expense the rebate.
         Net P&L effect identical, but both gross income and discount are visible. */
      lines[1].credit = freightIncome;                       /* gross income */
      lines.push({ accountCode: a.discount, debit: discount, credit: 0, memo: 'Discount allowed' });
    }
    if (sgst > 0) lines.push({ accountCode: a.outputSgst, debit: 0, credit: sgst, memo: 'SGST output' });
    if (cgst > 0) lines.push({ accountCode: a.outputCgst, debit: 0, credit: cgst, memo: 'CGST output' });
    return lines;
  }

  /* SALES — called automatically on order approval. */
  ACC.autoPostSales = function (order) {
    var row = SHIP.toAccountingRow(order);
    if (!row.orderId) return Promise.resolve(null);
    if (!(round2(row.grandTotal) > 0)) return Promise.resolve(null);   /* nothing to post */

    return findAuto(row.orderId, 'sales').then(function (existing) {
      if (existing) return existing;                                   /* idempotent */
      var partyName = row.companyName || row.consignor || row.customerName || ('Order ' + row.orderId);
      return ACC.ensureParty({
        kind: 'customer', name: partyName, gst: row.customerGst || row.consignorGst,
        customerUid: order.customerUid || null
      }).then(function (party) {
        return ACC.post({
          date: (order.invoiceDate && order.invoiceDate.toDate
                  ? order.invoiceDate.toDate().toISOString().slice(0, 10)
                  : new Date().toISOString().slice(0, 10)),
          type: 'SALES', sourceType: 'order',
          narration: 'Sales \u2014 ' + (row.invoiceNumber || row.orderId) + ' (' + partyName + ')',
          orderId: row.orderId, invoiceId: row.invoiceNumber || null, party: party.partyId,
          lines: salesLines(row, party.partyId)
        }, ).then(function (e) { return stampKey(e, 'sales'); });
      });
    });
  };

  /* RECEIPT — payment received against an order. amount + mode(bank|cash). */
  ACC.autoPostReceipt = function (order, amount, mode) {
    amount = round2(amount);
    if (!(amount > 0)) return Promise.resolve(null);
    var s = ACC.settings(), a = s.accounts;
    var row = SHIP.toAccountingRow(order);
    var partyName = row.companyName || row.consignor || row.customerName || ('Order ' + row.orderId);
    var bankOrCash = (mode === 'cash') ? a.cash : a.bank;
    return ACC.ensureParty({ kind: 'customer', name: partyName, customerUid: order.customerUid || null })
      .then(function (party) {
        return ACC.post({
          date: new Date().toISOString().slice(0, 10),
          type: 'RECEIPT', sourceType: 'order',
          narration: 'Receipt \u2014 ' + (row.invoiceNumber || row.orderId) + ' (' + partyName + ')',
          orderId: row.orderId, invoiceId: row.invoiceNumber || null, party: party.partyId,
          lines: [
            { accountCode: bankOrCash, debit: amount, credit: 0, memo: 'Payment received' },
            { accountCode: a.debtors,  debit: 0, credit: amount, party: party.partyId, memo: 'Against invoice' }
          ]
        });
      });
  };

  /* RE-SYNC after an order edit. If the sales figure changed:
       - no receipts yet  -> void old sales + repost fresh (clean)
       - receipts exist    -> post a delta ADJUSTMENT (never touch settled lines) */
  ACC.autoResyncSales = function (order) {
    var row = SHIP.toAccountingRow(order);
    return findAuto(row.orderId, 'sales').then(function (existing) {
      if (!existing) return ACC.autoPostSales(order);          /* first time */
      var newGrand = round2(row.grandTotal);
      /* The customer RECEIVABLE is the debtors debit on the original sales
         entry — NOT existing.totalDebit, which is inflated by the discount-
         allowed line whenever a discount is present. Comparing against the
         receivable keeps the delta (and the debtors sub-ledger) exactly in
         step with the order's grand total. */
      var a0 = ACC.settings().accounts;
      var oldGrand = round2(existing.totalDebit);
      var drLine = (existing.lines || []).filter(function (l) { return l.accountCode === a0.debtors && round2(l.debit) > 0; })[0];
      if (drLine) oldGrand = round2(drLine.debit);
      if (newGrand === oldGrand) return existing;              /* unchanged */

      return hasReceipts(row.orderId).then(function (paid) {
        if (!paid) {
          return ACC.voidEntry(existing, 'Order amount revised').then(function () {
            return ACC.autoPostSales(order);
          });
        }
        /* settled in part — adjust only the delta to keep history intact */
        var delta = round2(newGrand - oldGrand);
        var s = ACC.settings(), a = s.accounts;
        var lines = delta > 0
          ? [ { accountCode: a.debtors, debit: delta, credit: 0, party: existing.party },
              { accountCode: a.freightIncome, debit: 0, credit: delta } ]
          : [ { accountCode: a.freightIncome, debit: -delta, credit: 0 },
              { accountCode: a.debtors, debit: 0, credit: -delta, party: existing.party } ];
        return ACC.post({
          date: new Date().toISOString().slice(0, 10),
          type: 'SALES', sourceType: 'adjustment',
          narration: 'Adjustment \u2014 ' + (row.invoiceNumber || row.orderId) + ' revised by ' + delta,
          orderId: row.orderId, invoiceId: row.invoiceNumber || null, party: existing.party,
          adjustsEntryId: existing.entryId, lines: lines
        });
      });
    });
  };

  function hasReceipts(orderId) {
    return fbDB.collection('journalEntries')
      .where('orderId', '==', orderId).where('type', '==', 'RECEIPT')
      .where('status', '==', 'posted').limit(1).get()
      .then(function (s) { return !s.empty; });
  }

  /* tag an entry with a postingKey for idempotency lookups */
  function stampKey(entry, key) {
    return fbDB.collection('journalEntries').doc(entry.entryId)
      .set({ postingKey: key }, { merge: true })
      .then(function () { entry.postingKey = key; return entry; });
  }
  ACC._findAuto = findAuto;
  ACC._hasReceipts = hasReceipts;

  console.log('[ACC] auto-posting loaded.');
})();

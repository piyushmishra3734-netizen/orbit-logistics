/* ============================================================================
   ORBIT ACCOUNTING — MANUAL VOUCHERS  (ACC.voucher*)
   ----------------------------------------------------------------------------
   Owner-keyed Receipt / Payment / Contra / Journal vouchers. Each is just a
   friendly front-end that builds balanced lines and posts through ACC.post
   (so every guarantee — balance, immutability, audit — applies identically).

   sourceType:'manual' => these affect ONLY accounting and never touch the Order
   (SSoT). The sync-back-to-order path is a separate, explicit owner action.
   ============================================================================ */
(function () {
  'use strict';
  if (!window.ACC) { console.error('[ACC] vouchers need ACC core'); return; }
  var round2 = ACC.round2;

  /* RECEIPT — money IN. Dr Bank/Cash, Cr party (or any account). */
  ACC.voucherReceipt = function (v) {
    /* v: { date, amount, mode:'bank'|'cash', partyId?, againstAccount?, narration } */
    var amount = round2(v.amount);
    if (!(amount > 0)) return Promise.reject(new Error('Enter an amount greater than 0.'));
    var bankCash = v.mode === 'cash' ? ACC.acct('cash') : ACC.acct('bank');
    var creditAcct = v.againstAccount || ACC.acct('debtors');
    return ACC.post({
      date: v.date, type: 'RECEIPT', sourceType: 'manual',
      narration: v.narration || 'Receipt voucher',
      party: v.partyId || null,
      lines: [
        { accountCode: bankCash, debit: amount, credit: 0 },
        { accountCode: creditAcct, debit: 0, credit: amount, party: v.partyId || null }
      ]
    });
  };

  /* PAYMENT — money OUT. Dr expense/supplier, Cr Bank/Cash. */
  ACC.voucherPayment = function (v) {
    /* v: { date, amount, mode, expenseAccount, partyId?, narration } */
    var amount = round2(v.amount);
    if (!(amount > 0)) return Promise.reject(new Error('Enter an amount greater than 0.'));
    if (!v.expenseAccount) return Promise.reject(new Error('Choose an account to debit.'));
    var bankCash = v.mode === 'cash' ? ACC.acct('cash') : ACC.acct('bank');
    return ACC.post({
      date: v.date, type: 'PAYMENT', sourceType: 'manual',
      narration: v.narration || 'Payment voucher',
      party: v.partyId || null,
      lines: [
        { accountCode: v.expenseAccount, debit: amount, credit: 0, party: v.partyId || null },
        { accountCode: bankCash, debit: 0, credit: amount }
      ]
    });
  };

  /* CONTRA — move funds between Cash and Bank (no P&L impact). */
  ACC.voucherContra = function (v) {
    /* v: { date, amount, direction:'cash_to_bank'|'bank_to_cash', narration } */
    var amount = round2(v.amount);
    if (!(amount > 0)) return Promise.reject(new Error('Enter an amount greater than 0.'));
    var cash = ACC.acct('cash'), bank = ACC.acct('bank');
    var dr, cr;
    if (v.direction === 'cash_to_bank') { dr = bank; cr = cash; }
    else { dr = cash; cr = bank; }
    return ACC.post({
      date: v.date, type: 'CONTRA', sourceType: 'manual',
      narration: v.narration || 'Contra entry',
      lines: [
        { accountCode: dr, debit: amount, credit: 0 },
        { accountCode: cr, debit: 0, credit: amount }
      ]
    });
  };

  /* GENERAL JOURNAL — free-form balanced lines for adjustments. */
  ACC.voucherJournal = function (v) {
    /* v: { date, narration, lines:[{accountCode,debit,credit,partyId?}] } */
    return ACC.post({
      date: v.date, type: 'JOURNAL', sourceType: 'manual',
      narration: v.narration || 'Journal entry',
      lines: (v.lines || []).map(function (l) {
        return { accountCode: l.accountCode, debit: round2(l.debit), credit: round2(l.credit), party: l.partyId || null };
      })
    });
  };

  /* SYNC-BACK — explicit owner action: push a manual accounting correction onto
     the Order (SSoT) so Invoice/LR follow. Only used when the owner deliberately
     chooses "also update the order"; default manual edits never call this. */
  ACC.syncBackToOrder = function (orderId, patch) {
    var fbDB = firebase.firestore();
    return fbDB.collection('orders').doc(orderId).update(
      Object.assign({ updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, patch)
    ).then(function () {
      EGC.reliableAudit('order_synced_from_accounting',
        'Order ' + orderId + ' updated from a manual accounting edit.',
        { targetType: 'order', targetId: orderId, orderId: orderId, newValue: patch });
    });
  };

  console.log('[ACC] vouchers loaded.');
})();

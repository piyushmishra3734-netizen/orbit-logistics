/* ============================================================
   PHASE 6 — EDGE-CASE LOGIC QA
   1) Personal Manual Order end-to-end.
   2) Discount-free resync (void+repost when unpaid; delta when paid).
   3) Manual vs Customer order remain indistinguishable after edits.
   ============================================================ */
'use strict';
const { load, env } = require('./load');

let PASS = 0, FAIL = 0; const fails = [];
function ok(c, m) { if (c) PASS++; else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } }
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 54 - t.length))); }
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 80));
function entriesFor(orderId, type) { return Object.values(env.DB.journalEntries || {}).filter((e) => e.orderId === orderId && (!type || e.type === type) && e.status === 'posted'); }
function debtorsNet(entries, drAcct) { return entries.reduce((s, e) => s + (e.lines || []).reduce((ls, l) => ls + (l.accountCode === drAcct ? l.debit - l.credit : 0), 0), 0); }

async function main() {
  const w = load();
  const { SHIP, OWN, EGC, ACC, INV, LR } = w;
  await ACC.ensureSeeded(); await ACC.loadSettings(); await settle();
  const DR = ACC.acct('debtors');

  /* ===== 1) PERSONAL MANUAL ORDER END-TO-END ===== */
  section('PERSONAL Manual Order — end to end');
  const pSynth = {
    shipmentType: 'personal', customerUid: null,
    senderName: 'Ravi Kumar', senderMobile: '9001112223', senderEmail: 'ravi@p.test', pickupAddress: '12 MG Road, Pune',
    receiverName: 'Sneha Rao', receiverMobile: '9334445556', deliveryAddress: '88 Park St, Kolkata',
    customerName: 'Ravi Kumar', customerPhone: '9001112223', customerEmail: 'ravi@p.test',
    pickup: 'Pune', delivery: 'Kolkata', materialType: 'Household Goods / Personal Effects',
    weight: '800', packages: '20', pickupDate: '2026-02-10', notes: 'Fragile — household move',
  };
  const pOwner = { freight: 9000, haltingCharges: 0, extraCharges: 600, discount: 0, advanceReceived: 0,
                   vehicleNumber: 'MH12XY7788', driverName: 'A Singh', driverMobile: '9667778889', estimatedDelivery: '2026-02-14' };
  const pIds = { orderId: await EGC.nextOrderId(), invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), docketNo: await LR.nextDocketNumber() };
  const pOrder = SHIP.buildOrder({ orderId: pIds.orderId, quoteId: null, invoiceId: pIds.invoiceId, lrNumber: pIds.lrNumber, quote: pSynth, pricing: { freight: 9000 }, owner: pOwner });
  pOrder.status = EGC.ORDER_STATUS.APPROVED; pOrder.invoiceGenerated = true; pOrder.lrGenerated = true;
  await OWN.runOrderPipeline(pOrder, pIds, { freight: 9000, notify: false, onAudit: 'manual' });
  await settle(120);

  const po = env.DB.orders[pIds.orderId];
  ok(!!po && !!env.DB.invoices[pIds.invoiceId] && !!env.DB.lorryReceipts[pIds.lrNumber], 'Personal: order + invoice + LR created');
  ok(po.shipmentType === 'personal', 'Personal: shipmentType preserved');
  // personal must NOT carry company/GST; consignor/consignee derive from sender/receiver
  ok(po.companyName === '' && po.customerGst === '', 'Personal: no company/GST fields');
  ok(po.consignorName === 'Ravi Kumar' && po.consignorContact === '9001112223', 'Personal: consignor = sender');
  ok(po.consignorAddress === '12 MG Road, Pune', 'Personal: consignor address = pickup address');
  ok(po.consigneeName === 'Sneha Rao' && po.consigneeContact === '9334445556', 'Personal: consignee = receiver');
  ok(po.consigneeAddress === '88 Park St, Kolkata', 'Personal: consignee address = delivery address');
  ok(po.gstPayableBy === 'Consignor', 'Personal: GST payable by Consignor (personal default)');
  const pCh = SHIP.computeCharges(po);
  ok(pCh.grandTotal === 9600 && pCh.outstanding === 9600, 'Personal: totals (9000+600) correct, fully outstanding');
  ok(po.paymentStatus === 'pending', 'Personal: payment status pending (no advance)');
  // projections
  const pInvV = SHIP.toInvoiceView(po, env.DB.invoices[pIds.invoiceId]);
  const pLrV = SHIP.toLrView(po, env.DB.lorryReceipts[pIds.lrNumber]);
  ok(pInvV.customerName === 'Ravi Kumar' && INV.toNum(pInvV.invoiceAmount) === 9600, 'Personal: invoice projection correct');
  ok(pLrV.consigneeName === 'Sneha Rao' && pLrV.driverName === 'A Singh', 'Personal: LR projection correct');
  ok(pLrV.estimatedDelivery === '2026-02-14', 'Personal: ETA on LR view');
  // accounting
  const pSales = entriesFor(pIds.orderId, 'SALES');
  ok(pSales.length === 1 && debtorsNet(pSales, DR) === 9600, 'Personal: SALES receivable ₹9600');
  ok(entriesFor(pIds.orderId, 'RECEIPT').length === 0, 'Personal: no receipt (no advance)');
  ok(SHIP.toAccountingRow(po).grandTotal === 9600, 'Personal: reports row correct');

  /* ===== 2) DISCOUNT-FREE RESYNC ===== */
  section('Discount-free resync — unpaid (void+repost) & paid (delta)');

  // Case 2a: UNPAID order, raise freight → expect VOID original + fresh repost.
  const u = SHIP.buildOrder({ orderId: await EGC.nextOrderId(), quoteId: null, invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), quote: { shipmentType: 'commercial', companyName: 'NoDisc Co', pickup: 'X', delivery: 'Y', materialType: 'M', weight: '1', consigneeName: 'Z', customerUid: null }, pricing: { freight: 10000 }, owner: { freight: 10000 } });
  u.status = 'approved'; u.invoiceGenerated = true; u.lrGenerated = true;
  const uIds = { orderId: u.orderId, invoiceId: u.invoiceId, lrNumber: u.lrNumber, docketNo: await LR.nextDocketNumber() };
  await OWN.runOrderPipeline(u, uIds, { freight: 10000, notify: false, onAudit: 'manual' });
  await settle(100);
  ok(debtorsNet(entriesFor(uIds.orderId, 'SALES'), DR) === 10000, '2a: initial SALES receivable ₹10000');
  // edit up to 15000, still unpaid
  await w.fbDB.collection('orders').doc(uIds.orderId).update({ freight: 15000 });
  const u2 = Object.assign({}, env.DB.orders[uIds.orderId], { orderId: uIds.orderId }); SHIP.primeOrder(u2);
  await ACC.loadSettings(); await ACC.autoResyncSales(u2); await settle(100);
  /* True receivable nets ACROSS ALL sales movements: original(+10000),
     reversal(-10000) and fresh repost(+15000) = 15000. The void+reversal
     pair cancels, leaving the repost — the audit chain stays intact. */
  const uAllSales = Object.values(env.DB.journalEntries).filter((e) => e.orderId === uIds.orderId && e.type === 'SALES');
  ok(debtorsNet(uAllSales, DR) === 15000, '2a: after unpaid edit, net receivable = ₹15000');
  ok(uAllSales.some((e) => e.status === 'void'), '2a: original SALES voided (clean repost path)');
  ok(uAllSales.some((e) => e.voidsEntryId), '2a: a reversing entry exists (audit chain intact)');
  // balanced
  uAllSales.forEach((e) => ok(e.totalDebit === e.totalCredit, '2a: entry ' + e.entryId + ' balanced'));

  // Case 2b: PAID-in-part order without discount, raise freight → DELTA adjustment.
  const pd = SHIP.buildOrder({ orderId: await EGC.nextOrderId(), quoteId: null, invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), quote: { shipmentType: 'commercial', companyName: 'Delta Co', pickup: 'X', delivery: 'Y', materialType: 'M', weight: '1', consigneeName: 'Z', customerUid: null }, pricing: { freight: 8000 }, owner: { freight: 8000, advanceReceived: 3000 } });
  pd.status = 'approved'; pd.invoiceGenerated = true; pd.lrGenerated = true;
  const pdIds = { orderId: pd.orderId, invoiceId: pd.invoiceId, lrNumber: pd.lrNumber, docketNo: await LR.nextDocketNumber() };
  await OWN.runOrderPipeline(pd, pdIds, { freight: 8000, notify: false, onAudit: 'manual' });
  await settle(100);
  ok(debtorsNet(entriesFor(pdIds.orderId, 'SALES'), DR) === 8000, '2b: initial receivable ₹8000');
  ok(entriesFor(pdIds.orderId, 'RECEIPT').length === 1, '2b: advance receipt posted');
  // raise to 11000 (receipts exist) → delta +3000 adjustment, original preserved
  await w.fbDB.collection('orders').doc(pdIds.orderId).update({ freight: 11000 });
  const pd2 = Object.assign({}, env.DB.orders[pdIds.orderId], { orderId: pdIds.orderId }); SHIP.primeOrder(pd2);
  await ACC.loadSettings(); await ACC.autoResyncSales(pd2); await settle(100);
  const pdSales = entriesFor(pdIds.orderId, 'SALES');
  ok(pdSales.length === 2, '2b: original SALES preserved + delta adjustment (history intact)');
  ok(debtorsNet(pdSales, DR) === 11000, '2b: net receivable resynced to ₹11000');
  ok(pdSales.some((e) => e.sourceType === 'adjustment' && e.adjustsEntryId), '2b: adjustment links to original');
  ok(!pdSales.some((e) => e.status === 'void'), '2b: nothing voided (settled history untouched)');
  pdSales.forEach((e) => ok(e.totalDebit === e.totalCredit, '2b: entry ' + e.entryId + ' balanced'));

  /* ===== 3) INDISTINGUISHABLE AFTER EDITS ===== */
  section('Manual vs Customer order — indistinguishable after edits');
  // Build a customer order and a manual order with identical business inputs,
  // apply the SAME Manage-Shipment edit to both, compare canonical fields.
  const inputQuote = { shipmentType: 'commercial', customerUid: 'c1', companyName: 'Twin Co', customerGst: 'G1', contactPerson: 'P', companyMobile: '1', companyEmail: 'e', registeredAddress: 'a', city: 'c', state: 's', consigneeName: 'Cons', consigneeContact: '2', consigneeGstin: 'G2', consigneeAddress: 'ca', consigneeCity: 'cc', consigneeState: 'cs', customerName: 'Twin Co', customerPhone: '1', customerEmail: 'e', pickup: 'P1', delivery: 'D1', materialType: 'Other Cargo', weight: '1000', packages: '3', pickupDate: '2026-03-01', notes: 'n' };
  const qO = SHIP.buildOrder({ orderId: await EGC.nextOrderId(), quoteId: 'QTW', invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), quote: inputQuote, pricing: { freight: 7000 } });
  qO.status = 'approved'; qO.invoiceGenerated = true; qO.lrGenerated = true;
  const qOids = { orderId: qO.orderId, invoiceId: qO.invoiceId, lrNumber: qO.lrNumber, docketNo: await LR.nextDocketNumber() };
  await w.fbDB.collection('quotes').doc('QTW').set({ quoteId: 'QTW', customerUid: 'c1', status: 'pending_review' });
  await OWN.runOrderPipeline(qO, qOids, { quoteRef: w.fbDB.collection('quotes').doc('QTW'), freight: 7000, notify: true, onAudit: 'quote' });

  const mO = SHIP.buildOrder({ orderId: await EGC.nextOrderId(), quoteId: null, invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), quote: inputQuote, pricing: { freight: 7000 }, owner: { freight: 7000 } });
  mO.status = 'approved'; mO.invoiceGenerated = true; mO.lrGenerated = true;
  const mOids = { orderId: mO.orderId, invoiceId: mO.invoiceId, lrNumber: mO.lrNumber, docketNo: await LR.nextDocketNumber() };
  await OWN.runOrderPipeline(mO, mOids, { freight: 7000, notify: false, onAudit: 'manual' });
  await settle(120);

  // Apply identical edit to both orders (vehicle + extra charge + partial pay)
  const edit = { vehicleNumber: 'EDIT9999', driverName: 'Edited Driver', extraCharges: 800, receivedAmount: 2000, paymentStatus: 'partial', estimatedDelivery: '2026-03-09' };
  await w.fbDB.collection('orders').doc(qOids.orderId).update(edit);
  await w.fbDB.collection('orders').doc(mOids.orderId).update(edit);
  const qE = Object.assign({}, env.DB.orders[qOids.orderId], { orderId: qOids.orderId });
  const mE = Object.assign({}, env.DB.orders[mOids.orderId], { orderId: mOids.orderId });

  // Compare canonical fields (exclude identity + provenance + timestamps)
  const SKIP = { orderId: 1, quoteId: 1, invoiceId: 1, lrNumber: 1, customerUid: 1, source: 1, createdAt: 1, updatedAt: 1, paymentDate: 1 };
  const keys = new Set([].concat(Object.keys(qE), Object.keys(mE)).filter((k) => !SKIP[k]));
  let same = true; const diffs = [];
  keys.forEach((k) => { if (JSON.stringify(qE[k]) !== JSON.stringify(mE[k])) { same = false; diffs.push(`${k}: q=${JSON.stringify(qE[k])} m=${JSON.stringify(mE[k])}`); } });
  ok(same, 'After edit: canonical order fields identical' + (same ? '' : ' — DIFF: ' + diffs.join(' | ')));
  // identical downstream projections (modulo doc identity)
  const qiv = SHIP.toInvoiceView(qE, env.DB.invoices[qOids.invoiceId]);
  const miv = SHIP.toInvoiceView(mE, env.DB.invoices[mOids.invoiceId]);
  ok(INV.toNum(qiv.invoiceAmount) === INV.toNum(miv.invoiceAmount), 'After edit: identical invoice totals');
  ok(qiv.vehicleNumber === miv.vehicleNumber && qiv.vehicleNumber === 'EDIT9999', 'After edit: identical projected transport');
  const qlv = SHIP.toLrView(qE, env.DB.lorryReceipts[qOids.lrNumber]);
  const mlv = SHIP.toLrView(mE, env.DB.lorryReceipts[mOids.lrNumber]);
  ok(qlv.grandTotalAmount === mlv.grandTotalAmount && qlv.driverName === mlv.driverName, 'After edit: identical LR projection');
  ok(SHIP.toAccountingRow(qE).grandTotal === SHIP.toAccountingRow(mE).grandTotal, 'After edit: identical reports/excel totals');
  // the ONLY difference is provenance + identity
  ok(qE.source === undefined && mE.source === 'owner_manual', 'Only difference is provenance tag (source)');

  console.log('\n' + '='.repeat(56));
  console.log('  EDGE RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL EDGE-CASE CHECKS PASSED.');
}
main().catch((e) => { console.error('HARNESS ERROR:', e.stack); process.exit(2); });

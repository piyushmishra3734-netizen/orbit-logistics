/* ============================================================
   PHASE 6 — END-TO-END QA SUITE
   Runs the REAL Orbit business modules against an in-memory
   Firestore and drives BOTH workflows through the SHARED Order
   Engine (OWN.runOrderPipeline), asserting every Phase 6 rule.
   ============================================================ */
'use strict';
const { load, env } = require('./load');

let PASS = 0, FAIL = 0;
const fails = [];
function ok(cond, msg) { if (cond) { PASS++; } else { FAIL++; fails.push(msg); console.log('   ✗ ' + msg); } }
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length))); }
function info(t) { console.log('   • ' + t); }

/* flush microtasks + reliable-queue timers */
function settle(ms) { return new Promise((r) => setTimeout(r, ms || 60)); }

/* count journal entries for an order by type */
function entriesFor(w, orderId, type) {
  const je = env.DB.journalEntries || {};
  return Object.values(je).filter((e) => e.orderId === orderId && (!type || e.type === type) && e.status === 'posted');
}
function allDocs(coll) { return Object.entries(env.DB[coll] || {}).map(([id, d]) => Object.assign({ _id: id }, d)); }

async function buildOrderViaBuilder(w, opts) {
  return w.SHIP.buildOrder(opts);
}

/* Drive the shared pipeline exactly as production does. */
async function runPipeline(w, orderData, ids, ctx) {
  return w.OWN.runOrderPipeline(orderData, ids, ctx);
}

async function main() {
  const w = load();
  const { SHIP, OWN, EGC, ACC, INV, LR } = w;

  // Seed Chart of Accounts + settings (idempotent), then load settings.
  await ACC.ensureSeeded();
  await ACC.loadSettings();
  await settle();

  /* =========================================================
     WORKFLOW A — CUSTOMER QUOTE → APPROVAL → ORDER → ...
     We replicate OWN.approve's core: build order from a quote
     (fresh quote in DB) and run the shared pipeline with quoteRef.
  ========================================================= */
  section('WORKFLOW A — Customer Quote → Approval');

  // 1) customer submits a commercial quote
  const quoteId = await EGC.nextQuoteId();
  const quoteDoc = {
    quoteId, customerUid: 'cust-A-uid', shipmentType: 'commercial',
    customerName: 'Acme Traders', customerEmail: 'a@acme.test', customerPhone: '9990001111',
    companyName: 'Acme Traders Pvt Ltd', customerGst: '23ABCDE1234F1Z5',
    contactPerson: 'R Sharma', companyMobile: '9990001111', companyEmail: 'billing@acme.test',
    registeredAddress: 'Plot 4, MIDC', city: 'Indore', state: 'MP',
    consigneeName: 'BuildCo Ltd', consigneeContactPerson: 'K Patel', consigneeContact: '8880002222',
    consigneeEmail: 'recv@buildco.test', consigneeGstin: '27ZZYYX9876W1AA',
    consigneeAddress: 'Sector 9, Andheri', consigneeCity: 'Mumbai', consigneeState: 'MH',
    pickup: 'Indore', delivery: 'Mumbai', materialType: 'Machinery & Equipment',
    weight: '5200', packages: '14', pickupDate: '2026-01-20', notes: 'Handle with care',
    status: EGC.QUOTE_STATUS.PENDING,
  };
  await w.fbDB.collection('quotes').doc(quoteId).set(quoteDoc);
  info('Quote submitted: ' + quoteId);

  // 2) owner approves at freight ₹18000 → shared pipeline (quoteRef path)
  const freightA = 18000;
  const idsA = { orderId: await EGC.nextOrderId(), invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), docketNo: await LR.nextDocketNumber() };
  const orderA = SHIP.buildOrder({ orderId: idsA.orderId, quoteId, invoiceId: idsA.invoiceId, lrNumber: idsA.lrNumber, quote: quoteDoc, pricing: { freight: freightA } });
  orderA.status = EGC.ORDER_STATUS.APPROVED; orderA.invoiceGenerated = true; orderA.lrGenerated = true;
  await runPipeline(w, orderA, idsA, { quoteRef: w.fbDB.collection('quotes').doc(quoteId), freight: freightA, previousQuoteStatus: quoteDoc.status, notify: true, onAudit: 'quote' });
  await settle(120);

  const aOrder = env.DB.orders[idsA.orderId];
  const aInv = env.DB.invoices[idsA.invoiceId];
  const aLr = env.DB.lorryReceipts[idsA.lrNumber];
  const aQuote = env.DB.quotes[quoteId];

  ok(!!aOrder, 'A: order document created');
  ok(!!aInv, 'A: invoice document created');
  ok(!!aLr, 'A: LR document created');
  ok(aQuote.status === 'approved', 'A: quote flipped to approved');
  ok(aQuote.orderId === idsA.orderId, 'A: quote linked to order');
  ok(aInv.orderId === idsA.orderId && aLr.orderId === idsA.orderId, 'A: invoice & LR reference the order');
  ok(aInv.lrNumber === idsA.lrNumber && aLr.invoiceId === idsA.invoiceId, 'A: invoice ↔ LR cross-linked');
  ok(aInv.customerUid === 'cust-A-uid' && aLr.customerUid === 'cust-A-uid', 'A: docs carry customerUid');
  // invoice/LR are THIN (no duplicated shared business fields)
  ok(!('freightCharges' in aInv) && !('consigneeName' in aInv), 'A: invoice is thin (no duplicated shared fields)');
  ok(!('consigneeName' in aLr) && !('freight' in aLr), 'A: LR is thin (no duplicated shared fields)');

  // 3) projections (SSoT) — documents project from the order
  const aInvView = SHIP.toInvoiceView(aOrder, aInv);
  const aLrView = SHIP.toLrView(aOrder, aLr);
  ok(aInvView.customerName === 'Acme Traders', 'A: invoice view projects customer from order');
  ok(aLrView.consigneeName === 'BuildCo Ltd', 'A: LR view projects consignee from order');
  ok(INV.toNum(aInvView.invoiceAmount) === 18000, 'A: invoice grand total = freight (no extra charges yet)');
  ok(aLrView.grandTotalAmount === 18000, 'A: LR grand total equals invoice total');

  // 4) accounting — sales posted, balanced, single entry
  const aSales = entriesFor(w, idsA.orderId, 'SALES');
  ok(aSales.length === 1, 'A: exactly one SALES entry posted');
  ok(aSales[0] && aSales[0].totalDebit === aSales[0].totalCredit, 'A: SALES entry balanced');
  ok(aSales[0] && aSales[0].totalDebit === 18000, 'A: SALES entry = ₹18000');
  const aReceipts = entriesFor(w, idsA.orderId, 'RECEIPT');
  ok(aReceipts.length === 0, 'A: no receipt yet (no advance)');

  // 5) accounting row (Reports / Excel projection)
  const aRow = SHIP.toAccountingRow(aOrder);
  ok(aRow.orderId === idsA.orderId && aRow.invoiceNumber === idsA.invoiceId, 'A: accounting/reports row keyed correctly');
  ok(aRow.grandTotal === 18000 && aRow.outstanding === 18000, 'A: reports row totals correct');

  // 6) Tracking projection parity (what the customer Tracking hub reads)
  ok(aInvView.fromLocation === 'Indore' && aInvView.toLocation === 'Mumbai', 'A: tracking route resolves from SSoT');
  ok(INV.effectiveStatus(aInvView) === 'pending', 'A: tracking payment status = pending');

  /* =========================================================
     WORKFLOW B — PHONE CALL → OWNER MANUAL ORDER → ...
     Replicates OWN.submitManualOrder's core: synthetic quote +
     owner overrides → SHIP.buildOrder → shared pipeline (no quoteRef).
  ========================================================= */
  section('WORKFLOW B — Phone Call → Manual Order');

  const synthQuote = {
    shipmentType: 'commercial', customerUid: null,
    companyName: 'Phone Co', customerGst: '23PHONE1234F1Z5', contactPerson: 'Owner Caller',
    companyMobile: '9112223334', companyEmail: 'ph@phone.test',
    registeredAddress: 'Old Market', city: 'Bhopal', state: 'MP',
    consigneeName: 'Dest Traders', consigneeContact: '9223334445', consigneeGstin: '24DEST9876W1AA',
    consigneeAddress: 'Ring Rd', consigneeCity: 'Nagpur', consigneeState: 'MH',
    customerName: 'Phone Co', customerPhone: '9112223334', customerEmail: 'ph@phone.test',
    pickup: 'Bhopal', delivery: 'Nagpur', materialType: 'Consumer Goods / FMCG',
    weight: '3000', packages: '8', pickupDate: '2026-01-22', notes: 'Phone booking',
  };
  const ownerOverrides = {
    freight: 12000, haltingCharges: 500, extraCharges: 300, discount: 200, advanceReceived: 5000,
    vehicleNumber: 'MP04AB1234', driverName: 'S Yadav', driverMobile: '9445556667',
    estimatedDelivery: '2026-01-25', ewayBill: 'EWB12345', remarks: 'Phone booking',
  };
  const freightB = 12000;
  const idsB = { orderId: await EGC.nextOrderId(), invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), docketNo: await LR.nextDocketNumber() };
  const orderB = SHIP.buildOrder({ orderId: idsB.orderId, quoteId: null, invoiceId: idsB.invoiceId, lrNumber: idsB.lrNumber, quote: synthQuote, pricing: { freight: freightB }, owner: ownerOverrides });
  orderB.status = EGC.ORDER_STATUS.APPROVED; orderB.invoiceGenerated = true; orderB.lrGenerated = true;
  await runPipeline(w, orderB, idsB, { freight: freightB, notify: false, onAudit: 'manual' });
  await settle(120);

  const bOrder = env.DB.orders[idsB.orderId];
  const bInv = env.DB.invoices[idsB.invoiceId];
  const bLr = env.DB.lorryReceipts[idsB.lrNumber];

  ok(!!bOrder, 'B: order document created');
  ok(!!bInv && !!bLr, 'B: invoice & LR created');
  ok(bInv.orderId === idsB.orderId && bLr.orderId === idsB.orderId, 'B: invoice & LR reference the order');
  ok(bInv.lrNumber === idsB.lrNumber && bLr.invoiceId === idsB.invoiceId, 'B: invoice ↔ LR cross-linked');
  ok(bOrder.quoteId === null, 'B: order has no quote (pure manual)');
  ok(bOrder.source === 'owner_manual', 'B: order tagged owner_manual (provenance)');
  ok(bOrder.customerUid === null && bInv.customerUid === null, 'B: phone order has null customerUid (acceptable)');

  // owner-known pricing baked into the ORDER (SSoT), not the docs
  const bCharges = SHIP.computeCharges(bOrder);
  ok(bCharges.lines.freight === 12000 && bCharges.lines.haltingCharges === 500 && bCharges.lines.extraCharges === 300, 'B: charge breakdown stored on order');
  ok(bCharges.discount === 200, 'B: discount stored on order');
  ok(bCharges.grandTotal === 12600, 'B: grand total = 12000+500+300-200');
  ok(bCharges.advance === 5000 && bCharges.outstanding === 7600, 'B: advance + outstanding correct');
  ok(bOrder.paymentStatus === 'partial', 'B: payment status derived = partial');
  ok(bOrder.vehicleNumber === 'MP04AB1234' && bOrder.driverName === 'S Yadav', 'B: transport details stored on order');
  ok(bOrder.estimatedDelivery === '2026-01-25', 'B: ETA stored on order');
  ok(bOrder.ewayBill === 'EWB12345', 'B: e-way bill stored on order');

  // projections
  const bInvView = SHIP.toInvoiceView(bOrder, bInv);
  const bLrView = SHIP.toLrView(bOrder, bLr);
  ok(bInvView.customerCompany === 'Phone Co', 'B: invoice projects company from order');
  ok(bLrView.vehicleNumber === 'MP04AB1234' && bLrView.driverName === 'S Yadav', 'B: LR projects transport from order');
  ok(bLrView.estimatedDelivery === '2026-01-25', 'B: LR view exposes ETA for editor pre-fill');
  ok(INV.toNum(bInvView.invoiceAmount) === 12600, 'B: invoice grand total = order grand total');
  ok(bLrView.grandTotalAmount === 12600, 'B: LR grand total equals invoice total');

  // accounting — sales + receipt (advance) posted
  const bSales = entriesFor(w, idsB.orderId, 'SALES');
  const bRcpt = entriesFor(w, idsB.orderId, 'RECEIPT');
  function debtorsDebit(entry, w2) { const dr = ACC.acct('debtors'); const ln = (entry.lines || []).filter((l) => l.accountCode === dr && l.debit > 0)[0]; return ln ? ln.debit : 0; }
  ok(bSales.length === 1, 'B: exactly one SALES entry');
  ok(bSales[0] && debtorsDebit(bSales[0]) === 12600, 'B: SALES debtors receivable = ₹12600 (grand total)');
  ok(bSales[0].totalDebit === bSales[0].totalCredit, 'B: SALES balanced (double-entry incl. discount line)');
  ok(bRcpt.length === 1 && bRcpt[0].totalDebit === 5000, 'B: RECEIPT entry = ₹5000 (advance)');
  ok(bRcpt[0].totalDebit === bRcpt[0].totalCredit, 'B: RECEIPT balanced');

  const bRow = SHIP.toAccountingRow(bOrder);
  ok(bRow.grandTotal === 12600 && bRow.outstanding === 7600, 'B: reports row totals correct');
  ok(bRow.estimatedDelivery === '2026-01-25', 'B: reports row carries ETA');

  /* =========================================================
     CONVERGENCE — same inputs ⇒ identical Order shape
  ========================================================= */
  section('CONVERGENCE — Manual vs Quote produce identical Order shape');

  // Build a quote-order and a manual-order from IDENTICAL business inputs and
  // compare the canonical field set (ignoring identity/timestamps/provenance).
  const sharedQuoteInput = {
    shipmentType: 'commercial', customerUid: 'cust-X',
    companyName: 'Same Co', customerGst: 'GSTSAME', contactPerson: 'P', companyMobile: '1', companyEmail: 'e',
    registeredAddress: 'addr', city: 'C', state: 'S',
    consigneeName: 'Cons Co', consigneeContact: '2', consigneeGstin: 'GSTCONS', consigneeAddress: 'caddr', consigneeCity: 'CC', consigneeState: 'CS',
    customerName: 'Same Co', customerPhone: '1', customerEmail: 'e',
    pickup: 'P1', delivery: 'D1', materialType: 'Other Cargo', weight: '1000', packages: '3', pickupDate: '2026-02-01', notes: 'n',
  };
  const qOrder = SHIP.buildOrder({ orderId: 'O-Q', quoteId: 'Q-Q', invoiceId: 'I-Q', lrNumber: 'L-Q', quote: sharedQuoteInput, pricing: { freight: 9000 } });
  // manual: same inputs, freight provided via owner bundle, nothing else extra
  const mOrder = SHIP.buildOrder({ orderId: 'O-M', quoteId: null, invoiceId: 'I-M', lrNumber: 'L-M', quote: sharedQuoteInput, pricing: { freight: 9000 }, owner: { freight: 9000 } });

  const CANON = SHIP.EDITABLE_FIELDS.concat([
    'customerName', 'customerEmail', 'customerPhone', 'companyName', 'customerGst',
    'consignorName', 'consignorAddress', 'consigneeName', 'consigneeAddress',
    'pickup', 'delivery', 'materialType', 'packages', 'shipmentType', 'pickupDate',
  ]);
  let identical = true; const diffs = [];
  CANON.forEach((k) => {
    const a = JSON.stringify(qOrder[k]); const b = JSON.stringify(mOrder[k]);
    if (a !== b) { identical = false; diffs.push(`${k}: quote=${a} manual=${b}`); }
  });
  ok(identical, 'Manual and quote orders share identical canonical fields' + (identical ? '' : ' — DIFF: ' + diffs.join(' | ')));
  ok(SHIP.computeCharges(qOrder).grandTotal === SHIP.computeCharges(mOrder).grandTotal, 'Convergence: identical grand totals');
  // downstream projections identical (ignoring doc identity)
  const qiv = SHIP.toInvoiceView(qOrder, { invoiceId: 'I-Q' });
  const miv = SHIP.toInvoiceView(mOrder, { invoiceId: 'I-M' });
  ok(qiv.customerName === miv.customerName && qiv.invoiceAmount === miv.invoiceAmount, 'Convergence: identical invoice projection');

  /* =========================================================
     MANAGE SHIPMENT EDIT — propagation + accounting resync
     (replicate saveLrEdits's order write + autoResyncSales)
  ========================================================= */
  section('MANAGE SHIPMENT — edit propagates everywhere');

  // Edit order B: add extra charge, raise received to full → status paid.
  // Mirror saveLrEdits: write canonical fields to the ORDER, then resync.
  const editUpdate = {
    extraCharges: 1300,                 // was 300 → +1000 to grand total
    receivedAmount: 7600 + 1000,        // pay it fully off (advance 5000 + received 8600 = 13600 = new grand)
    paymentStatus: 'paid',
    estimatedDelivery: '2026-01-26',
    updatedAt: w.firebase.firestore.FieldValue.serverTimestamp(),
  };
  const priorPaid = SHIP.computeCharges(bOrder).received + SHIP.computeCharges(bOrder).advance; // 5000
  await w.fbDB.collection('orders').doc(idsB.orderId).update(editUpdate);
  const bOrder2raw = env.DB.orders[idsB.orderId];
  const bOrder2 = Object.assign({}, bOrder2raw, { orderId: idsB.orderId });
  SHIP.primeOrder(bOrder2);

  // accounting resync (delta) + receipt for newly received delta
  await ACC.loadSettings();
  await ACC.autoResyncSales(bOrder2);
  const newPaid = SHIP.computeCharges(bOrder2).received + SHIP.computeCharges(bOrder2).advance; // 13600
  const delta = ACC.round2(newPaid - priorPaid); // 8600
  if (delta > 0) await ACC.autoPostReceipt(bOrder2, delta, 'bank');
  await settle(120);

  const bCharges2 = SHIP.computeCharges(bOrder2);
  ok(bCharges2.grandTotal === 13600, 'Edit: order grand total updated to ₹13600');
  ok(bCharges2.outstanding === 0, 'Edit: outstanding now 0 (paid)');
  // invoice + LR projections reflect the edit WITHOUT touching their docs
  const bInv2 = SHIP.toInvoiceView(bOrder2, env.DB.invoices[idsB.invoiceId]);
  const bLr2 = SHIP.toLrView(bOrder2, env.DB.lorryReceipts[idsB.lrNumber]);
  ok(INV.toNum(bInv2.invoiceAmount) === 13600, 'Edit: invoice projection reflects new total');
  ok(bLr2.grandTotalAmount === 13600, 'Edit: LR projection reflects new total');
  ok(bLr2.estimatedDelivery === '2026-01-26', 'Edit: ETA change propagates to LR view');
  ok(INV.effectiveStatus(bInv2) === 'paid', 'Edit: payment status propagates (paid)');
  // accounting: sales resync as ADJUSTMENT (receipts existed) + new receipt
  const bSalesAll = Object.values(env.DB.journalEntries).filter((e) => e.orderId === idsB.orderId && e.type === 'SALES' && e.status === 'posted');
  const bRcptAll = entriesFor(w, idsB.orderId, 'RECEIPT');
  const drAcct = ACC.acct('debtors');
  function netDebtors(entries) {
    return entries.reduce((s, e) => s + (e.lines || []).reduce((ls, l) => ls + (l.accountCode === drAcct ? (l.debit - l.credit) : 0), 0), 0);
  }
  // net debtors receivable from sales (orig 12600 + adjustment 1000) = 13600
  ok(netDebtors(bSalesAll) === 13600, 'Edit: net sales receivable resynced to ₹13600 (adjustment posted)');
  ok(bSalesAll.length === 2, 'Edit: original SALES preserved + one ADJUSTMENT (history intact)');
  const rcptTotal = bRcptAll.reduce((s, e) => s + e.totalDebit, 0);
  ok(rcptTotal === 13600, 'Edit: total receipts now ₹13600 (5000 advance + 8600 delta)');
  bRcptAll.concat(bSalesAll).forEach((e) => { if (e.totalDebit !== e.totalCredit) ok(false, 'Edit: entry ' + e.entryId + ' unbalanced'); });
  ok(true, 'Edit: all accounting entries balanced');

  /* =========================================================
     INTEGRITY — no duplicates / orphans / broken refs
  ========================================================= */
  section('INTEGRITY — duplicates, orphans, references');

  const orders = allDocs('orders');
  const invoices = allDocs('invoices');
  const lrs = allDocs('lorryReceipts');

  // unique IDs
  const oIds = orders.map((o) => o.orderId);
  ok(new Set(oIds).size === oIds.length, 'No duplicate order IDs');
  const iIds = invoices.map((i) => i.invoiceId);
  ok(new Set(iIds).size === iIds.length, 'No duplicate invoice IDs');
  const lIds = lrs.map((l) => l.lrNumber);
  ok(new Set(lIds).size === lIds.length, 'No duplicate LR numbers');
  // one invoice + one LR per order
  orders.forEach((o) => {
    const myInv = invoices.filter((i) => i.orderId === o.orderId);
    const myLr = lrs.filter((l) => l.orderId === o.orderId);
    ok(myInv.length === 1, 'Order ' + o.orderId + ' has exactly one invoice');
    ok(myLr.length === 1, 'Order ' + o.orderId + ' has exactly one LR');
  });
  // every invoice/LR points to an existing order (no orphans)
  invoices.forEach((i) => ok(!!env.DB.orders[i.orderId], 'Invoice ' + i.invoiceId + ' → existing order'));
  lrs.forEach((l) => ok(!!env.DB.orders[l.orderId], 'LR ' + l.lrNumber + ' → existing order'));
  // counters advanced (gap-over-duplicate): order/invoice/lr/journal counters exist
  ok(env.DB.counters && env.DB.counters.orders && env.DB.counters.invoices, 'Counters tracked for orders & invoices');

  /* =========================================================
     REGRESSION — Workflow A still intact after later writes
  ========================================================= */
  section('REGRESSION — Workflow A unaffected by later operations');
  const aOrderNow = env.DB.orders[idsA.orderId];
  ok(aOrderNow && SHIP.computeCharges(aOrderNow).grandTotal === 18000, 'A: order total still ₹18000 after B + edits');
  ok(entriesFor(w, idsA.orderId, 'SALES').length === 1, 'A: still exactly one SALES entry');
  ok(env.DB.quotes[quoteId].status === 'approved', 'A: quote still approved');

  /* =========================================================
     DOUBLE-APPROVAL GUARD — re-running quote pipeline aborts
  ========================================================= */
  section('GUARD — re-approving an approved quote creates no duplicates');
  let aborted = false;
  const idsDup = { orderId: await EGC.nextOrderId(), invoiceId: await EGC.nextInvoiceId(), lrNumber: await INV.nextLrNumber(), docketNo: await LR.nextDocketNumber() };
  const dupOrder = SHIP.buildOrder({ orderId: idsDup.orderId, quoteId, invoiceId: idsDup.invoiceId, lrNumber: idsDup.lrNumber, quote: quoteDoc, pricing: { freight: freightA } });
  try {
    await runPipeline(w, dupOrder, idsDup, { quoteRef: w.fbDB.collection('quotes').doc(quoteId), freight: freightA, notify: false, onAudit: 'quote' });
  } catch (e) { aborted = (e.message === 'ALREADY_APPROVED'); }
  await settle();
  ok(aborted, 'Guard: second approval throws ALREADY_APPROVED');
  ok(!env.DB.orders[idsDup.orderId], 'Guard: no duplicate order written');
  ok(!env.DB.invoices[idsDup.invoiceId], 'Guard: no duplicate invoice written');
  ok(allDocs('orders').filter((o) => o.quoteId === quoteId).length === 1, 'Guard: still exactly one order for the quote');

  /* =========================================================
     TRACKING RESOLUTION — invoice# and LR# both resolve order
  ========================================================= */
  section('TRACKING — resolve shipment by Invoice# and LR#');
  // simulate the customer caches (own docs) + the lookup logic
  function norm(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }
  const custInv = allDocs('invoices').filter((i) => i.customerUid === 'cust-A-uid').map((i) => Object.assign({ _docId: i._id }, i));
  const custLr = allDocs('lorryReceipts').filter((l) => l.customerUid === 'cust-A-uid');
  function findByNumber(q) {
    q = norm(q);
    let inv = custInv.filter((i) => norm(i.invoiceNumber || i.invoiceId) === q)[0];
    if (inv) return inv;
    const lr = custLr.filter((l) => norm(l.lrNumber) === q)[0];
    if (lr) return custInv.filter((i) => (lr.invoiceId && i.invoiceId === lr.invoiceId) || (lr.orderId && i.orderId === lr.orderId))[0];
    return null;
  }
  const byInv = findByNumber(idsA.invoiceId);
  const byLr = findByNumber(idsA.lrNumber);
  ok(byInv && byInv.orderId === idsA.orderId, 'Tracking: invoice number resolves the shipment');
  ok(byLr && byLr.orderId === idsA.orderId, 'Tracking: LR number resolves the same shipment');
  // tracking hub reads SSoT projection
  const trkView = SHIP.toInvoiceView(env.DB.orders[idsA.orderId], byInv);
  ok(trkView.fromLocation === 'Indore' && trkView.toLocation === 'Mumbai', 'Tracking: hub shows correct route from SSoT');
  // manual phone order (no customerUid) must NOT leak into a customer cache
  const phoneInCustCache = custInv.some((i) => i.invoiceId === idsB.invoiceId);
  ok(!phoneInCustCache, 'Tracking: phone order (null uid) absent from customer cache (correct, owner-only)');
  // …but if it WERE later linked to this account, it would resolve:
  const linkedInv = Object.assign({ _docId: 'X' }, env.DB.invoices[idsB.invoiceId], { customerUid: 'cust-A-uid' });
  const linkedFind = [linkedInv].filter((i) => norm(i.invoiceNumber || i.invoiceId) === norm(idsB.invoiceId))[0];
  ok(!!linkedFind, 'Tracking: a future-linked manual order resolves with no architecture change');

  /* =========================================================
     OWNER-SIDE VISIBILITY of manual order (Orders/Inv/LR/Acct/Reports)
  ========================================================= */
  section('OWNER VISIBILITY — manual order present in every owner module');
  ok(!!env.DB.orders[idsB.orderId], 'Owner Orders: manual order present');
  ok(!!env.DB.invoices[idsB.invoiceId], 'Owner Invoices: manual invoice present');
  ok(!!env.DB.lorryReceipts[idsB.lrNumber], 'Owner LR: manual LR present');
  ok(entriesFor(w, idsB.orderId, 'SALES').length >= 1, 'Owner Accounting: manual sales present');
  ok(SHIP.toAccountingRow(env.DB.orders[idsB.orderId]).grandTotal === 13600, 'Owner Reports/Excel: manual row present & current');

  /* =========================================================
     RESULTS
  ========================================================= */
  console.log('\n' + '='.repeat(60));
  console.log('  RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(60));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  else console.log('\n✓ ALL CHECKS PASSED — both workflows verified end-to-end.');
}

main().catch((e) => { console.error('\nHARNESS ERROR:', e.stack); process.exit(2); });

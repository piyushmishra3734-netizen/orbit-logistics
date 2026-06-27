/* ============================================================================
   Orbit AI — MORNING BRIEF QA (offline)
   Verifies real-figure computation, the no-fabrication guarantee (TDS omitted
   when no account exists), interstate-GST detection, slow-payer ranking,
   revenue trend, and recommendations.
   ============================================================================ */
'use strict';
const { buildMorningBrief } = require('../morning-brief');

let PASS = 0, FAIL = 0; const fails = [];
function ok(c, m) { if (c) PASS++; else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } }
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

const today = new Date().toISOString().slice(0, 10);
const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const d = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

function baseBundle(extraAccounts, extraEntries) {
  return {
    settings: null,
    accounts: [
      { code: '1200', name: 'Sundry Debtors', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
      { code: '4000', name: 'Freight Income', type: 'INCOME', group: 'Revenue', openingBalance: 0, openingType: 'CR' },
      { code: '1110', name: 'Bank', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
    ].concat(extraAccounts || []),
    parties: [
      { partyId: 'cust-acme', name: 'ACME Transport', kind: 'customer', openingBalance: 0, openingType: 'DR' },
      { partyId: 'cust-rk', name: 'RK Logistics', kind: 'customer', openingBalance: 0, openingType: 'DR' },
    ],
    entries: [
      { entryId: 'J1', date: d(70), type: 'SALES', status: 'posted', party: 'cust-acme', lines: [{ accountCode: '1200', debit: 200000, credit: 0, party: 'cust-acme' }, { accountCode: '4000', debit: 0, credit: 200000 }] },
      { entryId: 'J2', date: today, type: 'SALES', status: 'posted', party: 'cust-rk', lines: [{ accountCode: '1200', debit: 114000, credit: 0, party: 'cust-rk' }, { accountCode: '4000', debit: 0, credit: 114000 }] },
      { entryId: 'J3', date: yest, type: 'SALES', status: 'posted', party: 'cust-rk', lines: [{ accountCode: '1200', debit: 100000, credit: 0, party: 'cust-rk' }, { accountCode: '4000', debit: 0, credit: 100000 }] },
    ].concat(extraEntries || []),
  };
}

function main() {
  section('Morning Brief — core signals');
  const orders = [
    { orderId: 'EGC-1', status: 'in_transit', freight: 200000 },
    { orderId: 'EGC-2', status: 'truck_assigned', freight: 50000 },
    { orderId: 'EGC-3', status: 'delivered', freight: 100000 },
  ];
  const b = buildMorningBrief({ ownerName: 'Piyush', bundle: baseBundle(), orders });

  ok(/Good (morning|afternoon|evening), Piyush\./.test(b.greeting), 'Greeting addresses owner by name');
  const kinds = b.items.map((i) => i.kind);
  ok(kinds.includes('pending_deliveries'), 'Reports pending deliveries');
  ok(b.items.find((i) => i.kind === 'pending_deliveries').count === 2, 'Pending deliveries count correct (2 active)');
  ok(kinds.includes('outstanding_total'), 'Reports total outstanding');
  ok(/4\.14 lakh/.test(b.items.find((i) => i.kind === 'outstanding_total').text), 'Outstanding shown as ₹4.14 lakh');
  ok(kinds.includes('slow_payer'), 'Identifies a slow payer');
  ok(b.items.find((i) => i.kind === 'slow_payer').customer === 'ACME Transport', 'Slow payer is ACME (70 days)');
  ok(kinds.includes('revenue_trend'), 'Reports revenue trend');
  ok(b.items.find((i) => i.kind === 'revenue_trend').changePct === 14, 'Revenue up 14% vs yesterday');
  ok(b.recommendations.some((r) => /ACME/.test(r)), 'Recommends following up ACME first');

  section('No fabrication — TDS only when the account exists');
  ok(!kinds.includes('tds_receivable'), 'No TDS account → TDS item OMITTED (not invented)');
  const withTds = buildMorningBrief({ ownerName: 'Piyush',
    bundle: baseBundle(
      [{ code: '2200', name: 'TDS Receivable', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' }],
      [{ entryId: 'T1', date: today, type: 'JOURNAL', status: 'posted', lines: [{ accountCode: '2200', debit: 62000, credit: 0 }, { accountCode: '1110', debit: 0, credit: 62000 }] }]),
    orders });
  const tds = withTds.items.find((i) => i.kind === 'tds_receivable');
  ok(!!tds && tds.value === 62000, 'TDS account present → reports real ₹62,000 receivable');

  section('Interstate GST detection');
  const gstOrders = [
    { orderId: 'EGC-X', status: 'delivered', freight: 100000, sgstRate: 9, cgstRate: 9, consignorState: 'MP', consigneeState: 'MH' }, // interstate w/ SGST+CGST → flag
    { orderId: 'EGC-Y', status: 'delivered', freight: 100000, sgstRate: 9, cgstRate: 9, consignorState: 'MP', consigneeState: 'MP' }, // intrastate → ok
    { orderId: 'EGC-Z', status: 'delivered', freight: 100000, sgstRate: 0, cgstRate: 0, consignorState: 'MP', consigneeState: 'MH' }, // no GST → ignore
  ];
  const bg = buildMorningBrief({ ownerName: 'Piyush', bundle: baseBundle(), orders: gstOrders });
  const gi = bg.items.find((i) => i.kind === 'gst_mismatch');
  ok(!!gi && gi.count === 1 && gi.ids[0] === 'EGC-X', 'Flags exactly the interstate SGST+CGST invoice (EGC-X)');
  ok(bg.recommendations.some((r) => /GST/.test(r)), 'Recommends reviewing the GST mismatch');

  section('Empty/edge — no data is safe');
  const empty = buildMorningBrief({ ownerName: '', bundle: { accounts: [], parties: [], entries: [], settings: null }, orders: [] });
  ok(Array.isArray(empty.items) && Array.isArray(empty.recommendations), 'Empty data → valid brief, no crash');
  ok(/Good (morning|afternoon|evening)\./.test(empty.greeting), 'Greeting works with no name');

  console.log('\n' + '='.repeat(56));
  console.log('  MORNING BRIEF RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL MORNING BRIEF CHECKS PASSED.');
}
main();

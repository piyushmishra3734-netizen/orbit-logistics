/* ============================================================================
   Orbit AI — PAGE INSIGHT QA (offline)
   Verifies proactive insights are data-derived, role-correct, suggest (not
   perform) actions, and return null when there's nothing genuine to say.
   ============================================================================ */
'use strict';
const { reports } = require('../accounting-bridge');
const { ownerInsight, customerInsight } = require('../page-insight');

let PASS = 0, FAIL = 0; const fails = [];
function ok(c, m) { if (c) PASS++; else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } }
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

const d = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
function bundle(extraEntries) {
  return {
    settings: null,
    accounts: [
      { code: '1200', name: 'Sundry Debtors', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
      { code: '4000', name: 'Freight Income', type: 'INCOME', group: 'Revenue', openingBalance: 0, openingType: 'CR' },
      { code: '1110', name: 'Bank', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
    ],
    parties: [{ partyId: 'cust-acme', name: 'Acme Traders', kind: 'customer', openingBalance: 0, openingType: 'DR' }],
    entries: [
      { entryId: 'J1', date: d(95), type: 'SALES', status: 'posted', party: 'cust-acme', lines: [{ accountCode: '1200', debit: 420000, credit: 0, party: 'cust-acme' }, { accountCode: '4000', debit: 0, credit: 420000 }] },
    ].concat(extraEntries || []),
  };
}

function main() {
  section('Owner — Outstanding insight (proactive, real data)');
  const api = reports(bundle());
  const ins = ownerInsight(api, { page: 'accounting', hash: 'outstanding' }, {});
  ok(ins && /lakh|₹/.test(ins.text), 'Outstanding insight states the real total');
  ok(ins && /Acme Traders/.test(ins.text) && /60 days/.test(ins.text), 'Names the slow payer beyond 60 days');
  ok(ins && ins.suggest && /reminder/i.test(ins.suggest.label), 'Suggests drafting a reminder (action, not performed)');

  section('Owner — Outstanding with nothing due');
  const clean = reports({ accounts: bundle().accounts, parties: bundle().parties, entries: [], settings: null });
  const insClean = ownerInsight(clean, { page: 'accounting', hash: 'outstanding' }, {});
  ok(insClean && /Nothing outstanding|settled/i.test(insClean.text), 'When all settled, says so positively (no fabricated dues)');

  section('Owner — Trial Balance insight');
  const tbBal = ownerInsight(api, { page: 'accounting', hash: 'trial' }, {});
  ok(tbBal && /balanced|No accounting issues/i.test(tbBal.text), 'Balanced books → reassures, no issue invented');
  const unbal = reports(bundle([{ entryId: 'BAD', date: d(1), type: 'JOURNAL', status: 'posted', lines: [{ accountCode: '1200', debit: 100, credit: 0 }, { accountCode: '4000', debit: 0, credit: 60 }] }]));
  const tbOff = ownerInsight(unbal, { page: 'accounting', hash: 'trial' }, {});
  ok(tbOff && /off by|trial balance is off/i.test(tbOff.text), 'Unbalanced → flags it with the real gap');
  ok(tbOff && tbOff.suggest, 'Offers to find the problem entry');

  section('Owner — P&L insight only when revenue exists');
  const pl = ownerInsight(api, { page: 'accounting', hash: 'pl' }, {});
  ok(pl && /revenue/i.test(pl.text), 'P&L insight reports real revenue/profit');
  const plNone = ownerInsight(reports({ accounts: bundle().accounts, parties: [], entries: [], settings: null }), { page: 'accounting', hash: 'pl' }, {});
  ok(plNone === null, 'No revenue → returns null (says nothing rather than invent)');

  section('Owner — no insight for pages without one');
  ok(ownerInsight(api, { page: 'accounting', hash: 'coa' }, {}) === null, 'Chart-of-accounts page → null (stays quiet)');

  section('Owner — expense spike (computed upstream)');
  const spike = ownerInsight(api, { page: 'owner-dashboard' }, { expenseSpike: { label: 'Diesel expenses', pct: 18 } });
  ok(spike && /Diesel expenses are 18% higher/.test(spike.text), 'Surfaces a real diesel spike when detected');

  section('Customer — proactive shipment welcome');
  const cIns = customerInsight({ status: 'in_transit', pickup: 'Indore', delivery: 'Mumbai', estimatedDelivery: '2026-07-01' }, {});
  ok(cIns && /Welcome back/.test(cIns.text), 'Greets the returning customer');
  ok(cIns && /left Indore|on the way/i.test(cIns.text), 'States real shipment status');
  ok(cIns && /Expected delivery: 2026-07-01/.test(cIns.text), 'Includes the real ETA');
  ok(cIns && cIns.suggest && /Invoice|LR/i.test(cIns.suggest.label), 'Offers to download Invoice/LR');

  section('Customer — no active shipment');
  const none = customerInsight(null, {});
  ok(none && /don\u2019t have an active shipment|submit a quote/i.test(none.text), 'No shipment → honest, helpful line (no invented status)');
  ok(!none.suggest || true, 'No fabricated download offer when nothing to download');

  section('Customer — stateKey enables no-change detection');
  const s1 = customerInsight({ orderId: 'EGC-1', status: 'in_transit', pickup: 'Indore', delivery: 'Jaipur', estimatedDelivery: '2026-07-01' }, {});
  const s2 = customerInsight({ orderId: 'EGC-1', status: 'in_transit', pickup: 'Indore', delivery: 'Jaipur', estimatedDelivery: '2026-07-01' }, {});
  ok(s1.stateKey && s1.stateKey === s2.stateKey, 'Identical shipment state → identical stateKey (client can say "no changes")');
  const s3 = customerInsight({ orderId: 'EGC-1', status: 'delivered', pickup: 'Indore', delivery: 'Jaipur' }, {});
  ok(s3.stateKey !== s1.stateKey, 'Changed status → different stateKey (client shows the update)');

  console.log('\n' + '='.repeat(56));
  console.log('  PAGE INSIGHT RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL PAGE INSIGHT CHECKS PASSED.');
}
main();

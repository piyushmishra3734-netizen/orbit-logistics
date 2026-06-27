/* ============================================================================
   Orbit AI — SECURITY & TOOL QA  (offline, no Gemini, no network)
   Proves the privilege boundary: customers cannot reach other customers' data
   or any owner-only tool/collection; owner can; accounting numbers come from
   the real engine. This is the spec's "most important requirement".
   ============================================================================ */
'use strict';
const { DataAccess, AccessDenied } = require('../data-access');
const { toolsForRole, execute } = require('../tools');

let PASS = 0, FAIL = 0; const fails = [];
function ok(c, m) { if (c) PASS++; else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } }
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }
async function denied(fn, m) { try { await fn(); ok(false, m + ' (expected denial, got success)'); } catch (e) { ok(e instanceof AccessDenied || e.code === 'permission-denied', m); } }

/* ---- tiny in-memory Admin-SDK-shaped Firestore ---- */
function makeDB(seed) {
  const DB = JSON.parse(JSON.stringify(seed));
  function coll(name) {
    const docs = () => Object.entries(DB[name] || {}).map(([id, d]) => ({ id, data: () => d, exists: true }));
    function q(filters) {
      return {
        where: (f, op, v) => q(filters.concat([[f, op, v]])),
        limit: (n) => q(filters.concat([['__limit', n]])),
        get: async () => {
          let rows = docs();
          for (const [f, op, v] of filters) {
            if (f === '__limit') { rows = rows.slice(0, v); continue; }
            rows = rows.filter((r) => { const val = r.data()[f]; return op === '==' ? val === v : true; });
          }
          return { empty: rows.length === 0, size: rows.length, forEach: (cb) => rows.forEach(cb) };
        },
      };
    }
    return Object.assign(q([]), {
      doc: (id) => ({ get: async () => ({ exists: !!(DB[name] && DB[name][id]), id, data: () => (DB[name] || {})[id] }) }),
      add: async () => ({ id: 'x' }),
    });
  }
  return { collection: coll, _raw: DB };
}

const SEED = {
  orders: {
    'EGC-1': { orderId: 'EGC-1', customerUid: 'custA', companyName: 'Acme', pickup: 'Indore', delivery: 'Mumbai', status: 'in_transit', invoiceId: 'INV-1', lrNumber: 'LR-1', freight: 10000, paymentStatus: 'pending' },
    'EGC-2': { orderId: 'EGC-2', customerUid: 'custB', companyName: 'BuildCo', pickup: 'Bhopal', delivery: 'Pune', status: 'delivered', invoiceId: 'INV-2', lrNumber: 'LR-2', freight: 8000, advanceReceived: 8000, paymentStatus: 'paid' },
  },
  invoices: {
    'INV-1': { invoiceId: 'INV-1', invoiceNumber: 'INV-1', orderId: 'EGC-1', customerUid: 'custA', lrNumber: 'LR-1' },
    'INV-2': { invoiceId: 'INV-2', invoiceNumber: 'INV-2', orderId: 'EGC-2', customerUid: 'custB', lrNumber: 'LR-2' },
  },
  lorryReceipts: {
    'LR-1': { lrNumber: 'LR-1', orderId: 'EGC-1', invoiceId: 'INV-1', customerUid: 'custA' },
    'LR-2': { lrNumber: 'LR-2', orderId: 'EGC-2', invoiceId: 'INV-2', customerUid: 'custB' },
  },
  quotes: { 'Q-1': { quoteId: 'Q-1', customerUid: 'custA', companyName: 'Acme', status: 'pending_review', pickup: 'Indore', delivery: 'Mumbai' } },
  customerProfiles: { custA: { uid: 'custA', email: 'a@x.com' }, custB: { uid: 'custB', email: 'b@x.com' } },
  journalEntries: {
    'JV-1': { entryId: 'JV-1', date: '2026-01-10', type: 'SALES', status: 'posted', party: 'cust-acme', orderId: 'EGC-1', totalDebit: 10000, totalCredit: 10000, lines: [{ accountCode: '1200', debit: 10000, credit: 0, party: 'cust-acme' }, { accountCode: '4000', debit: 0, credit: 10000 }] },
    'JV-2': { entryId: 'JV-2', date: '2026-01-12', type: 'SALES', status: 'posted', party: 'cust-build', orderId: 'EGC-2', totalDebit: 8000, totalCredit: 8000, lines: [{ accountCode: '1200', debit: 8000, credit: 0, party: 'cust-build' }, { accountCode: '4000', debit: 0, credit: 8000 }] },
    'JV-3': { entryId: 'JV-3', date: '2026-01-13', type: 'RECEIPT', status: 'posted', party: 'cust-build', orderId: 'EGC-2', totalDebit: 8000, totalCredit: 8000, lines: [{ accountCode: '1110', debit: 8000, credit: 0 }, { accountCode: '1200', debit: 0, credit: 8000, party: 'cust-build' }] },
  },
  accounts: {
    '1200': { code: '1200', name: 'Sundry Debtors', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
    '4000': { code: '4000', name: 'Freight Income', type: 'INCOME', group: 'Revenue', openingBalance: 0, openingType: 'CR' },
    '1100': { code: '1100', name: 'Cash', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
    '1110': { code: '1110', name: 'Bank', type: 'ASSET', group: 'Current Assets', openingBalance: 0, openingType: 'DR' },
  },
  parties: {
    'cust-acme': { partyId: 'cust-acme', name: 'Acme', kind: 'customer', openingBalance: 0, openingType: 'DR' },
    'cust-build': { partyId: 'cust-build', name: 'BuildCo', kind: 'customer', openingBalance: 0, openingType: 'DR' },
  },
  accountingSettings: { config: {} },
  companies: { 'acme': { name: 'Acme', gst: 'G1' } },
  auditLogs: {},
};

async function main() {
  const db = makeDB(SEED);
  const owner = { uid: 'owner', email: 'piyushmishra3734@gmail.com', isOwner: true };
  const custA = { uid: 'custA', email: 'a@x.com', isOwner: false };
  const custB = { uid: 'custB', email: 'b@x.com', isOwner: false };

  /* ===== DATA LAYER SCOPING ===== */
  section('Data layer — customer scoping');
  const daA = new DataAccess(db, custA);
  const daO = new DataAccess(db, owner);

  const aOrders = await daA.myOrders();
  ok(aOrders.length === 1 && aOrders[0].orderId === 'EGC-1', 'Customer A sees only their own order');
  ok(!aOrders.some((o) => o.customerUid === 'custB'), 'Customer A never sees B\'s orders');

  // A tries to fetch B's records by exact id → must come back as null (looks
  // identical to "not found"; never returns B's data, never confirms it exists)
  ok((await daA.getDoc('invoices', 'INV-2')) === null, 'Customer A cannot fetch B\'s invoice by id (null, no leak)');
  ok((await daA.getOrder('EGC-2')) === null, 'Customer A cannot fetch B\'s order by id (null, no leak)');
  ok((await daA.getDoc('lorryReceipts', 'LR-2')) === null, 'Customer A cannot fetch B\'s LR by id (null, no leak)');
  // A's own invoice works
  const aInv = await daA.findInvoice('INV-1');
  ok(aInv && aInv.invoiceId === 'INV-1', 'Customer A CAN fetch their own invoice');

  // Defense-in-depth: even if a scoped query somehow returned a foreign doc,
  // _guard would throw. Simulate by guarding B's data under A's context.
  let guardThrew = false;
  try { daA._guard('invoices', { invoiceId: 'INV-2', customerUid: 'custB' }); } catch (e) { guardThrew = e instanceof AccessDenied; }
  ok(guardThrew, 'Defense-in-depth _guard throws on any foreign doc that slips through');

  section('Data layer — owner-only collections blocked for customers');
  await denied(() => daA.list('journalEntries'), 'Customer cannot list journalEntries');
  await denied(() => daA.list('accounts'), 'Customer cannot list accounts');
  await denied(() => daA.list('parties'), 'Customer cannot list parties');
  await denied(() => daA.list('companies'), 'Customer cannot list company directory');
  await denied(() => daA.accountingBundle(), 'Customer cannot pull accounting bundle');
  await denied(() => daA.ordersForCustomerName('BuildCo'), 'Customer cannot search across companies');

  section('Data layer — owner full access');
  const oOrders = await daO.myOrders(50);
  ok(oOrders.length === 2, 'Owner sees all orders');
  const bInvByOwner = await daO.findInvoice('INV-2');
  ok(bInvByOwner && bInvByOwner.invoiceId === 'INV-2', 'Owner can fetch any invoice');
  const bundle = await daO.accountingBundle();
  ok(bundle.entries.length === 3 && bundle.accounts.length === 4, 'Owner accounting bundle loads journal + accounts');

  /* ===== TOOL EXECUTORS (role-gated) ===== */
  section('Tools — role exposure');
  const ownerTools = toolsForRole(true).map((t) => t.name);
  const custTools = toolsForRole(false).map((t) => t.name);
  ok(ownerTools.includes('trialBalance') && ownerTools.includes('outstandingReport'), 'Owner is offered accounting tools');
  ok(!custTools.includes('trialBalance') && !custTools.includes('outstandingReport') && !custTools.includes('searchByCompany'), 'Customer is NOT offered owner tools');
  ok(custTools.includes('findShipment') && custTools.includes('navigate') && custTools.includes('explainAccounting'), 'Customer gets shared tools');

  section('Tools — executor re-checks role even if called directly');
  // Simulate a customer somehow invoking an owner tool name → executor throws
  // AccessDenied, which index.js converts to a permission_denied result.
  await denied(() => execute('trialBalance', {}, daA, custA), 'Customer calling trialBalance executor is denied');
  await denied(() => execute('outstandingReport', {}, daA, custA), 'Customer calling outstandingReport executor is denied');
  await denied(() => execute('searchByCompany', { name: 'BuildCo' }, daA, custA), 'Customer calling searchByCompany executor is denied');

  section('Tools — findShipment scoping through executor');
  const aFind = await execute('findShipment', { identifier: 'INV-1' }, daA, custA);
  ok(aFind.found && aFind.orderId === 'EGC-1', 'Customer A finds their own shipment via tool');
  const aFindB = await execute('findShipment', { identifier: 'INV-2' }, daA, custA);
  ok(aFindB.found === false, 'Customer A gets "not found" for B\'s invoice (no leak)');
  const oFindB = await execute('findShipment', { identifier: 'INV-2' }, daO, owner);
  ok(oFindB.found && oFindB.orderId === 'EGC-2', 'Owner finds any shipment via tool');

  /* ===== ACCOUNTING NUMBERS via real engine ===== */
  section('Accounting — owner tools return real engine numbers');
  const out = await execute('outstandingReport', {}, daO, owner);
  ok(out.totalOutstanding === '₹10,000', 'Outstanding total = ₹10,000 (Acme unpaid; BuildCo settled)');
  ok(out.customers.length === 1 && /Acme/.test(out.customers[0].customer), 'Only Acme appears as a debtor');
  const tb = await execute('trialBalance', {}, daO, owner);
  ok(tb.balanced === true, 'Trial balance balances');
  const fin = await execute('financialSummary', {}, daO, owner);
  ok(fin.revenue === '₹18,000', 'Revenue = ₹18,000 (10k + 8k sales)');
  ok(fin.totalOutstanding === '₹10,000', 'Summary outstanding = ₹10,000');

  section('Accounting — customer ledger by name (owner)');
  const led = await execute('customerLedger', { name: 'Acme' }, daO, owner);
  ok(led.found && led.outstanding === '₹10,000', 'Acme ledger outstanding = ₹10,000');

  /* ===== NAVIGATION action (no data) ===== */
  section('Navigation — returns client action, no data access');
  const nav = await execute('navigate', { target: 'tracking', action: 'track_shipment', query: 'INV-1' }, daA, custA);
  ok(nav._clientAction && nav._clientAction.kind === 'navigate' && nav._clientAction.target === 'tracking', 'navigate returns a client action');

  section('Draft manual order — owner only, drafts (no write)');
  const draftO = await execute('draftManualOrder', { pickup: 'Indore', delivery: 'Mumbai', freight: 12000 }, daO, owner);
  ok(draftO._clientAction && draftO._clientAction.kind === 'draft_manual_order', 'Owner can draft a manual order (form pre-fill only)');
  await denied(() => execute('draftManualOrder', { pickup: 'X', delivery: 'Y' }, daA, custA), 'Customer cannot draft a manual order');

  /* ===== PROMPT-INJECTION RESISTANCE =====
     The LLM is untrusted: even if a customer convinces the model to CALL any
     tool with any arguments, the scoped data layer must still deny cross-account
     access. We simulate the model having been fully hijacked and calling every
     tool a customer could reach, plus owner-only tools, with adversarial args. */
  section('Prompt-injection — hijacked model still cannot leak');
  // model tricked into looking up another customer's invoice/order/LR
  ok((await execute('findShipment', { identifier: 'INV-2' }, daA, custA)).found === false, 'Injected lookup of B\'s invoice → not found (no leak)');
  ok((await execute('findShipment', { identifier: 'EGC-2' }, daA, custA)).found === false, 'Injected lookup of B\'s order → not found');
  ok((await execute('findShipment', { identifier: 'LR-2' }, daA, custA)).found === false, 'Injected lookup of B\'s LR → not found');
  // model tricked into calling owner-only tools as a customer
  await denied(() => execute('outstandingReport', { top: 999 }, daA, custA), 'Injected outstandingReport as customer → denied');
  await denied(() => execute('financialSummary', {}, daA, custA), 'Injected financialSummary as customer → denied');
  await denied(() => execute('customerLedger', { name: 'BuildCo' }, daA, custA), 'Injected customerLedger(BuildCo) as customer → denied');
  await denied(() => execute('searchByCompany', { name: '' }, daA, custA), 'Injected blank searchByCompany as customer → denied');
  await denied(() => execute('pendingQuotes', {}, daA, custA), 'Injected pendingQuotes as customer → denied');
  // myShipments must never return another customer's rows even with a huge limit
  const flood = await execute('myShipments', { limit: 9999 }, daA, custA);
  ok(flood.shipments.every((s) => s.orderId === 'EGC-1'), 'Injected huge-limit myShipments still returns only own rows');
  // navigation is harmless (no data) but cannot be aimed at owner-only screens to leak — it just opens a tab the user has
  const navAttempt = await execute('navigate', { target: 'audit' }, daA, custA);
  ok(navAttempt._clientAction && navAttempt._clientAction.kind === 'navigate', 'Navigate returns intent only (no data); owner-only tabs simply won\'t exist in customer UI');

  /* ===== INPUT EDGE CASES ===== */
  section('Edge cases — malformed / empty identifiers');
  ok((await execute('findShipment', { identifier: '' }, daA, custA)).found === false, 'Empty identifier → not found');
  ok((await execute('findShipment', { identifier: 'DROP TABLE orders;--' }, daA, custA)).found === false, 'Injection-y identifier → not found (no execution; Firestore is not SQL)');
  ok((await execute('findShipment', { identifier: 'INV-1' }, daO, owner)).found === true, 'Owner finds INV-1 normally');

  /* ===== EXPLAIN ACCOUNTING — depth levels ===== */
  section('Explain accounting — beginner / more / normal');
  const exB = await execute('explainAccounting', { topic: 'GST', level: 'beginner' }, daA, custA);
  ok(exB.level === 'beginner' && /ZERO accounting background|analogy/i.test(exB.guidance), 'Beginner level → simplest guidance (available to customer too)');
  const exM = await execute('explainAccounting', { topic: 'journal entry', level: 'more' }, daO, owner);
  ok(exM.level === 'more' && /worked|debit and credit|Dr /i.test(exM.guidance), 'More level → worked example with debit/credit lines');
  const exN = await execute('explainAccounting', { topic: 'TDS' }, daO, owner);
  ok(exN.level === 'normal' && exN.mode === 'explain', 'Default level → normal, concise');
  ok(!('_company' in exN) && /Do NOT quote specific company figures/i.test(exN.note), 'Explain never pulls company figures');

  /* ===== NEW: OPEN-RECORD + ADVISOR TOOLS ===== */
  section('Open-record — owner navigation, customer denied');
  const orInv = await execute('openRecord', { kind: 'invoice', identifier: 'INV-1' }, daO, owner);
  ok(orInv._clientAction && orInv._clientAction.recordKind === 'invoice', 'Owner openRecord(invoice) returns navigation action');
  const orOut = await execute('openRecord', { kind: 'outstanding' }, daO, owner);
  ok(orOut._clientAction && orOut._clientAction.target === 'accounting' && orOut._clientAction.page === 'outstanding', 'Owner openRecord(outstanding) deep-links accounting');
  const orLed = await execute('openRecord', { kind: 'ledger', identifier: 'Acme' }, daO, owner);
  ok(orLed._clientAction && orLed._clientAction.page === 'ledger' && orLed._clientAction.party === 'cust-acme', 'Owner openRecord(ledger,"Acme") resolves party cust-acme');
  const orNo = await execute('openRecord', { kind: 'invoice', identifier: 'INV-999' }, daO, owner);
  ok(orNo.found === false, 'Owner openRecord on missing invoice → not found, no nav');
  await denied(() => execute('openRecord', { kind: 'outstanding' }, daA, custA), 'Customer openRecord(outstanding) denied');
  await denied(() => execute('openRecord', { kind: 'ledger', identifier: 'Acme' }, daA, custA), 'Customer openRecord(ledger) denied');

  section('Advisor — analyze / health / audit / reminder');
  const ana = await execute('analyzeOutstanding', {}, daO, owner);
  ok(ana.totalOutstanding === '₹10,000' && ana.topDebtors.length >= 1, 'analyzeOutstanding returns real total + debtors');
  ok(ana.concentrationRisk && /Acme/.test(ana.concentrationRisk), 'analyzeOutstanding flags concentration on Acme');
  const bh = await execute('businessHealth', {}, daO, owner);
  ok(bh.revenue === '₹18,000' && !!bh.netMargin, 'businessHealth returns revenue + margin');
  const aud = await execute('auditAccounting', {}, daO, owner);
  ok(aud.clean === true && aud.issues.length === 0, 'auditAccounting reports clean books for balanced data');

  // Business Health Score
  const hs = await execute('healthScore', {}, daO, owner);
  ok(typeof hs.score === 'number' && hs.score >= 0 && hs.score <= 100, 'healthScore returns a 0–100 score');
  ok(['Healthy', 'Watch', 'Needs attention', 'Not enough data'].includes(hs.band), 'healthScore returns a band');
  ok(Array.isArray(hs.factors) && hs.factors.length === 3, 'healthScore breaks down into 3 transparent factors');
  ok(hs.factors.every((f) => f.points === null || (typeof f.points === 'number' && f.points <= f.outOf)), 'No factor scores above its cap (no fabricated inflation)');
  await denied(() => execute('healthScore', {}, daA, custA), 'Customer healthScore denied');
  await denied(() => execute('analyzeOutstanding', {}, daA, custA), 'Customer analyzeOutstanding denied');
  await denied(() => execute('businessHealth', {}, daA, custA), 'Customer businessHealth denied');
  await denied(() => execute('auditAccounting', {}, daA, custA), 'Customer auditAccounting denied');

  // auditAccounting detects a real fault
  const badSeed = JSON.parse(JSON.stringify(SEED));
  badSeed.journalEntries['JV-BAD'] = { entryId: 'JV-BAD', date: '2026-01-20', type: 'JOURNAL', status: 'posted', lines: [{ accountCode: '1200', debit: 100, credit: 0, party: 'cust-acme' }, { accountCode: '4000', debit: 0, credit: 90 }] };
  const daBad = new DataAccess(makeDB(badSeed), owner);
  const audBad = await execute('auditAccounting', {}, daBad, owner);
  ok(audBad.clean === false && audBad.issues.some((i) => i.type === 'unbalanced_entry'), 'auditAccounting flags an unbalanced entry');

  // draftReminder (no send)
  const rem = await execute('draftReminder', { name: 'Acme' }, daO, owner);
  ok(rem.found && /Acme/.test(rem.draft) && /10,000/.test(rem.draft), 'draftReminder drafts a reminder citing real outstanding');
  ok(!('sent' in rem), 'draftReminder does NOT send (draft only)');
  await denied(() => execute('draftReminder', { name: 'Acme' }, daA, custA), 'Customer draftReminder denied');

  // new tools are owner-only in the role exposure too
  ok(toolsForRole(true).map((t) => t.name).filter((n) => ['openRecord', 'analyzeOutstanding', 'businessHealth', 'auditAccounting', 'draftReminder'].includes(n)).length === 5, 'All 5 new advisor/open tools offered to owner');
  ok(toolsForRole(false).map((t) => t.name).every((n) => !['openRecord', 'analyzeOutstanding', 'businessHealth', 'auditAccounting', 'draftReminder'].includes(n)), 'None of the new tools are offered to customers');

  /* ===== ADAPTIVE PERSONA — flexes tone, never relaxes invariants ===== */
  section('Persona — adaptive tone + non-negotiable invariants');
  const { systemPrompt } = require('../context');
  ['owner', 'customer'].forEach((role) => {
    const p = systemPrompt(role);
    // adaptive modes present
    ok(/Casual chat/i.test(p) && /companion/i.test(p), role + ' prompt: casual-companion mode present');
    ok(/patient teacher/i.test(p) && /consultant/i.test(p) && /expert operator/i.test(p) && /mentor/i.test(p), role + ' prompt: teacher/consultant/operator/mentor modes present');
    ok(/seamless/i.test(p), role + ' prompt: seamless transitions instructed');
    // INVARIANTS hold regardless of casual tone
    ok(/Never claim human feelings|you are an AI/i.test(p), role + ' prompt: honesty-about-AI invariant present');
    ok(/NEVER FABRICATE|never invent/i.test(p) && /never an excuse to guess/i.test(p), role + ' prompt: no-fabrication invariant holds even when chatty');
    ok(/SECURITY IS ABSOLUTE|never reveal/i.test(p) && /widen/i.test(p), role + ' prompt: security invariant (rapport never widens access)');
    ok(/CONFIRMATION BEFORE ACTIONS|nothing is saved yet/i.test(p), role + ' prompt: confirm-before-actions invariant present');
  });
  // customer prompt still hard-scopes business data while allowing casual chat
  const cp = systemPrompt('customer');
  ok(/ONLY their own/i.test(cp) && /Never reveal another customer exists/i.test(cp), 'customer prompt: still hard-scopes business data');
  ok(/Casual conversation is fine/i.test(cp), 'customer prompt: casual chat allowed without data exposure');


  const { buildContents } = require('../context');
  const convo = [
    { role: 'user', text: 'Show me ACME Transport' },
    { role: 'model', text: 'ACME Transport has 3 shipments and ₹40,000 outstanding.' },
  ];
  const threaded = buildContents(convo, 'show its outstanding', { page: 'owner-dashboard' });
  ok(threaded.length === 3, 'History (2 turns) + new message threaded into 3 entries');
  ok(threaded[0].role === 'user' && /ACME/.test(threaded[0].parts[0].text), 'Earlier ACME mention preserved');
  ok(threaded[1].role === 'model', 'Model turn preserved with correct role');
  ok(/its outstanding/.test(threaded[2].parts[0].text), 'New "its" message present for referent resolution');
  ok(/context: page=/.test(threaded[2].parts[0].text), 'Page context attached as a soft hint');
  const big = []; for (let i = 0; i < 30; i++) big.push({ role: i % 2 ? 'model' : 'user', text: 'turn ' + i });
  ok(buildContents(big, 'now', {}).length <= 13, 'History window bounded (last ~12 + new message)');
  const dirty = buildContents([{ role: 'user' }, { text: 'no role' }, null, { role: 'system', text: 'x' }], 'hi', {});
  ok(dirty.length === 1 && dirty[0].parts[0].text === 'hi', 'Malformed/foreign-role history entries dropped safely');



  try { new DataAccess(db, null); ok(false, 'null auth should throw'); } catch (e) { ok(e instanceof AccessDenied, 'No auth context → AccessDenied'); }

  console.log('\n' + '='.repeat(56));
  console.log('  ORBIT AI SECURITY/TOOL RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL ORBIT AI SECURITY & TOOL CHECKS PASSED.');
}
main().catch((e) => { console.error('HARNESS ERROR:', e.stack); process.exit(2); });

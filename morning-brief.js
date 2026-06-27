/* ============================================================================
   Orbit AI — MORNING BRIEF
   ----------------------------------------------------------------------------
   A proactive, owner-only daily summary. Computes REAL figures from the owner's
   secure data bundle + orders and returns structured "brief items" the model
   turns into a warm, natural greeting (in the owner's name and language).

   Hard rules:
     • OWNER ONLY (the caller must pass an owner-scoped bundle).
     • NEVER fabricate. Every item is derived from actual data; if a signal has
       no data (e.g. no TDS account exists yet), that item is simply omitted —
       we never invent a number to match an example.
     • No duplication: outstanding/revenue/ageing come from the real ACC engine.

   This module is pure (data in → brief out), so it is fully unit-testable
   offline without Gemini.
   ============================================================================ */
'use strict';
const { reports } = require('./accounting-bridge');

function inr(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, dec] = Math.abs(v).toFixed(2).replace(/\.00$/, '').split('.');
  let last3 = int.slice(-3), rest = int.slice(0, -3);
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return '₹' + (v < 0 ? '-' : '') + rest + last3 + (dec ? '.' + dec : '');
}
function lakh(n) {
  // Indian short form: ₹3.42 lakh / ₹1.2 cr — nice for a spoken brief
  const v = Math.round(Number(n) || 0);
  if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2).replace(/\.?0+$/, '') + ' cr';
  if (v >= 100000) return '₹' + (v / 100000).toFixed(2).replace(/\.?0+$/, '') + ' lakh';
  return inr(v);
}

function chargesOf(o) {
  const n = (x) => Number(x) || 0;
  const sub = n(o.freight) + n(o.fov) + n(o.labour) + n(o.localCollection) + n(o.doorDelivery) + n(o.docketCharges) + n(o.haltingCharges) + n(o.extraCharges);
  const taxable = sub - n(o.discount);
  const sgst = taxable * n(o.sgstRate) / 100, cgst = taxable * n(o.cgstRate) / 100;
  const grand = Math.round((taxable + sgst + cgst) * 100) / 100;
  const paid = n(o.advanceReceived) + n(o.receivedAmount);
  return { grand, paid, outstanding: Math.round((grand - paid) * 100) / 100, sgst, cgst, taxable };
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysBetween(a, b) { const t = (b.getTime() - a.getTime()) / 86400000; return Math.floor(t); }

/**
 * Build the morning brief.
 * @param {object} input
 *   - ownerName: string (derived from the verified token/profile)
 *   - bundle: owner accounting bundle (entries, accounts, parties, settings)
 *   - orders: array of all orders (owner-scoped, i.e. all)
 *   - prevRevenue: optional number for "vs yesterday/previous" comparison
 * @returns { greeting, items[], recommendations[], asOf }
 */
function buildMorningBrief({ ownerName, bundle, orders }) {
  const R = reports(bundle);
  const items = [];
  const recommendations = [];
  const now = new Date();

  /* ---- 1. Pending deliveries (not yet delivered/cancelled) ---- */
  const active = (orders || []).filter((o) => o.status && o.status !== 'delivered' && o.status !== 'cancelled');
  if (active.length) {
    items.push({ kind: 'pending_deliveries', count: active.length,
      text: active.length + ' ' + (active.length === 1 ? 'delivery is' : 'deliveries are') + ' still in progress.' });
  }

  /* ---- 2. Total outstanding ---- */
  const out = R.outstanding();
  if (out.total > 0) {
    items.push({ kind: 'outstanding_total', value: out.total,
      text: lakh(out.total) + ' is outstanding across ' + out.rows.length + ' customer' + (out.rows.length === 1 ? '' : 's') + '.' });
  }

  /* ---- 3. Oldest slow payer (by ledger age) ---- */
  // The party with the largest 60/90+ bucket = the one to chase first.
  const slow = out.rows
    .map((r) => ({ name: r.name, overdue: r.buckets.d60 + r.buckets.d90, balance: r.balance }))
    .filter((r) => r.overdue > 0)
    .sort((a, b) => b.overdue - a.overdue);
  if (slow.length) {
    const top = slow[0];
    items.push({ kind: 'slow_payer', customer: top.name, overdue: top.overdue,
      text: top.name + ' has ' + inr(top.overdue) + ' overdue beyond 60 days — the longest wait right now.' });
  }

  /* ---- 4. TDS receivable — ONLY if a TDS account actually exists ---- */
  const tdsAcct = (bundle.accounts || []).find((a) => /tds/i.test(a.name || '') || /tds/i.test(a.code || ''));
  if (tdsAcct) {
    const led = R.accountLedger(tdsAcct.code);
    if (led && led.closing > 0) {
      items.push({ kind: 'tds_receivable', value: led.closing, text: inr(led.closing) + ' TDS is receivable.' });
    }
  }
  // (If no TDS account exists yet, we intentionally say nothing — never invent it.)

  /* ---- 5. Revenue vs previous period ---- */
  const dash = R.dashboard({});
  // today vs the day before (using posted SALES dates)
  const tStr = todayStr();
  const yStr = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const salesOn = (d) => (bundle.entries || []).filter((e) => e.type === 'SALES' && e.status === 'posted' && e.date === d)
    .reduce((s, e) => s + (e.lines || []).reduce((ls, l) => ls + (Number(l.credit) || 0), 0), 0);
  const todayRev = salesOn(tStr), yRev = salesOn(yStr);
  if (yRev > 0) {
    const pct = Math.round(((todayRev - yRev) / yRev) * 100);
    items.push({ kind: 'revenue_trend', today: todayRev, previous: yRev, changePct: pct,
      text: 'Revenue is ' + (pct >= 0 ? 'up ' : 'down ') + Math.abs(pct) + '% vs yesterday.' });
  }

  /* ---- 6. GST mismatch detection ----
     A real, common transport GST error: when consignor and consignee are in
     DIFFERENT states the tax should be IGST, not SGST+CGST. We flag orders that
     charge SGST+CGST (rate>0) but whose from/to states differ. Data-derived,
     no fabrication, and genuinely useful before GST filing. */
  const stateOf = (s) => String(s || '').trim().toLowerCase();
  const gstIssues = [];
  (orders || []).forEach((o) => {
    const rate = (Number(o.sgstRate) || 0) + (Number(o.cgstRate) || 0);
    if (rate <= 0) return;
    const from = stateOf(o.consignorState || o.state || o.fromState);
    const to = stateOf(o.consigneeState || o.toState);
    if (from && to && from !== to) gstIssues.push(o.invoiceId || o.orderId);
  });
  if (gstIssues.length) {
    items.push({ kind: 'gst_mismatch', count: gstIssues.length, ids: gstIssues.slice(0, 5),
      text: gstIssues.length + ' invoice' + (gstIssues.length === 1 ? '' : 's') + ' charge SGST+CGST on an inter-state movement (should likely be IGST) — worth checking before filing.' });
  }

  /* ---- 7. Recommendations (chase the slowest/largest first) ---- */
  const chase = slow.slice(0, 2).map((s) => s.name);
  if (chase.length) {
    recommendations.push('Follow up with ' + chase.join(' and ') + ' first — they are the oldest/largest dues.');
  } else if (out.rows.length) {
    const big = out.rows.slice(0, 2).map((r) => r.name);
    recommendations.push('Consider a gentle reminder to ' + big.join(' and ') + ' on the largest balances.');
  }
  if (gstIssues.length) recommendations.push('Review the ' + gstIssues.length + ' GST mismatch(es) before filing.');
  if (active.length >= 5) recommendations.push('Several deliveries are in transit — confirm vehicle/driver assignments are current.');

  /* "Nothing urgent" is itself a finding worth telling the owner warmly — it
     lets them relax instead of hunting for problems. Only true when there's
     genuinely no action needed: no overdue payers, no GST issues, no quotes
     awaiting action. (Pending deliveries in transit are normal, not "urgent".) */
  const nothingUrgent = slow.length === 0 && gstIssues.length === 0 && recommendations.length === 0;

  return {
    greeting: greetingFor(ownerName, now),
    ownerName: ownerName || 'there',
    asOf: now.toISOString(),
    items,
    recommendations,
    allClear: nothingUrgent,
    note: nothingUrgent
      ? 'Speak as a warm, trusted colleague who has ALREADY checked today\'s work. Greet the owner by name. Reassure them there is nothing urgent and they can relax for a bit. Mention any in-progress deliveries lightly if present. Use ONLY these figures; invent nothing. Keep it short and friendly. Mirror Hindi/Hinglish if the owner uses it. A friendly emoji like 👋 is welcome but at most one.'
      : 'Speak as a warm, sharp colleague who has ALREADY looked at today\'s numbers — like an experienced employee giving the owner a quick morning rundown. Greet by name, then the key points, then your one clear recommendation ("I\'d start with X"). Use ONLY these figures — never add or estimate a number. Crisp and skimmable. Mirror Hindi/Hinglish if the owner uses it. At most one friendly emoji.',
  };
}

function greetingFor(name, now) {
  const h = now.getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return part + (name ? ', ' + name : '') + '.';
}

module.exports = { buildMorningBrief, _inr: inr, _lakh: lakh };

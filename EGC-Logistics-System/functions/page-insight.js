/* ============================================================================
   Orbit AI — PAGE INSIGHT (proactive, context-aware)
   ----------------------------------------------------------------------------
   When the user lands on a screen, Orbit AI can offer ONE short, relevant,
   data-derived line WITHOUT being asked — like an experienced employee glancing
   at the same screen and saying the one thing worth saying.

   Hard rules (same as everywhere):
     • OWNER insights use owner-scoped data; CUSTOMER insights use only their own.
     • NEVER fabricate. Every line is computed from real data passed in. If there
       is nothing genuinely useful to say, return null (AI stays quiet — silence
       is better than noise or invention).
     • No state changes. Insights may SUGGEST an action (e.g. "draft a reminder?")
       but never perform one.

   Pure functions (data in → insight out), unit-testable offline.
   ============================================================================ */
'use strict';

function inr(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, dec] = Math.abs(v).toFixed(2).replace(/\.00$/, '').split('.');
  let last3 = int.slice(-3), rest = int.slice(0, -3);
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return '₹' + (v < 0 ? '-' : '') + rest + last3 + (dec ? '.' + dec : '');
}
function lakh(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2).replace(/\.?0+$/, '') + ' cr';
  if (v >= 100000) return '₹' + (v / 100000).toFixed(2).replace(/\.?0+$/, '') + ' lakh';
  return inr(v);
}

/* ---------- OWNER insights ----------
   reportsApi: the object returned by accounting-bridge.reports(bundle)
   ctx: { page, hash, selectedId, selectedName }
   Returns { text, suggest?: {label, message} } or null. */
function ownerInsight(reportsApi, ctx, extra) {
  ctx = ctx || {};
  const page = ctx.page || '';
  const hash = ctx.hash || '';
  extra = extra || {};

  // Accounting → Outstanding: who to chase
  if (page === 'accounting' && hash === 'outstanding') {
    const out = reportsApi.outstanding();
    if (!out.total) return { text: 'Nothing outstanding right now — every customer is settled. 👍' };
    const worst = out.rows.map((r) => ({ name: r.name, overdue: r.buckets.d60 + r.buckets.d90, bal: r.balance }))
      .filter((r) => r.overdue > 0).sort((a, b) => b.overdue - a.overdue)[0];
    let text = 'You have ' + lakh(out.total) + ' outstanding across ' + out.rows.length + ' customer' + (out.rows.length === 1 ? '' : 's') + '.';
    if (worst) {
      text += ' ' + worst.name + ' has ' + inr(worst.overdue) + ' overdue beyond 60 days — I\'d follow up with them first.';
      return { text, suggest: { label: 'Draft a reminder for ' + worst.name, message: 'Draft a payment reminder for ' + worst.name } };
    }
    return { text };
  }

  // Accounting → Trial Balance: balanced or not
  if (page === 'accounting' && hash === 'trial') {
    const tb = reportsApi.trialBalance();
    if (tb.balanced) return { text: 'Everything is balanced — total debits equal total credits. No accounting issues detected.' };
    return { text: 'Heads up: the trial balance is off by ' + inr(Math.abs(tb.totalDebit - tb.totalCredit)) + '. I can help you find the entry causing it.',
      suggest: { label: 'Find the problem entry', message: 'Audit my accounting and find unbalanced entries' } };
  }

  // Accounting → P&L: quick profitability read
  if (page === 'accounting' && hash === 'pl') {
    const d = reportsApi.dashboard({});
    if (!d.revenue) return null;
    const margin = Math.round((d.netProfit / d.revenue) * 100);
    return { text: 'This period: ' + lakh(d.revenue) + ' revenue, ' + lakh(d.netProfit) + ' net profit (' + margin + '% margin).' };
  }

  // Accounting → a specific customer ledger
  if (page === 'accounting' && hash === 'ledger' && ctx.selectedName) {
    return { text: 'Showing ' + ctx.selectedName + '\u2019s statement. Ask me "is this customer slow-paying?" if you want a quick read.' };
  }

  // Owner dashboard → Invoices, with a specific invoice selected
  if (page === 'owner-dashboard' && extra.invoiceCustomer && extra.customerLatePayer) {
    return { text: extra.invoiceCustomer + ' has tended to pay late.',
      suggest: { label: 'Draft a reminder', message: 'Draft a payment reminder for ' + extra.invoiceCustomer } };
  }

  // Owner just recorded a diesel/expense spike (computed upstream)
  if (extra.expenseSpike) {
    return { text: extra.expenseSpike.label + ' are ' + extra.expenseSpike.pct + '% ' + (extra.expenseSpike.pct >= 0 ? 'higher' : 'lower') + ' than last month.' };
  }

  return null;
}

/* ---------- CUSTOMER insights ----------
   shipment: the customer's most-recent active order projection (or null)
   Returns { text, suggest? } or null. */
function customerInsight(shipment, ctx) {
  ctx = ctx || {};
  if (!shipment) {
    return { text: 'Welcome back 👋 You don\'t have an active shipment right now. Whenever you\'re ready to send something, just submit a quote request and I\'ll track it for you.', stateKey: 'none' };
  }
  const route = (shipment.pickup || '?') + ' → ' + (shipment.delivery || '?');
  const statusLine = {
    approved: 'Your shipment is confirmed and being prepared.',
    truck_assigned: 'A truck has been assigned and will pick up your goods soon.',
    in_transit: 'Your shipment has left ' + (shipment.pickup || 'the origin') + ' and is on its way.',
    delivered: 'Good news — your shipment has been delivered. 🎉',
  }[shipment.status] || 'Your shipment is being processed.';

  // A compact signature of what the customer is being told. If it's identical
  // to last visit, the client says "no changes since your last visit" instead.
  const stateKey = [shipment.orderId || shipment.invoiceId || '', shipment.status || '', shipment.estimatedDelivery || ''].join('|');

  let text = 'Welcome back 👋  ' + statusLine;
  if (shipment.status !== 'delivered' && shipment.estimatedDelivery) {
    text += ' Expected delivery: ' + shipment.estimatedDelivery + '. Looks like everything is on schedule.';
  }
  text += '\n(' + route + ')';
  const suggest = { label: 'Download Invoice or LR', message: 'Download my invoice and LR for this shipment' };
  if (shipment.status === 'delivered') return { text, suggest, stateKey };
  return { text: text + '\nNeed your invoice or LR?', suggest, stateKey };
}

module.exports = { ownerInsight, customerInsight, _inr: inr, _lakh: lakh };

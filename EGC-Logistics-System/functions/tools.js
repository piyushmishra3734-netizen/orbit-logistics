/* ============================================================================
   Orbit AI — TOOLS
   ----------------------------------------------------------------------------
   The bridge between Gemini's function-calling and Orbit's data. Two things
   matter here:

   1. SECURITY: every data tool runs through the DataAccess layer, which is
      already bound to the verified user. A customer's tools physically cannot
      touch another customer's records. Owner-only tools throw for customers.

   2. NO DUPLICATION: accounting answers come from the real ACC.report* engine
      via accounting-bridge; we never recompute money here.

   Tools are split by role so the model is only ever OFFERED tools the user is
   allowed to use — and even if a model ignored that, the executor re-checks.
   ============================================================================ */
'use strict';
const { reports } = require('./accounting-bridge');
const { AccessDenied } = require('./data-access');

/* ---- money / formatting helpers (display only) ---- */
function inr(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Math.abs(v).toFixed(2).replace(/\.00$/, '');
  // Indian grouping
  const [int, dec] = s.split('.');
  let last3 = int.slice(-3), rest = int.slice(0, -3);
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return '₹' + (v < 0 ? '-' : '') + rest + last3 + (dec ? '.' + dec : '');
}
function chargesOf(order) {
  // freight + accessorials − discount + gst; mirrors SHIP.computeCharges fields
  const n = (x) => Number(x) || 0;
  const sub = n(order.freight) + n(order.fov) + n(order.labour) + n(order.localCollection) +
    n(order.doorDelivery) + n(order.docketCharges) + n(order.haltingCharges) + n(order.extraCharges);
  const afterDisc = sub - n(order.discount);
  const gst = afterDisc * (n(order.sgstRate) + n(order.cgstRate)) / 100;
  const grand = Math.round((afterDisc + gst) * 100) / 100;
  const paid = n(order.advanceReceived) + n(order.receivedAmount);
  return { grand, paid, outstanding: Math.round((grand - paid) * 100) / 100 };
}

/* ============================================================ TOOL SCHEMAS
   Gemini function-calling declarations. Kept minimal + explicit. */
const SCHEMAS = {
  // ---- shared (owner + customer, but customer auto-scoped) ----
  navigate: {
    name: 'navigate',
    description: 'Open a specific screen/tab in the app for the user. Use when the user wants to GO somewhere or you want to guide them to the right module.',
    parameters: { type: 'object', properties: {
      target: { type: 'string', description: 'Tab/screen id. Owner: orders, pending, allquotes, invoices, lr, audit, routes, profile. Customer: shipment, orders, tracking, invoices, notifications, activity, profile, support.' },
      action: { type: 'string', description: 'Optional special action: open_manual_order (owner) | track_shipment (customer).' },
      query: { type: 'string', description: 'Optional value for the action, e.g. an invoice/LR number to track.' },
    }, required: ['target'] },
  },
  findShipment: {
    name: 'findShipment',
    description: 'Look up one shipment by Invoice number, LR number, or Order id and return its status, route, payment and transport. Customer sees only their own.',
    parameters: { type: 'object', properties: {
      identifier: { type: 'string', description: 'Invoice number (INV-...), LR number (LR-...), or Order id (EGC-...).' },
    }, required: ['identifier'] },
  },
  myShipments: {
    name: 'myShipments',
    description: 'List recent shipments/orders for the current user (customer: their own; owner: most recent overall).',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max rows (default 10).' } } },
  },
  explainAccounting: {
    name: 'explainAccounting',
    description: 'Explain an accounting concept in plain language (GST, TDS, double-entry, debit/credit, why a Trial Balance must balance, what a journal entry means, P&L vs Balance Sheet, freight charges). This is GENERAL KNOWLEDGE — it returns guidance, not company numbers. Always ground the explanation in a REAL transport business example (e.g. an EGC freight invoice). Use the requested depth level.',
    parameters: { type: 'object', properties: {
      topic: { type: 'string' },
      level: { type: 'string', description: 'normal (default) | more (deeper, with a worked example) | beginner (assume zero accounting background, very simple words, one everyday analogy).' },
    }, required: ['topic'] },
  },

  // ---- owner only ----
  outstandingReport: {
    name: 'outstandingReport',
    description: 'OWNER ONLY. Customers ranked by outstanding receivable, with ageing buckets. Use for "who owes the most", "unpaid customers", "overdue".',
    parameters: { type: 'object', properties: { top: { type: 'number', description: 'Limit to top N (optional).' } } },
  },
  financialSummary: {
    name: 'financialSummary',
    description: 'OWNER ONLY. Revenue, expenses, net profit, cash+bank, total outstanding and top debtors for a period. Use for "revenue this month", "how are we doing".',
    parameters: { type: 'object', properties: {
      from: { type: 'string', description: 'YYYY-MM-DD inclusive (optional).' },
      to: { type: 'string', description: 'YYYY-MM-DD inclusive (optional).' },
    } },
  },
  trialBalance: {
    name: 'trialBalance',
    description: 'OWNER ONLY. The Trial Balance (every account Dr/Cr) and whether it balances. Use for "why doesn\'t the trial balance match", "show trial balance".',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
  },
  customerLedger: {
    name: 'customerLedger',
    description: 'OWNER ONLY. A single customer\'s statement (all sales + receipts + adjustments) and closing balance, found by company/customer name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  searchByCompany: {
    name: 'searchByCompany',
    description: 'OWNER ONLY. Find all shipments for a company/customer by name (matches consignor, consignee or customer).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  pendingQuotes: {
    name: 'pendingQuotes',
    description: 'OWNER ONLY. List quotes awaiting owner action (pending review / awaiting customer).',
    parameters: { type: 'object', properties: {} },
  },
  draftManualOrder: {
    name: 'draftManualOrder',
    description: 'OWNER ONLY. Prepare (DRAFT, not submit) a manual order from details given over the phone. Returns a structured draft and opens the Manual Order form pre-filled. The owner still reviews and clicks Create. If required details are missing, say which ones are still needed rather than inventing them.',
    parameters: { type: 'object', properties: {
      shipmentType: { type: 'string', description: 'commercial | personal' },
      companyName: { type: 'string' }, consigneeName: { type: 'string' },
      pickup: { type: 'string' }, delivery: { type: 'string' },
      materialType: { type: 'string' }, weight: { type: 'string' },
      freight: { type: 'number' },
    }, required: ['pickup', 'delivery'] },
  },

  // ---- OPEN a specific record (owner; deep-link/navigation, no data leak) ----
  openRecord: {
    name: 'openRecord',
    description: 'OWNER ONLY. Open a specific record on screen: an invoice, LR, order (Manage Shipment), a customer ledger, the outstanding report, or an accounting page. Use when the user says "open invoice INV-…", "open ACME\'s ledger", "open outstanding", "show the trial balance", etc. This navigates the UI; it does not change data.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', description: 'invoice | lr | order | ledger | outstanding | trialbalance | pl | balancesheet | accounting' },
      identifier: { type: 'string', description: 'For invoice/lr/order: the number/id. For ledger: the customer/company name.' },
    }, required: ['kind'] },
  },

  // ---- BUSINESS ADVISOR (owner; analysis over already-fetched secure data) ----
  analyzeOutstanding: {
    name: 'analyzeOutstanding',
    description: 'OWNER ONLY. Analyse receivables: who owes most, who is slow-paying (ageing into 60/90+ buckets), concentration risk, and suggest follow-up priorities. Returns structured analysis you turn into advice.',
    parameters: { type: 'object', properties: {} },
  },
  businessHealth: {
    name: 'businessHealth',
    description: 'OWNER ONLY. A health read on the business: revenue, expenses, net profit, cash+bank position, total outstanding, sales volume, and top debtors — with the raw figures you can interpret as trends/cash-flow commentary. Optionally for a date range.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
  },
  healthScore: {
    name: 'healthScore',
    description: 'OWNER ONLY. A single 0–100 Business Health Score with the factors behind it (profit margin, cash vs receivables, overdue ratio, collection health). Use when the owner asks "how healthy is my business" or "give me a health score". Every factor is computed from real data; if a factor cannot be computed it is marked as not-tracked rather than guessed.',
    parameters: { type: 'object', properties: {} },
  },
  auditAccounting: {
    name: 'auditAccounting',
    description: 'OWNER ONLY. Sanity-check the books for mistakes: unbalanced trial balance, unbalanced/void journal entries, negative outstanding (over-collection), and orders whose payments exceed their invoice. Returns any anomalies found so you can explain and suggest fixes. If none, report the books look consistent.',
    parameters: { type: 'object', properties: {} },
  },
  draftReminder: {
    name: 'draftReminder',
    description: 'OWNER ONLY. Draft (do NOT send) a polite payment-reminder message for a specific customer, based on their real outstanding. Returns the draft text for the owner to review/copy. Sending is a future capability.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Customer/company name.' },
      channel: { type: 'string', description: 'whatsapp | email | sms (formatting hint only; nothing is sent).' },
    }, required: ['name'] },
  },
};

/* Which tools each role is offered. */
const SHARED = ['navigate', 'findShipment', 'myShipments', 'explainAccounting'];
const OWNER_ONLY = ['outstandingReport', 'financialSummary', 'trialBalance', 'customerLedger', 'searchByCompany', 'pendingQuotes', 'draftManualOrder', 'openRecord', 'analyzeOutstanding', 'businessHealth', 'healthScore', 'auditAccounting', 'draftReminder'];

function toolsForRole(isOwner) {
  const names = isOwner ? SHARED.concat(OWNER_ONLY) : SHARED;
  return names.map((n) => SCHEMAS[n]);
}

/* ============================================================ EXECUTORS
   Each returns a small JSON-serialisable result the model turns into prose.
   `da` is the per-request DataAccess (already scoped). `ctx` carries auth. */
async function execute(name, args, da, ctx) {
  args = args || {};
  const ownerGate = () => { if (!ctx.isOwner) throw new AccessDenied('That information is only available to the owner.'); };

  switch (name) {
    /* ---- navigation: pure UI intent, returned to the client to perform ---- */
    case 'navigate':
      return { _clientAction: { kind: 'navigate', target: args.target, action: args.action || null, query: args.query || null } };

    /* ---- single shipment ---- */
    case 'findShipment': {
      const id = String(args.identifier || '').trim();
      let inv = null, order = null, lr = null;
      if (/^LR/i.test(id)) { lr = await da.findByLr(id); if (lr) { order = await da.getOrder(lr.orderId); inv = lr.invoiceId ? await da.findInvoice(lr.invoiceId) : null; } }
      else if (/^EGC/i.test(id)) { order = await da.getOrder(id); }
      else { inv = await da.findInvoice(id); if (inv) order = await da.getOrder(inv.orderId); }
      if (!order && inv) order = await da.getOrder(inv.orderId);
      if (!order && !inv && !lr) return { found: false, message: 'No shipment matches "' + id + '" in your records.' };
      const o = order || {};
      const c = chargesOf(o);
      return {
        found: true,
        orderId: o.orderId || (inv && inv.orderId) || null,
        invoiceNumber: (inv && (inv.invoiceNumber || inv.invoiceId)) || o.invoiceId || null,
        lrNumber: (lr && lr.lrNumber) || o.lrNumber || null,
        status: o.status || null,
        route: (o.pickup || '?') + ' → ' + (o.delivery || '?'),
        company: o.companyName || o.customerName || null,
        consignee: o.consigneeName || null,
        vehicle: o.vehicleNumber || null,
        driver: o.driverName || null,
        estimatedDelivery: o.estimatedDelivery || null,
        grandTotal: inr(c.grand), paid: inr(c.paid), outstanding: inr(c.outstanding),
        paymentStatus: o.paymentStatus || null,
      };
    }

    /* ---- list of own/recent shipments ---- */
    case 'myShipments': {
      const limit = Math.min(Number(args.limit) || 10, 50);
      const rows = await da.myOrders(limit);
      return { count: rows.length, shipments: rows.map((o) => ({
        orderId: o.orderId, route: (o.pickup || '?') + ' → ' + (o.delivery || '?'),
        status: o.status, company: o.companyName || o.customerName,
        outstanding: inr(chargesOf(o).outstanding), paymentStatus: o.paymentStatus,
      })) };
    }

    /* ---- plain-language accounting explainer (no company data) ---- */
    case 'explainAccounting': {
      const level = String(args.level || 'normal').toLowerCase();
      const guidance = {
        beginner: 'Assume the reader has ZERO accounting background. Use very simple words, short sentences, and ONE everyday analogy (e.g. a household or shopkeeper example). Then connect it to one concrete transport example (an EGC freight bill). Avoid jargon; if you must use a term, define it in brackets.',
        more: 'Give a deeper explanation with a fully worked transport example showing the actual debit and credit lines (e.g. "Dr Customer ₹11,800 / Cr Freight Income ₹10,000 / Cr GST ₹1,800"). Explain WHY each line is debited or credited. Still keep it readable for a non-accountant.',
        normal: 'Explain clearly and concisely in plain language, grounded in one short transport business example. A few sentences.',
      }[level] || 'Explain clearly and concisely in plain language with a transport example.';
      return { topic: args.topic || '', level, mode: 'explain', guidance,
        note: 'Answer from general accounting knowledge for an Indian road-transport business. Do NOT quote specific company figures unless another tool provided them.' };
    }

    /* ---- OWNER: outstanding ---- */
    case 'outstandingReport': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const out = reports(bundle).outstanding();
      let rows = out.rows.map((r) => ({ customer: r.name, outstanding: inr(r.balance),
        current: inr(r.buckets.cur), d30: inr(r.buckets.d30), d60: inr(r.buckets.d60), d90plus: inr(r.buckets.d90) }));
      if (args.top) rows = rows.slice(0, Number(args.top));
      return { totalOutstanding: inr(out.total), customers: rows };
    }

    /* ---- OWNER: financial summary ---- */
    case 'financialSummary': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const d = reports(bundle).dashboard({ from: args.from, to: args.to });
      return {
        period: { from: args.from || 'all time', to: args.to || 'today' },
        revenue: inr(d.revenue), expenses: inr(d.expenses), netProfit: inr(d.netProfit),
        cashAndBank: inr(d.cashBank), totalOutstanding: inr(d.outstanding),
        salesCount: d.salesCount, salesTotal: inr(d.salesTotal),
        topDebtors: d.topDebtors.map((r) => ({ customer: r.name, outstanding: inr(r.balance) })),
      };
    }

    /* ---- OWNER: trial balance ---- */
    case 'trialBalance': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const tb = reports(bundle).trialBalance({ from: args.from, to: args.to });
      return {
        balanced: tb.balanced, totalDebit: inr(tb.totalDebit), totalCredit: inr(tb.totalCredit),
        accounts: tb.rows.map((r) => ({ account: r.name, debit: r.debit ? inr(r.debit) : '', credit: r.credit ? inr(r.credit) : '' })),
        note: tb.balanced ? 'The trial balance is balanced (total debits equal total credits).'
          : 'The trial balance does NOT balance — this indicates a data issue; every posted entry should be balanced by construction.',
      };
    }

    /* ---- OWNER: customer ledger by name ---- */
    case 'customerLedger': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const term = String(args.name || '').toLowerCase().trim();
      const party = (bundle.parties || []).find((p) => String(p.name || '').toLowerCase().includes(term) && p.kind === 'customer');
      if (!party) return { found: false, message: 'No customer ledger matches "' + args.name + '".' };
      const led = reports(bundle).partyLedger(party.partyId);
      return { found: true, customer: party.name, closingBalance: inr(led.closing), side: led.closingSide,
        outstanding: inr(led.outstanding),
        entries: led.rows.slice(-20).map((r) => ({ date: r.date, type: r.type, narration: r.narration,
          debit: r.debit ? inr(r.debit) : '', credit: r.credit ? inr(r.credit) : '', balance: inr(r.balance) + ' ' + r.balanceSide })) };
    }

    /* ---- OWNER: shipments by company ---- */
    case 'searchByCompany': {
      ownerGate();
      const rows = await da.ordersForCustomerName(args.name);
      return { count: rows.length, company: args.name, shipments: rows.slice(0, 50).map((o) => ({
        orderId: o.orderId, route: (o.pickup || '?') + ' → ' + (o.delivery || '?'), status: o.status,
        invoiceNumber: o.invoiceId, outstanding: inr(chargesOf(o).outstanding), paymentStatus: o.paymentStatus })) };
    }

    /* ---- OWNER: pending quotes ---- */
    case 'pendingQuotes': {
      ownerGate();
      const all = await da.list('quotes', { limit: 200 });
      const pending = all.filter((q) => ['pending_review', 'revised_by_owner', 'customer_accepted'].includes(q.status));
      return { count: pending.length, quotes: pending.map((q) => ({ quoteId: q.quoteId, company: q.companyName || q.customerName,
        route: (q.pickup || '?') + ' → ' + (q.delivery || '?'), status: q.status })) };
    }

    /* ---- OWNER: draft a manual order (does NOT create it) ---- */
    case 'draftManualOrder': {
      ownerGate();
      return { _clientAction: { kind: 'draft_manual_order', draft: {
        shipmentType: args.shipmentType || 'commercial',
        companyName: args.companyName || '', consigneeName: args.consigneeName || '',
        pickup: args.pickup || '', delivery: args.delivery || '',
        materialType: args.materialType || '', weight: args.weight || '',
        freight: args.freight || '',
      } }, note: 'Opened the Manual Order form pre-filled. Review the details and click Create Order to confirm — nothing has been saved yet.' };
    }

    /* ---- OWNER: open a specific record (navigation deep-link) ---- */
    case 'openRecord': {
      ownerGate();
      const kind = String(args.kind || '').toLowerCase();
      const idf = String(args.identifier || '').trim();
      // For ledger we resolve the party id from the name (owner data).
      if (kind === 'ledger') {
        const bundle = await da.accountingBundle();
        const term = idf.toLowerCase();
        const party = (bundle.parties || []).find((p) => p.kind === 'customer' && String(p.name || '').toLowerCase().includes(term));
        if (!party) return { found: false, message: 'No customer ledger matches "' + idf + '".' };
        return { _clientAction: { kind: 'open_record', recordKind: 'ledger', target: 'accounting', page: 'ledger', party: party.partyId, label: party.name }, note: 'Opening ' + party.name + '\u2019s ledger.' };
      }
      const PAGE = { outstanding: 'outstanding', trialbalance: 'trial', pl: 'pl', balancesheet: 'balance', accounting: 'dashboard' };
      if (PAGE[kind]) return { _clientAction: { kind: 'open_record', recordKind: kind, target: 'accounting', page: PAGE[kind] }, note: 'Opening the ' + kind + ' view.' };
      if (kind === 'invoice' || kind === 'lr' || kind === 'order') {
        if (!idf) return { found: false, message: 'Tell me which ' + kind + ' to open (a number/id).' };
        // verify it exists & is readable before navigating (no leak; owner anyway)
        let exists = false;
        if (kind === 'invoice') exists = !!(await da.findInvoice(idf));
        else if (kind === 'lr') exists = !!(await da.findByLr(idf));
        else exists = !!(await da.getOrder(idf));
        if (!exists) return { found: false, message: 'I couldn\u2019t find ' + kind + ' "' + idf + '".' };
        return { _clientAction: { kind: 'open_record', recordKind: kind, identifier: idf }, note: 'Opening ' + kind + ' ' + idf + '.' };
      }
      return { error: 'Unknown record kind: ' + kind };
    }

    /* ---- OWNER: analyse outstanding (advisor) ---- */
    case 'analyzeOutstanding': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const out = reports(bundle).outstanding();
      const rows = out.rows;
      const total = out.total;
      const slow = rows.filter((r) => (r.buckets.d60 + r.buckets.d90) > 0)
        .map((r) => ({ customer: r.name, overdue60plus: inr(r.buckets.d60 + r.buckets.d90), total: inr(r.balance) }));
      const top = rows.slice(0, 5).map((r) => ({ customer: r.name, outstanding: inr(r.balance),
        share: total ? Math.round((r.balance / total) * 100) + '%' : '0%' }));
      const concentration = rows.length && total ? Math.round((rows[0].balance / total) * 100) : 0;
      return {
        totalOutstanding: inr(total), customerCount: rows.length,
        topDebtors: top, slowPayers: slow,
        concentrationRisk: concentration + '% of receivables sit with one customer (' + (rows[0] ? rows[0].name : 'n/a') + ')',
        note: 'Interpret this as a senior accountant: flag slow payers (60/90+ days) for priority follow-up, note any concentration risk, and suggest concrete next steps (reminder, call, hold further credit). Do not invent figures beyond these.',
      };
    }

    /* ---- OWNER: business health (advisor) ---- */
    case 'businessHealth': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const d = reports(bundle).dashboard({ from: args.from, to: args.to });
      const margin = d.revenue ? Math.round((d.netProfit / d.revenue) * 100) : 0;
      return {
        period: { from: args.from || 'all time', to: args.to || 'today' },
        revenue: inr(d.revenue), expenses: inr(d.expenses), netProfit: inr(d.netProfit), netMargin: margin + '%',
        cashAndBank: inr(d.cashBank), totalOutstanding: inr(d.outstanding),
        salesCount: d.salesCount, salesTotal: inr(d.salesTotal),
        topDebtors: d.topDebtors.map((r) => ({ customer: r.name, outstanding: inr(r.balance) })),
        note: 'Interpret as a business advisor: comment on profitability (margin), cash position (cash+bank vs outstanding), and whether receivables are tying up cash. Keep it practical and specific to a road-transport business. Only use the figures provided.',
      };
    }

    /* ---- OWNER: business health score (0–100, transparent factors) ---- */
    case 'healthScore': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const R = reports(bundle);
      const d = R.dashboard({});
      const out = R.outstanding();
      const factors = [];
      let score = 0, maxScore = 0;

      // Factor 1: Profit margin (0–35). >15% excellent, <0 poor.
      if (d.revenue > 0) {
        const margin = d.netProfit / d.revenue;
        const f = Math.max(0, Math.min(35, Math.round((margin / 0.15) * 35)));
        factors.push({ factor: 'Profit margin', detail: Math.round(margin * 100) + '% net margin', points: f, outOf: 35 });
        score += f; maxScore += 35;
      } else {
        factors.push({ factor: 'Profit margin', detail: 'No revenue recorded yet', points: null, outOf: 35, notTracked: true });
      }

      // Factor 2: Cash vs receivables (0–30). Healthy if cash covers a good share.
      const receivable = out.total;
      if (d.cashBank > 0 || receivable > 0) {
        const ratio = receivable > 0 ? d.cashBank / receivable : 1;
        const f = Math.max(0, Math.min(30, Math.round(Math.min(ratio, 1) * 30)));
        factors.push({ factor: 'Cash vs receivables', detail: inr(d.cashBank) + ' cash against ' + inr(receivable) + ' owed to you', points: f, outOf: 30 });
        score += f; maxScore += 30;
      } else {
        factors.push({ factor: 'Cash vs receivables', detail: 'No cash/receivable data yet', points: null, outOf: 30, notTracked: true });
      }

      // Factor 3: Overdue ratio (0–35). Less overdue = healthier.
      if (receivable > 0) {
        const overdue = out.rows.reduce((s, r) => s + r.buckets.d60 + r.buckets.d90, 0);
        const overdueRatio = overdue / receivable;
        const f = Math.max(0, Math.min(35, Math.round((1 - overdueRatio) * 35)));
        factors.push({ factor: 'Collection health', detail: Math.round(overdueRatio * 100) + '% of dues are 60+ days overdue', points: f, outOf: 35 });
        score += f; maxScore += 35;
      } else {
        factors.push({ factor: 'Collection health', detail: 'Nothing outstanding — all collected', points: 35, outOf: 35 });
        score += 35; maxScore += 35;
      }

      const finalScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : null;
      const band = finalScore == null ? 'Not enough data'
        : finalScore >= 75 ? 'Healthy' : finalScore >= 50 ? 'Watch' : 'Needs attention';
      return {
        score: finalScore, band, factors,
        note: finalScore == null
          ? 'Not enough data yet to score the business; tell the owner what is missing.'
          : 'Present the score (0–100) and band, then explain the 1–2 factors dragging it down and a concrete next step. Use ONLY these computed factors; never invent a number. Factors marked notTracked are simply not in the ERP yet — say so plainly.',
      };
    }

    /* ---- OWNER: audit the books for mistakes (advisor) ---- */
    case 'auditAccounting': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const R = reports(bundle);
      const tb = R.trialBalance();
      const out = R.outstanding();
      const issues = [];
      if (!tb.balanced) issues.push({ type: 'trial_balance_unbalanced', detail: 'Trial balance is off: debits ' + inr(tb.totalDebit) + ' vs credits ' + inr(tb.totalCredit) + '.' });
      (bundle.entries || []).forEach((e) => {
        if (e.status === 'void') return;
        const dr = (e.lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
        const cr = (e.lines || []).reduce((s, l) => s + (Number(l.credit) || 0), 0);
        if (Math.round((dr - cr) * 100) !== 0) issues.push({ type: 'unbalanced_entry', detail: 'Entry ' + e.entryId + ' is unbalanced (' + inr(dr) + ' vs ' + inr(cr) + ').' });
      });
      out.rows.forEach((r) => { if (r.balance < -0.01) issues.push({ type: 'negative_outstanding', detail: r.name + ' shows a negative receivable (' + inr(r.balance) + ') — likely an over-collection or mis-posted receipt.' }); });
      return {
        checked: { trialBalance: true, entryBalance: (bundle.entries || []).length, outstanding: out.rows.length },
        issues,
        clean: issues.length === 0,
        note: issues.length ? 'Explain each issue plainly and suggest how to correct it (e.g. void + repost, or a contra/adjustment).' : 'Report that the books look internally consistent (trial balance balances, entries balanced, no negative receivables).',
      };
    }

    /* ---- OWNER: draft a payment reminder (no send) ---- */
    case 'draftReminder': {
      ownerGate();
      const bundle = await da.accountingBundle();
      const term = String(args.name || '').toLowerCase().trim();
      const party = (bundle.parties || []).find((p) => p.kind === 'customer' && String(p.name || '').toLowerCase().includes(term));
      if (!party) return { found: false, message: 'No customer matches "' + args.name + '".' };
      const led = reports(bundle).partyLedger(party.partyId);
      if (led.outstanding <= 0) return { found: true, customer: party.name, outstanding: inr(led.outstanding), message: party.name + ' has no outstanding balance — no reminder needed.' };
      return {
        found: true, customer: party.name, outstanding: inr(led.outstanding), channel: args.channel || 'whatsapp',
        draft: 'Dear ' + party.name + ', this is a gentle reminder from Express Goods Carrier regarding your outstanding balance of ' + inr(led.outstanding) + '. We would appreciate it if you could arrange payment at your earliest convenience. Please reach out if you need the invoice details. Thank you for your business.',
        note: 'Present this as a DRAFT for the owner to review and copy. Nothing has been sent. You may adjust tone if the owner asks.',
      };
    }

    default:
      return { error: 'Unknown tool: ' + name };
  }
}

module.exports = { toolsForRole, execute, SCHEMAS, _inr: inr, _chargesOf: chargesOf };

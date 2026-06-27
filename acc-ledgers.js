/* ============================================================================
   ORBIT ACCOUNTING — DERIVED REPORTS  (ACC.report*)
   ----------------------------------------------------------------------------
   EVERY report here is a pure FOLD over journalEntries (+ opening balances).
   Nothing is stored. This guarantees ledgers, registers, trial balance, P&L,
   balance sheet and outstanding can never disagree with each other or with the
   posted journal — the same SSoT guarantee enforced for Invoice vs LR.

   All functions are owner-only (callers run in the owner workspace) and return
   plain data the UI renders. They load the journal in bounded windows.
   ============================================================================ */
(function () {
  'use strict';
  if (!window.ACC) { console.error('[ACC] ledgers need ACC core'); return; }
  var fbDB = firebase.firestore();
  var round2 = ACC.round2, toNum = ACC.toNum;

  /* ---- in-memory caches, hydrated by realtime listeners in the workspace ---- */
  var _entries = [];      /* posted journal entries (status posted OR void shown struck) */
  var _accounts = {};     /* code -> account */
  var _parties = {};      /* partyId -> party */

  ACC.setData = function (entries, accounts, parties) {
    if (entries) _entries = entries;
    if (accounts) { _accounts = {}; accounts.forEach(function (a) { _accounts[a.code] = a; }); }
    if (parties) { _parties = {}; parties.forEach(function (p) { _parties[p.partyId] = p; }); }
  };
  ACC.entries  = function () { return _entries; };
  ACC.accounts = function () { return _accounts; };
  ACC.parties  = function () { return _parties; };
  ACC.account  = function (code) { return _accounts[code] || { code: code, name: code, type: 'ASSET' }; };
  ACC.party    = function (id) { return _parties[id] || { partyId: id, name: id }; };

  /* posted-only view (void entries excluded from balances but kept for display) */
  /* For BALANCE math we include voided originals: every void writes a balancing
     reversal entry, so original + reversal net to zero. Excluding only the
     original (but keeping its reversal) would corrupt the ledger. 'void' is a
     DISPLAY label, not a balance exclusion. Only never-committed states (none
     here) would be excluded. */
  function posted() { return _entries.filter(function (e) { return e.status === 'posted' || e.status === 'void'; }); }
  /* For LISTING (journal/registers) we may still want to show void state. */
  function postedOnly() { return _entries.filter(function (e) { return e.status === 'posted'; }); }
  ACC._postedForBalance = posted;

  /* normal-balance sign: returns +1 if account increases on debit */
  function debitPositive(type) {
    var t = ACC.ACCOUNT_TYPES[type];
    return t && t.normal === 'DR' ? 1 : -1;
  }

  /* ============================================================ ACCOUNT LEDGER
     All movements on one account, with a running balance. */
  ACC.reportAccountLedger = function (code, opts) {
    opts = opts || {};
    var acc = ACC.account(code);
    var sign = debitPositive(acc.type);
    var openingSigned = sign * toNum(acc.openingBalance) * (acc.openingType === 'DR' ? 1 : -1) * sign;
    /* opening: stored as openingBalance with openingType; convert to signed running base */
    var running = (acc.openingType === 'DR' ? 1 : -1) * toNum(acc.openingBalance);
    var rows = [];
    posted()
      .filter(function (e) { return dateIn(e.date, opts.from, opts.to); })
      .sort(byDate)
      .forEach(function (e) {
        e.lines.forEach(function (l) {
          if (l.accountCode !== code) return;
          var d = round2(l.debit), c = round2(l.credit);
          running = round2(running + d - c);
          rows.push({
            entryId: e.entryId, date: e.date, type: e.type, narration: e.narration,
            orderId: e.orderId, party: l.party || e.party,
            debit: d, credit: c, balance: running,
            balanceSide: running >= 0 ? 'Dr' : 'Cr'
          });
        });
      });
    return { account: acc, rows: rows, closing: running, closingSide: running >= 0 ? 'Dr' : 'Cr' };
  };

  /* ============================================================ PARTY LEDGER
     Customer or supplier statement: all entries touching this party. */
  ACC.reportPartyLedger = function (partyId, opts) {
    opts = opts || {};
    var party = ACC.party(partyId);
    var sign = party.openingType === 'DR' ? 1 : -1;
    var running = sign * toNum(party.openingBalance);
    var rows = [];
    posted()
      .filter(function (e) { return dateIn(e.date, opts.from, opts.to); })
      .sort(byDate)
      .forEach(function (e) {
        e.lines.forEach(function (l) {
          /* Only lines explicitly posted to THIS party's sub-ledger count.
             Do NOT fall back to entry-level party here, or income/tax lines of
             a sales entry would wrongly appear on the customer's statement. */
          if (l.party !== partyId) return;
          var d = round2(l.debit), c = round2(l.credit);
          running = round2(running + d - c);
          rows.push({
            entryId: e.entryId, date: e.date, type: e.type, narration: e.narration,
            orderId: e.orderId, invoiceId: e.invoiceId,
            debit: d, credit: c, balance: running, balanceSide: running >= 0 ? 'Dr' : 'Cr'
          });
        });
      });
    return {
      party: party, rows: rows, closing: running,
      closingSide: running >= 0 ? 'Dr' : 'Cr',
      outstanding: party.kind === 'supplier' ? -running : running
    };
  };

  /* ============================================================ OUTSTANDING
     Per-customer receivable = Σ(debtor debits − debtor credits) for that party.
     Aged into buckets by entry date (current / 30 / 60 / 90+). */
  ACC.reportOutstanding = function () {
    var debtors = ACC.acct('debtors');
    var byParty = {};
    posted().forEach(function (e) {
      e.lines.forEach(function (l) {
        if (l.accountCode !== debtors) return;
        var pid = l.party || e.party; if (!pid) return;
        if (!byParty[pid]) byParty[pid] = { partyId: pid, name: ACC.party(pid).name, balance: 0, buckets: { cur: 0, d30: 0, d60: 0, d90: 0 }, lastDate: e.date };
        var net = round2(l.debit - l.credit);
        byParty[pid].balance = round2(byParty[pid].balance + net);
        var age = ageDays(e.date);
        var b = byParty[pid].buckets;
        if (age <= 30) b.cur = round2(b.cur + net);
        else if (age <= 60) b.d30 = round2(b.d30 + net);
        else if (age <= 90) b.d60 = round2(b.d60 + net);
        else b.d90 = round2(b.d90 + net);
        if (e.date > byParty[pid].lastDate) byParty[pid].lastDate = e.date;
      });
    });
    var list = Object.keys(byParty).map(function (k) { return byParty[k]; })
      .filter(function (p) { return Math.abs(p.balance) >= 0.01; })
      .sort(function (a, b) { return b.balance - a.balance; });
    var total = list.reduce(function (s, p) { return round2(s + p.balance); }, 0);
    return { rows: list, total: total };
  };

  /* ============================================================ REGISTERS
     Sales / Purchase register = one row per SALES / PURCHASE entry. */
  ACC.reportRegister = function (type, opts) {
    opts = opts || {};
    return posted()
      .filter(function (e) { return e.type === type && dateIn(e.date, opts.from, opts.to); })
      .sort(byDate)
      .map(function (e) {
        var taxable = 0, tax = 0, total = round2(e.totalDebit);
        e.lines.forEach(function (l) {
          var a = ACC.account(l.accountCode);
          if (a.group === 'Tax') tax = round2(tax + l.debit + l.credit);
        });
        taxable = round2(total - tax);
        return {
          entryId: e.entryId, date: e.date, party: ACC.party(e.party).name,
          orderId: e.orderId, invoiceId: e.invoiceId,
          taxable: taxable, tax: tax, total: total, narration: e.narration,
          status: e.status
        };
      });
  };

  /* ============================================================ CASH / BANK BOOK
     Movements through the cash or bank account, with running balance. */
  ACC.reportCashBook = function (which, opts) {
    var code = which === 'cash' ? ACC.acct('cash') : ACC.acct('bank');
    return ACC.reportAccountLedger(code, opts);
  };

  /* ============================================================ TRIAL BALANCE
     Σ debit / Σ credit per account incl. opening. Must balance (built-in proof). */
  ACC.reportTrialBalance = function (opts) {
    opts = opts || {};
    var bal = {};   /* code -> signed running (Dr +, Cr -) */
    Object.keys(_accounts).forEach(function (code) {
      var a = _accounts[code];
      bal[code] = (a.openingType === 'DR' ? 1 : -1) * toNum(a.openingBalance);
    });
    posted()
      .filter(function (e) { return dateIn(e.date, opts.from, opts.to); })
      .forEach(function (e) {
        e.lines.forEach(function (l) {
          if (bal[l.accountCode] == null) bal[l.accountCode] = 0;
          bal[l.accountCode] = round2(bal[l.accountCode] + l.debit - l.credit);
        });
      });
    var rows = [], totalDr = 0, totalCr = 0;
    Object.keys(bal).sort().forEach(function (code) {
      var v = round2(bal[code]); if (v === 0) return;
      var a = ACC.account(code);
      var dr = v > 0 ? v : 0, cr = v < 0 ? -v : 0;
      totalDr = round2(totalDr + dr); totalCr = round2(totalCr + cr);
      rows.push({ code: code, name: a.name, type: a.type, group: a.group, debit: dr, credit: cr });
    });
    return { rows: rows, totalDebit: totalDr, totalCredit: totalCr, balanced: totalDr === totalCr };
  };

  /* ============================================================ P&L
     Income − Expense over the period. */
  ACC.reportProfitLoss = function (opts) {
    var tb = ACC.reportTrialBalance(opts);
    var income = [], expense = [], incomeTotal = 0, expenseTotal = 0;
    tb.rows.forEach(function (r) {
      if (r.type === 'INCOME') { var amt = round2(r.credit - r.debit); income.push({ name: r.name, amount: amt }); incomeTotal = round2(incomeTotal + amt); }
      else if (r.type === 'EXPENSE') { var ex = round2(r.debit - r.credit); expense.push({ name: r.name, amount: ex }); expenseTotal = round2(expenseTotal + ex); }
    });
    return { income: income, expense: expense, incomeTotal: incomeTotal, expenseTotal: expenseTotal, netProfit: round2(incomeTotal - expenseTotal) };
  };

  /* ============================================================ BALANCE SHEET
     Assets = Liabilities + Equity + retained (net profit). */
  ACC.reportBalanceSheet = function (opts) {
    var tb = ACC.reportTrialBalance(opts);
    var assets = [], liabilities = [], equity = [];
    var aT = 0, lT = 0, eT = 0;
    tb.rows.forEach(function (r) {
      if (r.type === 'ASSET') { var a = round2(r.debit - r.credit); assets.push({ name: r.name, amount: a }); aT = round2(aT + a); }
      else if (r.type === 'LIABILITY') { var l = round2(r.credit - r.debit); liabilities.push({ name: r.name, amount: l }); lT = round2(lT + l); }
      else if (r.type === 'EQUITY') { var q = round2(r.credit - r.debit); equity.push({ name: r.name, amount: q }); eT = round2(eT + q); }
    });
    var pl = ACC.reportProfitLoss(opts);
    equity.push({ name: 'Profit & Loss (current)', amount: pl.netProfit });
    eT = round2(eT + pl.netProfit);
    return { assets: assets, liabilities: liabilities, equity: equity,
             assetTotal: aT, liabilityTotal: lT, equityTotal: eT,
             balanced: aT === round2(lT + eT) };
  };

  /* ============================================================ DASHBOARD KPIs */
  ACC.reportDashboard = function (opts) {
    var s = ACC.acct ? ACC.settings() : null;
    var out = ACC.reportOutstanding();
    var pl = ACC.reportProfitLoss(opts);
    var cash = ACC.reportAccountLedger(ACC.acct('cash'), opts).closing;
    var bank = ACC.reportAccountLedger(ACC.acct('bank'), opts).closing;
    var sales = ACC.reportRegister('SALES', opts);
    var salesTotal = sales.reduce(function (a, r) { return round2(a + r.total); }, 0);
    return {
      revenue: pl.incomeTotal, expenses: pl.expenseTotal, netProfit: pl.netProfit,
      outstanding: out.total, cash: cash, bank: bank, cashBank: round2(cash + bank),
      salesCount: sales.length, salesTotal: salesTotal,
      topDebtors: out.rows.slice(0, 5)
    };
  };

  /* --------------------------------------------------------------- helpers */
  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.entryId < b.entryId ? -1 : 1); }
  function dateIn(d, from, to) { if (from && d < from) return false; if (to && d > to) return false; return true; }
  function ageDays(d) { var t = new Date(d).getTime(); if (isNaN(t)) return 0; return Math.floor((Date.now() - t) / 86400000); }
  ACC.ageDays = ageDays;

  console.log('[ACC] derived reports loaded.');
})();

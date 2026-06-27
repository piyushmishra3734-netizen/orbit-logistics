/* ============================================================================
   ORBIT ACCOUNTING — CORE  (window.ACC)
   ----------------------------------------------------------------------------
   The foundation of a real double-entry accounting system, plugged into the
   existing Orbit SSoT architecture.

   DESIGN CONTRACT (do not violate):
   - The ORDER is the source of truth for shipment data. Accounting links to it
     by orderId and never duplicates shipment fields as its own master.
   - The JOURNAL (journalEntries) is the source of truth for MONEY. Every report
     (ledgers, registers, trial balance, P&L, balance sheet, outstanding) is a
     fold over journalEntries. No derived balances are stored.
   - A POSTED entry is IMMUTABLE. Corrections are made by VOID + repost or by an
     ADJUSTMENT entry — never by mutating a posted entry. This is what makes the
     ledger audit-grade.
   - Every entry must balance: sum(debit) === sum(credit). ACC.post enforces it.
   - Owner-only. Firestore rules forbid customer access to all acc-* collections.

   GST: the engine is GST-READY but posts 0% until rates are set in Settings
   (owner decision). When rates are configured, Sales auto-posting will split
   freight income and SGST/CGST output tax automatically — no code change.

   START POINT: fresh (no historical data). Opening-balance import is designed
   for (accounts carry openingBalance/openingType) but the import UI is a later
   phase.
   ============================================================================ */
(function () {
  'use strict';

  if (!window.EGC) { console.error('[ACC] EGC core must load before acc-core.js'); return; }
  var fbDB = firebase.firestore();
  var FieldValue = firebase.firestore.FieldValue;

  window.ACC = window.ACC || {};

  /* ------------------------------------------------------------------ utils */
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  /* round to 2 decimals without binary-float drift (paise-accurate) */
  function round2(v) { return Math.round((toNum(v) + Number.EPSILON) * 100) / 100; }
  ACC.toNum = toNum;
  ACC.round2 = round2;

  /* ============================================================================
     ACCOUNT TYPES & NORMAL BALANCE
     Assets & Expenses are DEBIT-normal; Liabilities, Income, Equity are
     CREDIT-normal. Used by trial balance / statements to sign balances.
     ============================================================================ */
  var ACCOUNT_TYPES = {
    ASSET:     { normal: 'DR', statement: 'BS' },
    LIABILITY: { normal: 'CR', statement: 'BS' },
    EQUITY:    { normal: 'CR', statement: 'BS' },
    INCOME:    { normal: 'CR', statement: 'PL' },
    EXPENSE:   { normal: 'DR', statement: 'PL' }
  };
  ACC.ACCOUNT_TYPES = ACCOUNT_TYPES;

  /* ============================================================================
     CHART OF ACCOUNTS — seed (Munim-style, transport business)
     Codes are grouped: 1xxx assets, 2xxx liabilities, 3xxx equity,
     4xxx income, 5xxx expenses. Party sub-ledgers (customers/suppliers) are
     created dynamically under 1200 (debtors) / 2100 (creditors).
     ============================================================================ */
  var DEFAULT_COA = [
    /* ASSETS */
    { code: '1000', name: 'Cash in Hand',            type: 'ASSET',     group: 'Cash & Bank' },
    { code: '1010', name: 'Bank Account',            type: 'ASSET',     group: 'Cash & Bank' },
    { code: '1200', name: 'Sundry Debtors',          type: 'ASSET',     group: 'Receivables', isControl: true },
    { code: '1300', name: 'Input GST (SGST)',        type: 'ASSET',     group: 'Tax' },
    { code: '1310', name: 'Input GST (CGST)',        type: 'ASSET',     group: 'Tax' },
    /* LIABILITIES */
    { code: '2100', name: 'Sundry Creditors',        type: 'LIABILITY', group: 'Payables', isControl: true },
    { code: '2200', name: 'Output GST (SGST)',       type: 'LIABILITY', group: 'Tax' },
    { code: '2210', name: 'Output GST (CGST)',       type: 'LIABILITY', group: 'Tax' },
    { code: '2300', name: 'Advance from Customers',  type: 'LIABILITY', group: 'Advances' },
    /* EQUITY */
    { code: '3000', name: 'Capital Account',         type: 'EQUITY',    group: 'Capital' },
    { code: '3900', name: 'Retained Earnings',       type: 'EQUITY',    group: 'Reserves' },
    /* INCOME */
    { code: '4000', name: 'Freight Income',          type: 'INCOME',    group: 'Operating Income' },
    { code: '4010', name: 'Other Income',            type: 'INCOME',    group: 'Other Income' },
    { code: '4900', name: 'Discount Allowed',        type: 'EXPENSE',   group: 'Operating Expense' },
    /* EXPENSES */
    { code: '5000', name: 'Vehicle / Lorry Hire',    type: 'EXPENSE',   group: 'Direct Expense' },
    { code: '5010', name: 'Fuel & Diesel',           type: 'EXPENSE',   group: 'Direct Expense' },
    { code: '5020', name: 'Driver Salary & Bhatta',  type: 'EXPENSE',   group: 'Direct Expense' },
    { code: '5030', name: 'Loading / Labour',        type: 'EXPENSE',   group: 'Direct Expense' },
    { code: '5040', name: 'Toll & Tax',              type: 'EXPENSE',   group: 'Direct Expense' },
    { code: '5050', name: 'Vehicle Maintenance',     type: 'EXPENSE',   group: 'Direct Expense' },
    { code: '5900', name: 'Office & Admin',          type: 'EXPENSE',   group: 'Indirect Expense' },
    { code: '5910', name: 'Bank Charges',            type: 'EXPENSE',   group: 'Indirect Expense' }
  ];
  ACC.DEFAULT_COA = DEFAULT_COA;

  /* Stable mapping the posting engine relies on (kept in Settings so it can be
     remapped without code changes). */
  var DEFAULT_SETTINGS = {
    fiscalYearStart: '04-01',            /* India FY: 1 April */
    gstReady: true,
    sgstRate: 0,                         /* 0% until owner sets rates */
    cgstRate: 0,
    accounts: {
      debtors:       '1200',
      creditors:     '2100',
      freightIncome: '4000',
      otherIncome:   '4010',
      discount:      '4900',
      outputSgst:    '2200',
      outputCgst:    '2210',
      inputSgst:     '1300',
      inputCgst:     '1310',
      advance:       '2300',
      cash:          '1000',
      bank:          '1010'
    },
    importMode: false                    /* opening-balance import: later phase */
  };
  ACC.DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  /* ------------------------------------------------------------- settings io */
  var _settingsCache = null;
  ACC.loadSettings = function () {
    return fbDB.collection('accountingSettings').doc('config').get().then(function (snap) {
      _settingsCache = snap.exists
        ? mergeSettings(DEFAULT_SETTINGS, snap.data())
        : DEFAULT_SETTINGS;
      return _settingsCache;
    }).catch(function () { _settingsCache = DEFAULT_SETTINGS; return _settingsCache; });
  };
  ACC.settings = function () { return _settingsCache || DEFAULT_SETTINGS; };
  ACC.acct = function (key) { return ACC.settings().accounts[key]; };

  function mergeSettings(base, over) {
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(over || {}).forEach(function (k) {
      if (k === 'accounts' && over.accounts) {
        Object.keys(over.accounts).forEach(function (a) { out.accounts[a] = over.accounts[a]; });
      } else { out[k] = over[k]; }
    });
    return out;
  }

  ACC.saveSettings = function (patch) {
    return fbDB.collection('accountingSettings').doc('config')
      .set(Object.assign({ updatedAt: FieldValue.serverTimestamp() }, patch), { merge: true })
      .then(function () { return ACC.loadSettings(); });
  };

  /* ============================================================================
     SEEDING — idempotent. Creates the Chart of Accounts + settings once.
     Safe to call on every owner load; only writes what is missing.
     ============================================================================ */
  ACC.ensureSeeded = function () {
    var coaRef = fbDB.collection('accounts');
    return coaRef.limit(1).get().then(function (snap) {
      if (!snap.empty) return ACC.loadSettings();        /* already seeded */
      var batch = fbDB.batch();
      DEFAULT_COA.forEach(function (a) {
        batch.set(coaRef.doc(a.code), {
          code: a.code, name: a.name, type: a.type, group: a.group,
          isControl: !!a.isControl, isLedger: true,
          openingBalance: 0, openingType: ACCOUNT_TYPES[a.type].normal,
          active: true, system: true,
          createdAt: FieldValue.serverTimestamp()
        });
      });
      batch.set(fbDB.collection('accountingSettings').doc('config'),
        Object.assign({ createdAt: FieldValue.serverTimestamp() }, DEFAULT_SETTINGS), { merge: true });
      return batch.commit().then(function () {
        EGC.reliableAudit('accounting_seeded', 'Chart of Accounts initialised (' + DEFAULT_COA.length + ' accounts).',
          { targetType: 'accounting', targetId: 'coa', newValue: DEFAULT_COA.length });
        return ACC.loadSettings();
      });
    });
  };

  /* ============================================================================
     PARTY SUB-LEDGERS — a customer or supplier becomes a ledger account under
     the Debtors / Creditors control account. Keyed by a slug so it is stable
     and de-duplicated. Linked to customerUid when known (for permission + SSoT).
     ============================================================================ */
  function slug(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  ACC.partyId = function (kind, name) { return (kind === 'supplier' ? 'sup-' : 'cust-') + slug(name); };

  ACC.ensureParty = function (opts) {
    /* opts: { kind:'customer'|'supplier', name, gst?, customerUid?, phone?, email? } */
    var id = ACC.partyId(opts.kind, opts.name);
    var ref = fbDB.collection('parties').doc(id);
    return ref.get().then(function (snap) {
      if (snap.exists) return Object.assign({ _id: id }, snap.data());
      var rec = {
        partyId: id, kind: opts.kind, name: opts.name || '',
        gst: opts.gst || '', phone: opts.phone || '', email: opts.email || '',
        customerUid: opts.customerUid || null,
        controlAccount: opts.kind === 'supplier' ? ACC.acct('creditors') : ACC.acct('debtors'),
        openingBalance: 0, openingType: opts.kind === 'supplier' ? 'CR' : 'DR',
        active: true, createdAt: FieldValue.serverTimestamp()
      };
      return ref.set(rec).then(function () { return Object.assign({ _id: id }, rec); });
    });
  };

  /* ============================================================================
     THE POSTING ENGINE — ACC.post
     The single gate every journal entry passes through. Guarantees:
       1. balanced (Σdebit === Σcredit, paise-accurate)
       2. non-empty, valid lines (each line is debit XOR credit, > 0)
       3. atomic write of the entry
       4. reliable (B3) audit follow-up that can never silently vanish
       5. immutability — this function only CREATES entries; it never updates a
          posted one. Corrections go through ACC.voidEntry / ACC.postAdjustment.
     ============================================================================ */
  function validateLines(lines) {
    if (!Array.isArray(lines) || !lines.length) throw new Error('Entry has no lines.');
    var dr = 0, cr = 0;
    lines.forEach(function (ln, i) {
      var d = round2(ln.debit), c = round2(ln.credit);
      if (d < 0 || c < 0) throw new Error('Line ' + (i + 1) + ': negative amount.');
      if (d > 0 && c > 0) throw new Error('Line ' + (i + 1) + ': a line cannot be both debit and credit.');
      if (d === 0 && c === 0) throw new Error('Line ' + (i + 1) + ': zero amount.');
      if (!ln.accountCode) throw new Error('Line ' + (i + 1) + ': missing account.');
      dr = round2(dr + d); cr = round2(cr + c);
    });
    if (dr !== cr) throw new Error('Entry not balanced: debit ' + dr + ' \u2260 credit ' + cr + '.');
    return { totalDebit: dr, totalCredit: cr };
  }
  ACC.validateLines = validateLines;

  ACC.post = function (entry) {
    /* entry: { date, type, narration, sourceType, orderId?, invoiceId?, party?,
                lines:[{accountCode,debit,credit,party?,memo?}], adjustsEntryId? } */
    var totals;
    try { totals = validateLines(entry.lines); }
    catch (e) { return Promise.reject(e); }

    return EGC.nextEntryId().then(function (entryId) {
      var rec = {
        entryId:    entryId,
        date:       entry.date || new Date().toISOString().slice(0, 10),
        type:       entry.type || 'JOURNAL',
        narration:  entry.narration || '',
        sourceType: entry.sourceType || 'manual',
        orderId:    entry.orderId || null,
        invoiceId:  entry.invoiceId || null,
        party:      entry.party || null,
        lines:      entry.lines.map(function (l) {
                      return {
                        accountCode: l.accountCode,
                        debit: round2(l.debit), credit: round2(l.credit),
                        party: l.party || null, memo: l.memo || ''
                      };
                    }),
        totalDebit:  totals.totalDebit,
        totalCredit: totals.totalCredit,
        status:      'posted',
        voidsEntryId:   entry.voidsEntryId || null,
        adjustsEntryId: entry.adjustsEntryId || null,
        createdAt:   FieldValue.serverTimestamp(),
        createdBy:   (firebase.auth().currentUser || {}).email || 'owner'
      };
      var ref = fbDB.collection('journalEntries').doc(entryId);
      return ref.set(rec).then(function () {
        EGC.reliableAudit('journal_posted',
          rec.type + ' entry ' + entryId + ' posted (' + totals.totalDebit + ').',
          { targetType: 'journalEntry', targetId: entryId, orderId: rec.orderId,
            newValue: { type: rec.type, amount: totals.totalDebit } });
        return Object.assign({ _id: entryId }, rec);
      });
    });
  };

  /* VOID — never deletes. Posts a mirror-image entry that reverses the original
     and marks both as void/linked, preserving the full audit chain. */
  ACC.voidEntry = function (original, reason) {
    var reversed = original.lines.map(function (l) {
      return { accountCode: l.accountCode, debit: l.credit, credit: l.debit, party: l.party, memo: 'Reversal' };
    });
    return ACC.post({
      date: new Date().toISOString().slice(0, 10),
      type: original.type, sourceType: 'adjustment',
      narration: 'Void: ' + (reason || '') + ' [reverses ' + original.entryId + ']',
      orderId: original.orderId, invoiceId: original.invoiceId, party: original.party,
      lines: reversed, voidsEntryId: original.entryId
    }).then(function (rev) {
      return fbDB.collection('journalEntries').doc(original.entryId)
        .set({ status: 'void', voidedByEntryId: rev.entryId, voidedAt: FieldValue.serverTimestamp() }, { merge: true })
        .then(function () { return rev; });
    });
  };

  /* ID allocator for entries — reuses the same transactional counter pattern as
     orders/invoices so numbering is gap-safe-over-duplicate and shardable later. */
  if (!EGC.nextEntryId) {
    EGC.nextEntryId = function () {
      /* Mirrors phase3-core nextSequentialId; defined here so accounting is
         self-contained. Counter doc: counters/journal. Prefix JV. */
      var year = new Date().getFullYear();
      var ref = fbDB.collection('counters').doc('journal');
      return fbDB.runTransaction(function (tx) {
        return tx.get(ref).then(function (snap) {
          var data = snap.exists ? snap.data() : null;
          var seq = (data && data.year === year) ? (data.lastSeq || 0) + 1 : 1;
          tx.set(ref, { year: year, lastSeq: seq }, { merge: true });
          return 'JV-' + year + '-' + ('000' + seq).slice(-4);
        });
      });
    };
  }

  console.log('[ACC] core loaded — Chart of Accounts, posting engine ready.');
})();

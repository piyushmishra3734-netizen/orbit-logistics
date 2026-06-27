/* ============================================================================
   ACCOUNTING — DAILY-USE UX QA (Playwright)
   Locks the refinements that make the Accounting module usable by a
   non-accountant transport owner: plain-language captions, jargon-free voucher
   labels, a clean "What was it for?" picker (no GL codes), human confirmation
   messages that PERSIST (not wiped by background re-render), and deep-link
   prefill for one-click payment recording.
   ============================================================================ */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const PW = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const { chromium } = PW;

const APP = path.join(__dirname, '..', 'EGC-Logistics-System');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-firebase-browser.js'), 'utf8');

let PASS = 0, FAIL = 0; const fails = [];
function ok(c, m) { if (c) { PASS++; console.log('   ✓ ' + m); } else { FAIL++; fails.push(m); console.log('   ✗ ' + m); } }
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length))); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let url = req.url.split('?')[0]; if (url === '/') url = '/index.html';
      const fp = path.join(APP, url);
      if (!fp.startsWith(APP) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
      res.end(fs.readFileSync(fp));
    });
    srv.listen(0, () => resolve(srv));
  });
}

function seed() {
  return 'window.__MOCK_ROLE="owner";window.__MOCK_DB={' +
    'customerProfiles:{"owner-uid":{uid:"owner-uid",email:"piyushmishra3734@gmail.com",onboardingComplete:true}},' +
    'orders:{},invoices:{},lorryReceipts:{},quotes:{},notifications:{},activityLog:{},counters:{journal:{year:2026,lastSeq:0}},' +
    'accounts:{"1100":{code:"1100",name:"Cash in Hand",type:"ASSET",group:"Current Assets",openingBalance:0,openingType:"DR"},' +
    '"1110":{code:"1110",name:"Bank",type:"ASSET",group:"Current Assets",openingBalance:0,openingType:"DR"},' +
    '"1200":{code:"1200",name:"Sundry Debtors",type:"ASSET",group:"Current Assets",openingBalance:0,openingType:"DR"},' +
    '"5010":{code:"5010",name:"Fuel & Diesel",type:"EXPENSE",group:"Direct Expense",openingBalance:0,openingType:"DR"},' +
    '"5040":{code:"5040",name:"Toll & Tax",type:"EXPENSE",group:"Direct Expense",openingBalance:0,openingType:"DR"}},' +
    'accountingSettings:{},parties:{"cust-acme":{partyId:"cust-acme",name:"Acme Traders",kind:"customer",openingBalance:0,openingType:"DR"}},' +
    'journalEntries:{},auditLogs:{},companies:{}};';
}

async function main() {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to load|gstatic|favicon|reliable/.test(t)) errs.push(t); } });
  page.on('pageerror', (e) => errs.push('PE: ' + e.message));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (/gstatic/.test(url)) return route.fulfill({ status: 200, body: '/*s*/' });
    if (/firebase-config\.js/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK + '\n' + seed() });
    return route.continue();
  });

  await page.goto(base + '/accounting.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof ACC !== 'undefined' && document.querySelector('.side-link'), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);

  section('Plain-language navigation');
  const labels = await page.evaluate(() => Array.from(document.querySelectorAll('.side-link span')).map((s) => s.textContent));
  ok(labels.includes('Receive Payment') && labels.includes('Make Payment') && labels.includes('Cash ↔ Bank'), 'Sidebar uses plain voucher labels (no "Voucher/Contra" jargon)');

  section('Make Payment — clean "What was it for?" picker');
  await page.evaluate(() => ACC.goTo('payment'));
  await page.waitForTimeout(400);
  const picker = await page.evaluate(() => {
    const sel = document.getElementById('vp-acct');
    const opts = Array.from(sel.options).map((o) => o.textContent);
    return { opts, hasCode: opts.some((o) => /^\d{4}/.test(o)), groups: Array.from(sel.querySelectorAll('optgroup')).map((g) => g.label) };
  });
  ok(!picker.hasCode, 'Expense picker shows names only — no GL codes');
  ok(picker.groups.includes('Expenses'), 'Expenses grouped together for quick picking');
  ok(picker.opts.some((o) => /Fuel & Diesel/.test(o)) && picker.opts.some((o) => /Toll & Tax/.test(o)), 'Common transport expenses present by name');
  const payBtn = await page.evaluate(() => (document.getElementById('vp-save') || {}).textContent);
  ok(/Save/.test(payBtn) && !/Post/.test(payBtn), 'Button says "Save", not "Post"');

  section('Make Payment — human confirmation that PERSISTS');
  await page.evaluate(() => { document.getElementById('vp-amount').value = '2500'; const s = document.getElementById('vp-acct'); const f = Array.from(s.options).find((o) => /Fuel/.test(o.textContent)); if (f) s.value = f.value; });
  await page.evaluate(() => document.getElementById('vp-save').click());
  await page.waitForTimeout(700);
  let msg = await page.evaluate(() => (document.getElementById('vp-msg') || {}).textContent);
  ok(/₹2,500/.test(msg) && /Fuel/.test(msg) && /saved/i.test(msg), 'Confirmation is human: "₹2,500 paid for Fuel & Diesel — saved."');
  ok(!/JV-/.test(msg), 'Confirmation hides the internal entry ID');
  // wait longer — the background listener must NOT wipe the confirmation
  await page.waitForTimeout(800);
  msg = await page.evaluate(() => (document.getElementById('vp-msg') || {}).textContent);
  ok(/saved/i.test(msg), 'Confirmation PERSISTS after background data update (not wiped by re-render)');

  section('Receive Payment — deep-link prefill (one-click from invoice)');
  await page.evaluate(() => { location.hash = '#receipt?partyName=Acme%20Traders&amount=18000&inv=INV-2026-0001'; });
  await page.waitForTimeout(600);
  const prefill = await page.evaluate(() => {
    const p = document.getElementById('vr-party'); const a = document.getElementById('vr-amount'); const n = document.getElementById('vr-note');
    return { party: p ? p.options[p.selectedIndex].textContent : '', amount: a ? a.value : '', note: n ? n.value : '' };
  });
  ok(/Acme/.test(prefill.party), 'Deep-link pre-selects the customer');
  ok(prefill.amount === '18000', 'Deep-link pre-fills the outstanding amount');
  ok(/INV-2026-0001/.test(prefill.note), 'Deep-link pre-fills the narration with the invoice');

  section('After receipt — one-click order sync (no double entry)');
  // arrive via the Record-Payment deep-link (carries orderId), save, then sync
  await page.evaluate(() => { location.hash = '#receipt?partyName=Acme%20Traders&amount=18000&inv=INV-2026-0001&orderId=EGC-TEST-1'; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { const a = document.getElementById('vr-amount'); if (a && !a.value) a.value = '18000'; document.getElementById('vr-save').click(); });
  await page.waitForTimeout(700);
  const syncOffer = await page.evaluate(() => { const w = document.getElementById('vr-sync'); return w ? w.textContent.trim() : ''; });
  ok(/fully paid on the order|Update INV/.test(syncOffer), 'After a linked receipt, Orbit offers to update the order in one click');

  section('Help captions present');
  await page.evaluate(() => ACC.goTo('outstanding'));
  await page.waitForTimeout(400);
  const help = await page.evaluate(() => { const h = document.querySelector('.acc-help'); return h ? h.textContent : ''; });
  ok(/chase|owe|pending/i.test(help), 'Outstanding page shows a plain-language caption');

  section('Orbit AI present + proactive on Accounting');
  ok(await page.evaluate(() => !!document.getElementById('oaiFab')), 'Orbit AI assistant is available on the Accounting screen');
  await page.evaluate(() => ACC.goTo('outstanding'));
  await page.waitForTimeout(300);
  await page.click('#oaiFab');
  await page.waitForTimeout(500);
  const proactive = await page.evaluate(() => Array.from(document.querySelectorAll('.oai-msg.oai-bot .oai-msg-in')).map((b) => b.textContent));
  ok(proactive.some((t) => /outstanding|90 days|Acme/i.test(t)), 'On Outstanding, Orbit AI proactively says who to chase (no question needed)');
  const ctxSent = await page.evaluate(() => window.__ORBIT_INSIGHT_CTX);
  ok(ctxSent && ctxSent.page === 'accounting' && ctxSent.hash === 'outstanding', 'Insight request carries the correct screen context');

  ok(errs.length === 0, 'No console errors across accounting flows' + (errs.length ? ' — ' + errs.join(' | ') : ''));

  await browser.close();
  srv.close();

  console.log('\n' + '='.repeat(56));
  console.log('  ACCOUNTING UX RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL ACCOUNTING UX CHECKS PASSED.');
}
main().catch((e) => { console.error('HARNESS ERROR:', e.stack); process.exit(2); });

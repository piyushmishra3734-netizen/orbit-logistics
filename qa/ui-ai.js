/* ============================================================================
   ORBIT AI — BROWSER UI QA (Playwright + Chromium, offline)
   Boots the real dashboards with the mock Firebase (incl. a mock orbitAI
   callable) and verifies the floating assistant: mount, open/close, role-aware
   suggestions, send → reply, typing indicator, navigate/draft actions, and
   zero console errors.
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let url = req.url.split('?')[0];
      if (url === '/') url = '/index.html';
      const fp = path.join(APP, url);
      if (!fp.startsWith(APP) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
      res.end(fs.readFileSync(fp));
    });
    srv.listen(0, () => resolve(srv));
  });
}

function seedScript(role) {
  const now = Date.now();
  const uid = role === 'owner' ? 'owner-uid' : 'cust-A-uid';
  const email = role === 'owner' ? 'piyushmishra3734@gmail.com' : 'cust@acme.test';
  return `
    window.__MOCK_ROLE = ${JSON.stringify(role)};
    window.__MOCK_DB = {
      customerProfiles: { '${uid}': { uid:'${uid}', email:'${email}', contactPerson:'Test User', mobile:'9000000000', onboardingComplete:true, createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), updatedAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) } },
      orders: {
        'EGC-2026-0001': { orderId:'EGC-2026-0001', customerUid:'cust-A-uid', shipmentType:'commercial', status:'in_transit', companyName:'Acme', pickup:'Indore', delivery:'Mumbai', freight:18000, fov:0, labour:0, localCollection:0, doorDelivery:0, docketCharges:0, haltingCharges:0, extraCharges:0, discount:0, sgstRate:0, cgstRate:0, advanceReceived:0, receivedAmount:0, paymentStatus:'pending', invoiceId:'INV-2026-0001', lrNumber:'LR-2026-0001', createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), updatedAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) }
      },
      invoices: { 'INV-2026-0001': { invoiceId:'INV-2026-0001', invoiceNumber:'INV-2026-0001', orderId:'EGC-2026-0001', lrNumber:'LR-2026-0001', customerUid:'cust-A-uid', invoiceDate: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) } },
      lorryReceipts: { 'LR-2026-0001': { lrNumber:'LR-2026-0001', orderId:'EGC-2026-0001', invoiceId:'INV-2026-0001', customerUid:'cust-A-uid' } },
      quotes: {}, notifications: {}, activityLog: {}, counters: {}, accounts: {}, accountingSettings: {}, parties: {}, journalEntries: {}, auditLogs: {}, companies: {}
    };
  `;
}

async function setupPage(browser, role, consoleErrors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Failed to load resource|net::ERR|favicon|gstatic|reliable op failed|customerProfiles|users write/i.test(t)) return;
      consoleErrors.push(t);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (/gstatic\.com\/firebasejs/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* firebase cdn stubbed */' });
    if (/firebase-config\.js(\?|$)/.test(url)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK + '\n' + seedScript(role) });
    return route.continue();
  });
  return { ctx, page };
}

async function bootDash(page, base, file) {
  await page.goto(base + '/' + file, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => { const m = document.getElementById('dashMain'); return m && getComputedStyle(m).display !== 'none'; }, { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !!document.getElementById('orbitAiRoot'), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}

async function exercise(page, role) {
  // mount
  ok(await page.$('#orbitAiRoot'), role + ': Orbit AI root mounts');
  ok(await page.$('#oaiFab'), role + ': floating launcher present');
  const brand = await page.evaluate(() => { const s = document.querySelector('.oai-sub'); return s ? s.textContent : ''; });
  // brand only visible after open; check after opening
  // open
  await page.click('#oaiFab');
  await page.waitForTimeout(250);
  ok(await page.evaluate(() => document.getElementById('oaiPanel').classList.contains('on')), role + ': panel opens on launcher click');
  ok(await page.evaluate(() => (document.querySelector('.oai-sub') || {}).textContent === 'Powered by Gemini'), role + ': branding shows "Powered by Gemini"');
  ok(await page.evaluate(() => document.querySelectorAll('.oai-chip').length >= 2), role + ': suggested prompts render');

  // role-aware + context-aware suggestions
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll('.oai-chip')).map((c) => c.textContent));
  if (role === 'owner') ok(chips.some((c) => /unpaid|revenue|trial balance|manual order|quot|chase|pending|deliveries|health|profit|invoice/i.test(c)), 'owner: owner-specific (context-aware) suggestions present');
  else ok(chips.some((c) => /where is my shipment|payment status|invoice/i.test(c)) && !chips.some((c) => /trial balance|unpaid customers/i.test(c)), 'customer: customer-only suggestions (no owner prompts)');

  // welcome message present
  ok(await page.evaluate(() => document.querySelectorAll('.oai-msg.oai-bot').length >= 1), role + ': welcome message rendered');

  // send a message → typing indicator → reply
  await page.fill('#oaiText', role === 'owner' ? 'show unpaid customers' : 'where is my shipment');
  await page.click('#oaiSend');
  // typing indicator appears briefly
  const sawTyping = await page.evaluate(() => new Promise((res) => {
    let seen = false;
    const obs = new MutationObserver(() => { if (document.getElementById('oaiTyping')) { seen = true; } });
    obs.observe(document.getElementById('oaiBody'), { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); res(seen || !!document.getElementById('oaiTyping')); }, 60);
  })).catch(() => false);
  await page.waitForTimeout(300);
  const reply = await page.evaluate(() => {
    const bots = document.querySelectorAll('.oai-msg.oai-bot .oai-msg-in');
    return bots.length ? bots[bots.length - 1].textContent : '';
  });
  ok(/Mock Orbit AI reply/.test(reply), role + ': reply from (mock) Orbit AI renders');
  ok(await page.evaluate(() => !document.getElementById('oaiTyping')), role + ': typing indicator cleared after reply');

  // the payload carried message + history + context (proves wiring)
  const payload = await page.evaluate(() => window.__ORBIT_LAST_PAYLOAD);
  ok(payload && payload.message && Array.isArray(payload.history) && payload.context, role + ': callable received message + history + context');
  ok(payload && payload.context && payload.context.page, role + ': page context attached to request');

  // Explanation answer offers depth follow-up chips ("Explain more" / "like I'm new")
  await page.fill('#oaiText', 'what is GST');
  await page.click('#oaiSend');
  await page.waitForTimeout(300);
  const hasFollowups = await page.evaluate(() => {
    const fu = document.querySelectorAll('.oai-followup');
    return Array.from(fu).map((f) => f.textContent);
  });
  ok(hasFollowups.length >= 2 && hasFollowups.some((t) => /more/i.test(t)) && hasFollowups.some((t) => /new/i.test(t)), role + ': explanation answers offer "Explain more" + "Explain like I\'m new" chips');
  // tapping one sends a deeper follow-up
  await page.evaluate(() => { const f = Array.from(document.querySelectorAll('.oai-followup')).find((x) => /new/i.test(x.textContent)); if (f) f.click(); });
  await page.waitForTimeout(300);
  const followPayload = await page.evaluate(() => window.__ORBIT_LAST_PAYLOAD);
  ok(followPayload && /never studied accounting|simple/i.test(followPayload.message), role + ': tapping a depth chip sends a simpler-explanation request');

  // close
  await page.click('#oaiClose');
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => !document.getElementById('oaiPanel').classList.contains('on')), role + ': panel closes');
}

async function main() {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  /* ---- OWNER ---- */
  section('OWNER dashboard — Orbit AI');
  const ownerErr = [];
  let { ctx, page } = await setupPage(browser, 'owner', ownerErr);
  await bootDash(page, base, 'owner-dashboard.html');

  // Morning Brief: prefetched on login → notification dot on launcher
  await page.waitForFunction(() => !!document.getElementById('oaiDot'), { timeout: 5000 }).catch(() => {});
  ok(await page.$('#oaiDot'), 'owner: morning-brief notification dot appears on launcher after login');
  ok(await page.evaluate(() => window.__ORBIT_BRIEF_CALLED === true), 'owner: morning brief was fetched on login (owner only)');

  // Open → brief shown as first bot message; dot clears
  await page.click('#oaiFab');
  await page.waitForTimeout(400);
  const briefText = await page.evaluate(() => {
    const bots = document.querySelectorAll('.oai-msg.oai-bot .oai-msg-in');
    return Array.from(bots).map((b) => b.textContent).join(' || ');
  });
  ok(/Good morning, Piyush/.test(briefText), 'owner: morning brief greets by name on first open');
  ok(/ACME/.test(briefText) && /4\.14 lakh|outstanding/.test(briefText), 'owner: brief includes real outstanding + slow-payer detail');
  ok(await page.evaluate(() => !document.getElementById('oaiDot')), 'owner: dot clears once brief is seen');
  // close so exercise() can re-open cleanly
  await page.click('#oaiClose'); await page.waitForTimeout(150);

  await exercise(page, 'owner');

  // navigate action: ask to create manual order → opens modal
  await page.click('#oaiFab'); await page.waitForTimeout(200);
  await page.fill('#oaiText', 'create a manual order');
  await page.click('#oaiSend');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => { const m = document.getElementById('manualModal'); return m && m.classList.contains('on'); }), 'owner: "create a manual order" opens + pre-fills the Manual Order modal');
  ok(await page.evaluate(() => (document.getElementById('mPickup') || {}).value === 'Indore'), 'owner: draft pre-fills pickup');
  ok(await page.evaluate(() => (document.getElementById('mFreight') || {}).value === '12000'), 'owner: draft pre-fills freight');
  ok(ownerErr.length === 0, 'owner: no console errors' + (ownerErr.length ? ' — ' + ownerErr.join(' | ') : ''));
  await ctx.close();

  /* ---- CUSTOMER ---- */
  section('CUSTOMER dashboard — Orbit AI');
  const custErr = [];
  ({ ctx, page } = await setupPage(browser, 'customer', custErr));
  await bootDash(page, base, 'dashboard.html');
  await page.waitForTimeout(400);
  // Fresh load must land on a real panel (not a blank '#home' screen)
  ok(await page.evaluate(() => !!document.querySelector('.dash-tab.on') && !!document.querySelector('.dash-panel.on')), 'customer: fresh load lands on a real tab/panel (no blank screen)');
  ok(await page.evaluate(() => !window.__ORBIT_BRIEF_CALLED), 'customer: morning brief is NOT fetched (owner-only)');
  ok(await page.evaluate(() => !document.getElementById('oaiDot')), 'customer: no morning-brief dot');
  // Proactive insight: panel open speaks first about the customer's shipment
  await page.click('#oaiFab');
  await page.waitForTimeout(500);
  const custProactive = await page.evaluate(() => Array.from(document.querySelectorAll('.oai-msg.oai-bot .oai-msg-in')).map((b) => b.textContent));
  ok(custProactive.some((t) => /Welcome back/i.test(t)), 'customer: Orbit AI proactively greets with shipment status (no question needed)');
  ok(await page.evaluate(() => (window.__ORBIT_INSIGHT_CALLED || 0) >= 1), 'customer: proactive insight was fetched on open');
  // Learning across visits: reload (new session), same shipment state →
  // "no changes since your last visit" instead of repeating the status.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!document.getElementById('orbitAiRoot'), { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#oaiFab'); await page.waitForTimeout(450);
  const repeat = await page.evaluate(() => Array.from(document.querySelectorAll('.oai-msg.oai-bot .oai-msg-in')).map((b) => b.textContent));
  ok(repeat.some((t) => /No changes since your last visit/i.test(t)), 'customer: repeat visit with no change says "no changes" (no fatigue)');
  await page.click('#oaiClose'); await page.waitForTimeout(150);
  await exercise(page, 'customer');

  // navigate action: "where is my shipment" → switches to tracking tab + tracks
  await page.click('#oaiFab'); await page.waitForTimeout(200);
  await page.fill('#oaiText', 'where is my shipment');
  await page.click('#oaiSend');
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => document.getElementById('panel-tracking').classList.contains('on')), 'customer: "where is my shipment" navigates to the Tracking tab');
  ok(custErr.length === 0, 'customer: no console errors' + (custErr.length ? ' — ' + custErr.join(' | ') : ''));
  await ctx.close();

  /* ---- responsive ---- */
  section('Responsive — mobile viewport');
  const rErr = [];
  ({ ctx, page } = await setupPage(browser, 'owner', rErr));
  await bootDash(page, base, 'owner-dashboard.html');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#oaiFab');
  await page.waitForTimeout(250);
  const fits = await page.evaluate(() => { const p = document.getElementById('oaiPanel').getBoundingClientRect(); return p.width <= 390 && p.left >= -1; });
  ok(fits, 'panel fits mobile viewport (390px)');
  await ctx.close();

  await browser.close();
  srv.close();

  console.log('\n' + '='.repeat(56));
  console.log('  ORBIT AI UI RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL ORBIT AI UI CHECKS PASSED.');
}
main().catch((e) => { console.error('HARNESS ERROR:', e.stack); process.exit(2); });

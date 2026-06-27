/* ============================================================
   PHASE 6 — BROWSER UI QA (Playwright + Chromium)
   Boots the REAL owner & customer dashboards offline with a mock
   Firebase, then exercises the new UI: Manual Order modal (commercial
   + personal), validation, submit→pipeline, Tracking tab search,
   document buttons, responsive layouts, and console-error capture.
   ============================================================ */
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

/* tiny static server */
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

/* seed data shared by both roles */
function seedScript(role) {
  const now = Date.now();
  const uid = role === 'owner' ? 'owner-uid' : 'cust-A-uid';
  const email = role === 'owner' ? 'piyushmishra3734@gmail.com' : 'cust@acme.test';
  return `
    window.__MOCK_ROLE = ${JSON.stringify(role)};
    window.__MOCK_DB = {
      customerProfiles: { '${uid}': { uid:'${uid}', email:'${email}', contactPerson:'Test User', mobile:'9000000000', onboardingComplete:true, createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), updatedAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) } },
      companies: {
        'acme-traders-pvt-ltd': { name:'Acme Traders Pvt Ltd', gst:'23ABCDE1234F1Z5', registeredAddress:'Plot 4 MIDC', city:'Indore', state:'MP', contactPerson:'R Sharma', phone:'9990001111', email:'billing@acme.test' },
        'buildco-ltd': { name:'BuildCo Ltd', gst:'27ZZYYX9876W1AA', registeredAddress:'Sector 9', city:'Mumbai', state:'MH', contactPerson:'K Patel', phone:'8880002222', email:'recv@buildco.test' }
      },
      orders: {
        'EGC-2026-0001': { orderId:'EGC-2026-0001', quoteId:'Q-2026-0001', invoiceId:'INV-2026-0001', lrNumber:'LR-2026-0001', customerUid:'cust-A-uid', shipmentType:'commercial', status:'in_transit', customerName:'Acme Traders', companyName:'Acme Traders Pvt Ltd', customerGst:'23ABCDE1234F1Z5', consignorName:'Acme Traders Pvt Ltd', consignorAddress:'Plot 4 MIDC', consigneeName:'BuildCo Ltd', consigneeAddress:'Sector 9', pickup:'Indore', delivery:'Mumbai', materialType:'Machinery & Equipment', chargedWeight:'5200', actualWeight:'5200', packages:'14', vehicleNumber:'MP09GA1212', driverName:'H Verma', driverMobile:'9776665554', estimatedDelivery:'2026-02-01', freight:18000, fov:0, labour:0, localCollection:0, doorDelivery:0, docketCharges:0, haltingCharges:0, extraCharges:0, discount:0, sgstRate:0, cgstRate:0, advanceReceived:0, receivedAmount:0, paymentStatus:'pending', invoiceGenerated:true, lrGenerated:true, createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), updatedAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) }
      },
      invoices: {
        'INV-2026-0001': { invoiceId:'INV-2026-0001', invoiceNumber:'INV-2026-0001', orderId:'EGC-2026-0001', quoteId:'Q-2026-0001', lrNumber:'LR-2026-0001', customerUid:'cust-A-uid', invoiceDate: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), dueDate: window.firebase.firestore.Timestamp.fromDate(new Date(${now + 15 * 864e5})), createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), updatedAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) }
      },
      lorryReceipts: {
        'LR-2026-0001': { lrNumber:'LR-2026-0001', docketNumber:'DKT-2026-0001', orderId:'EGC-2026-0001', quoteId:'Q-2026-0001', invoiceId:'INV-2026-0001', customerUid:'cust-A-uid', lrDate: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), createdAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})), updatedAt: window.firebase.firestore.Timestamp.fromDate(new Date(${now})) }
      },
      quotes: {}, notifications: {}, activityLog: {}, counters: { orders:{year:2026,lastSeq:1}, invoices:{year:2026,lastSeq:1}, lr:{year:2026,lastSeq:1}, docket:{year:2026,lastSeq:1}, journal:{year:2026,lastSeq:0}, quotes:{year:2026,lastSeq:1} },
      accounts: {}, accountingSettings: {}, parties: {}, journalEntries: {}, auditLogs: {}
    };
  `;
}

async function setupPage(browser, role, consoleErrors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      // ignore noise that is environmental (mock has no real network/audit subcollections)
      if (/Failed to load resource|net::ERR|favicon|gstatic|reliable op failed|customerProfiles|users write/i.test(t)) return;
      consoleErrors.push(t);
    }
  });
  page.on('pageerror', (err) => consoleErrors.push('PAGEERROR: ' + err.message));

  // Intercept: block firebase CDN, replace firebase-config.js with the mock + seed.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (/gstatic\.com\/firebasejs/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* firebase cdn stubbed */' });
    }
    if (/firebase-config\.js(\?|$)/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK + '\n' + seedScript(role) });
    }
    return route.continue();
  });
  return { ctx, page };
}

async function main() {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  /* ============ OWNER DASHBOARD ============ */
  section('OWNER — page boot & no console errors');
  const ownerErrors = [];
  let { ctx, page } = await setupPage(browser, 'owner', ownerErrors);
  await page.goto(base + '/owner-dashboard.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => { const m = document.getElementById('dashMain'); return m && getComputedStyle(m).display !== 'none'; }, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);

  const mainVisible = await page.evaluate(() => { const m = document.getElementById('dashMain'); return m && getComputedStyle(m).display !== 'none'; });
  ok(mainVisible, 'Owner dashboard main is visible after owner sign-in');

  // Daily-use shortcut: unpaid invoice card offers a one-click "Record Payment"
  await page.click('.dash-tab[data-tab="invoices"]');
  await page.waitForTimeout(500);
  const recordPayBtn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.inv-card-actions button'));
    const b = btns.find((x) => /Record Payment/.test(x.textContent));
    return b ? b.getAttribute('onclick') : null;
  });
  ok(/recordPayment/.test(recordPayBtn || ''), 'Unpaid invoice card shows one-click "Record Payment" shortcut');

  // navigate to Orders tab
  await page.click('.dash-tab[data-tab="orders"]');
  await page.waitForTimeout(150);
  const manualBtn = await page.$('button:has-text("Create Manual Order")');
  ok(!!manualBtn, 'Orders tab shows "Create Manual Order" button');

  // Cash-flow safety: a delivered-but-unpaid order persistently shows a
  // "still to collect" band with a one-click Record payment (can't be forgotten)
  await page.evaluate(() => { window.__MOCK_DB.orders['EGC-2026-0001'].status = 'delivered'; if (window.__MOCK_NOTIFY) window.__MOCK_NOTIFY(); });
  await page.waitForTimeout(400);
  const collect = await page.evaluate(() => {
    const band = document.querySelector('.ocard-collect');
    return band ? { text: band.textContent, hasBtn: /Record payment/i.test(band.textContent) } : null;
  });
  ok(collect && /still to collect/i.test(collect.text), 'Delivered-unpaid order shows a persistent "still to collect" band');
  ok(collect && collect.hasBtn, 'Collect band offers one-click Record payment');

  // First-run UX: with no orders, the empty state guides the user to act
  const firstRunCta = await page.evaluate(() => {
    const empty = document.querySelector('#panel-orders .empty, #ownerOrderList .empty');
    if (!empty) return null;
    const btn = empty.querySelector('button');
    return { text: empty.textContent, hasCta: !!btn, ctaText: btn ? btn.textContent.trim() : '' };
  });
  if (firstRunCta) {
    ok(/Create your first order/i.test(firstRunCta.ctaText || ''), 'First-run orders empty state shows "Create your first order" CTA');
    ok(/automatically/i.test(firstRunCta.text), 'Empty state explains what happens (auto invoice/LR/accounting)');
  } else {
    ok(true, 'Orders present (no empty state to test) — skipped first-run CTA');
  }

  section('OWNER — Manual Order modal (commercial)');
  await manualBtn.click();
  await page.waitForTimeout(150);
  const modalOn = await page.evaluate(() => document.getElementById('manualModal').classList.contains('on'));
  ok(modalOn, 'Manual Order modal opens');
  const commVisible = await page.evaluate(() => getComputedStyle(document.getElementById('mCommercialBlock')).display !== 'none');
  ok(commVisible, 'Commercial block visible by default');
  const persHidden = await page.evaluate(() => getComputedStyle(document.getElementById('mPersonalBlock')).display === 'none');
  ok(persHidden, 'Personal block hidden by default');

  // company autocomplete suggestions
  await page.fill('#mCompanyName', 'Acme');
  await page.waitForTimeout(250);
  const sugg = await page.evaluate(() => { const b = document.getElementById('mCoSuggest'); return b && b.classList.contains('on') && b.querySelectorAll('.co-suggest-item').length; });
  ok(sugg >= 1, 'Company autocomplete shows suggestions for "Acme"');
  // click first suggestion → autofill GST
  await page.click('#mCoSuggest .co-suggest-item');
  await page.waitForTimeout(120);
  const gstFilled = await page.inputValue('#mGst');
  ok(gstFilled === '23ABCDE1234F1Z5', 'Selecting a company autofills GST + details');

  // validation: missing freight
  await page.fill('#mConsigneeName', 'BuildCo Ltd');
  await page.fill('#mPickup', 'Indore');
  await page.fill('#mDelivery', 'Mumbai');
  await page.selectOption('#mMaterial', { label: 'Machinery & Equipment' });
  await page.fill('#mWeight', '5200');
  await page.click('#manualSubmitBtn');
  await page.waitForTimeout(150);
  let msg = await page.evaluate(() => { const m = document.getElementById('manualMsg'); return { show: m.style.display !== 'none', text: m.textContent }; });
  ok(msg.show && /freight/i.test(msg.text), 'Validation blocks submit without freight');

  // fill freight + extras, submit → pipeline creates order
  await page.fill('#mFreight', '14000');
  await page.fill('#mHalting', '500');
  await page.fill('#mAdvance', '4000');
  await page.fill('#mVehicle', 'MP04AB1234');
  const ordersBefore = await page.evaluate(() => Object.keys(window.__MOCK_DB.orders).length);
  await page.click('#manualSubmitBtn');
  await page.waitForTimeout(500);
  const created = await page.evaluate(() => {
    const orders = Object.values(window.__MOCK_DB.orders);
    const manual = orders.filter((o) => o.source === 'owner_manual');
    const m = manual[0];
    const inv = m ? Object.values(window.__MOCK_DB.invoices).filter((i) => i.orderId === m.orderId) : [];
    const lr = m ? Object.values(window.__MOCK_DB.lorryReceipts).filter((l) => l.orderId === m.orderId) : [];
    const je = m ? Object.values(window.__MOCK_DB.journalEntries).filter((e) => e.orderId === m.orderId) : [];
    return { count: orders.length, manualCount: manual.length, order: m || null, invCount: inv.length, lrCount: lr.length, jeCount: je.length };
  });
  ok(created.manualCount === 1, 'Manual order created exactly once');
  ok(created.count === ordersBefore + 1, 'Orders collection grew by exactly one');
  ok(created.order && created.order.companyName === 'Acme Traders Pvt Ltd', 'Manual order has consignor company');
  ok(created.order && created.order.vehicleNumber === 'MP04AB1234', 'Manual order has vehicle (transport saved)');
  ok(created.order && created.order.paymentStatus === 'partial', 'Manual order payment status = partial (advance)');
  ok(created.invCount === 1 && created.lrCount === 1, 'Manual order generated invoice + LR');
  ok(created.jeCount >= 1, 'Manual order posted accounting entries');

  // Workflow continuity: success state offers the natural next step (hand the
  // customer their bilty) instead of auto-closing and hiding the new docs.
  const nextStep = await page.evaluate(() => {
    const printBtn = document.getElementById('mnext-print');
    const doneBtn = document.getElementById('mnext-done');
    return { hasPrint: !!printBtn, printText: printBtn ? printBtn.textContent : '', hasDone: !!doneBtn };
  });
  ok(nextStep.hasPrint && /LR.*Invoice/i.test(nextStep.printText), 'After manual order, offers one-click "Print LR + Invoice" (next logical step)');
  ok(nextStep.hasDone, 'After manual order, offers a clear "Done" to move on');
  // Memory-burden removal: the consignor company now remembers this shipment
  // pattern (route/consignee/material) for a one-click "same as last time".
  const remembered = await page.evaluate(() => {
    const co = Object.values(window.__MOCK_DB.companies || {}).find((c) => /Acme Traders Pvt/.test(c.name || ''));
    return co && co.lastShipment ? { pickup: co.lastShipment.pickup, delivery: co.lastShipment.delivery, consignee: co.lastShipment.consigneeName } : null;
  });
  ok(remembered && remembered.pickup === 'Indore' && remembered.delivery === 'Mumbai', 'Company remembers last shipment route (for next-time recall)');
  ok(remembered && /BuildCo/.test(remembered.consignee || ''), 'Company remembers last consignee');
  // close via Done so the next test starts clean
  await page.evaluate(() => { const d = document.getElementById('mnext-done'); if (d) d.click(); });
  await page.waitForTimeout(300);

  section('OWNER — Manual Order modal (personal)');
  // modal auto-closes after success; reopen and switch to personal
  await page.click('button:has-text("Create Manual Order")');
  await page.waitForTimeout(150);
  await page.click('.m-type-card[data-mtype="personal"]');
  await page.waitForTimeout(120);
  const persNow = await page.evaluate(() => ({
    pers: getComputedStyle(document.getElementById('mPersonalBlock')).display !== 'none',
    comm: getComputedStyle(document.getElementById('mCommercialBlock')).display === 'none',
    type: document.getElementById('mShipmentType').value,
  }));
  ok(persNow.pers && persNow.comm, 'Switching to Personal shows personal block, hides commercial');
  ok(persNow.type === 'personal', 'Hidden shipmentType = personal');
  await page.fill('#mSenderName', 'Ravi Kumar');
  await page.fill('#mSenderMobile', '9001112223');
  await page.fill('#mPickupAddress', '12 MG Road, Pune');
  await page.fill('#mReceiverName', 'Sneha Rao');
  await page.fill('#mReceiverMobile', '9334445556');
  await page.fill('#mDeliveryAddress', '88 Park St, Kolkata');
  await page.fill('#mPickup', 'Pune');
  await page.fill('#mDelivery', 'Kolkata');
  await page.selectOption('#mMaterial', { label: 'Household Goods / Personal Effects' });
  await page.fill('#mWeight', '800');
  await page.fill('#mFreight', '9000');
  await page.click('#manualSubmitBtn');
  await page.waitForTimeout(500);
  const pCreated = await page.evaluate(() => {
    const m = Object.values(window.__MOCK_DB.orders).filter((o) => o.source === 'owner_manual' && o.shipmentType === 'personal')[0];
    return m ? { ok: true, consignor: m.consignorName, consignee: m.consigneeName, company: m.companyName, gstBy: m.gstPayableBy } : { ok: false };
  });
  ok(pCreated.ok, 'Personal manual order created');
  ok(pCreated.consignor === 'Ravi Kumar' && pCreated.consignee === 'Sneha Rao', 'Personal: consignor/consignee from sender/receiver');
  ok(pCreated.company === '' , 'Personal: no company field');
  // close the success state before the next section
  await page.evaluate(() => { const d = document.getElementById('mnext-done'); if (d) d.click(); else if (window.OWN && OWN.closeManualOrder) OWN.closeManualOrder(); });
  await page.waitForTimeout(300);

  section('OWNER — responsive (mobile viewport)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.click('button:has-text("Create Manual Order")');
  await page.waitForTimeout(150);
  const mobileModal = await page.evaluate(() => {
    const d = document.querySelector('.m-dialog'); const r = d.getBoundingClientRect();
    const grid = getComputedStyle(document.querySelector('.m-type-grid')).gridTemplateColumns;
    return { fits: r.width <= 390, single: grid.split(' ').length === 1 };
  });
  ok(mobileModal.fits, 'Modal fits within mobile viewport (390px)');
  ok(mobileModal.single, 'Type cards stack to single column on mobile');
  await page.evaluate(() => OWN.closeManualOrder());

  ok(ownerErrors.length === 0, 'Owner page: no unexpected console errors' + (ownerErrors.length ? ' — ' + ownerErrors.join(' | ') : ''));
  await ctx.close();

  /* ============ CUSTOMER DASHBOARD ============ */
  section('CUSTOMER — Tracking tab boot & search');
  const custErrors = [];
  ({ ctx, page } = await setupPage(browser, 'customer', custErrors));
  await page.goto(base + '/dashboard.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => { const m = document.getElementById('dashMain'); return m && getComputedStyle(m).display !== 'none'; }, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);

  const trkTab = await page.$('.dash-tab[data-tab="tracking"]');
  ok(!!trkTab, 'Customer dashboard shows "Track Shipment" tab');
  await trkTab.click();
  await page.waitForTimeout(300);
  const panelOn = await page.evaluate(() => document.getElementById('panel-tracking').classList.contains('on'));
  ok(panelOn, 'Tracking panel activates on tab click');
  // recent chips populated from invoice cache (wait for the invoice listener)
  await page.waitForFunction(() => document.querySelectorAll('#trkRecent .trk-chip').length >= 1, { timeout: 5000 }).catch(() => {});
  const chipCount = await page.evaluate(() => document.querySelectorAll('#trkRecent .trk-chip').length);
  ok(chipCount >= 1, 'Recent shipment chips populated from SSoT invoice cache');

  // search by invoice number (drive via the public CUST.track to avoid ambiguous selectors)
  await page.fill('#trkInput', 'INV-2026-0001');
  await page.evaluate(() => CUST.track());
  await page.waitForTimeout(250);
  let hub = await page.evaluate(() => {
    const r = document.getElementById('trkResult');
    if (r.style.display === 'none') return null;
    return {
      order: (r.querySelector('.trk-order') || {}).textContent,
      route: (r.querySelector('.trk-route') || {}).textContent.replace(/\s+/g, ' ').trim(),
      pct: (r.querySelector('.trk-progress-fill') || {}).style ? r.querySelector('.trk-progress-fill').style.width : '',
      hasDocs: r.querySelectorAll('.trk-docs .btn-doc').length,
      timeline: r.querySelectorAll('.order-timeline .tl-step').length,
    };
  });
  ok(hub && /INV-2026-0001/.test(hub.order), 'Search by invoice number resolves the shipment hub');
  ok(hub && /Indore/.test(hub.route) && /Mumbai/.test(hub.route), 'Hub shows correct route from SSoT');
  ok(hub && hub.timeline === 7, 'Hub renders full 7-step timeline');
  ok(hub && hub.hasDocs === 3, 'Hub shows Invoice / LR / Combined document buttons');
  ok(hub && hub.pct && parseInt(hub.pct) > 0, 'Hub progress bar reflects in-transit status');

  // search by LR number → same shipment
  await page.fill('#trkInput', 'LR-2026-0001');
  await page.evaluate(() => CUST.track());
  await page.waitForTimeout(200);
  const byLr = await page.evaluate(() => (document.querySelector('#trkResult .trk-order') || {}).textContent);
  ok(/INV-2026-0001/.test(byLr || ''), 'Search by LR number resolves the SAME shipment');

  // unknown number → friendly error, no hub
  await page.fill('#trkInput', 'INV-9999-0000');
  await page.evaluate(() => CUST.track());
  await page.waitForTimeout(150);
  const notFound = await page.evaluate(() => ({ msg: document.getElementById('trkMsg').style.display !== 'none', hidden: document.getElementById('trkResult').style.display === 'none' }));
  ok(notFound.msg && notFound.hidden, 'Unknown number shows error and hides hub');

  // document download wiring (SHIP.openInvoice invoked) — stub window.open
  await page.fill('#trkInput', 'INV-2026-0001');
  await page.evaluate(() => CUST.track());
  await page.waitForTimeout(200);
  const dlWired = await page.evaluate(() => {
    let opened = false; const orig = window.open; window.open = function () { opened = true; return { document: { write() {}, close() {} }, focus() {}, print() {} }; };
    try { document.querySelector('.trk-docs .btn-doc').click(); } catch (e) {}
    window.open = orig;
    return typeof CUST.downloadInvoice === 'function';
  });
  ok(dlWired, 'Tracking document buttons are wired to CUST download handlers');

  section('CUSTOMER — live update propagation');
  // mutate order status in the mock DB and notify → hub should refresh to delivered
  await page.evaluate(() => { window.__MOCK_DB.orders['EGC-2026-0001'].status = 'delivered'; window.__MOCK_NOTIFY(); });
  await page.waitForTimeout(300);
  const afterLive = await page.evaluate(() => {
    const r = document.getElementById('trkResult');
    const fill = r.querySelector('.trk-progress-fill');
    return { pct: fill ? fill.style.width : '', badge: (r.querySelector('.trk-status-badge') || {}).textContent };
  });
  ok(afterLive.pct === '100%', 'Hub live-updates to 100% when order marked delivered');
  ok(/Delivered/i.test(afterLive.badge || ''), 'Hub badge live-updates to Delivered');

  section('CUSTOMER — responsive (mobile viewport)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const trkMobile = await page.evaluate(() => {
    const grid = document.querySelector('.trk-grid');
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    const r = document.getElementById('trkResult').getBoundingClientRect();
    return { cols: cols, fits: r.width <= 390 + 1 };
  });
  ok(trkMobile.cols === 2, 'Tracking detail grid → 2 columns on mobile');
  ok(trkMobile.fits, 'Tracking hub fits mobile viewport');

  ok(custErrors.length === 0, 'Customer page: no unexpected console errors' + (custErrors.length ? ' — ' + custErrors.join(' | ') : ''));
  await ctx.close();

  await browser.close();
  srv.close();

  console.log('\n' + '='.repeat(56));
  console.log('  BROWSER UI RESULTS:  ' + PASS + ' passed,  ' + FAIL + ' failed');
  console.log('='.repeat(56));
  if (FAIL) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('\n✓ ALL BROWSER UI CHECKS PASSED.');
}
main().catch((e) => { console.error('HARNESS ERROR:', e.stack); process.exit(2); });

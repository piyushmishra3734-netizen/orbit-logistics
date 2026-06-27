/* ============================================================
   LR.JS — Orbit Logistics Lorry Receipt (LR / Bilty / GR)
   Express Goods Carrier platform · shared by customer + owner

   DESIGN PRINCIPLE
   ----------------
   The LR is the SECOND document of the same Orbit document suite.
   It does NOT redefine branding, the logo, the signature, the header,
   the footer, company info or bank details. It reuses the approved
   assets already shipped in invoice.js:

     window.INV.BRAND            — company name / phones / email / GST …
     window.INV.DEFAULT_CONFIG   — signature, bank details, terms
     window.INV.loadConfig()     — owner-editable config (single Firestore doc)
     window.INV.orbitLogoSVG()   — approved logo (base64, identical)
     window.INV.fmtMoney / toNum / amountInWords / fmtDMY

   The ONLY new work here is the LR layout, its transport data mapping,
   its dedicated watermark, and the LR + combined PDF rendering.

   Depends on: window.INV (invoice.js), window.EGC (phase3-core.js),
               fbDB, firebase
   ============================================================ */

(function () {
  'use strict';

  if (!window.INV) {
    console.error('[LR] invoice.js (window.INV) must load before lr.js');
  }

  window.LR = window.LR || {};

  /* Re-export the shared helpers so LR code reads cleanly and we never
     accidentally re-implement (or drift from) the invoice versions. */
  var toNum         = window.INV.toNum;
  var fmtMoney      = window.INV.fmtMoney;
  var amountInWords = window.INV.amountInWords;
  var fmtDMY        = window.INV.fmtDMY;
  var BRAND         = window.INV.BRAND;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ----------------------------------------------------------
     LR NUMBER
     invoice.js already owns the canonical generator (INV.nextLrNumber)
     so the LR number stays in lock-step with the order/invoice.
     We simply alias it — no second counter, no collisions.
  ---------------------------------------------------------- */
  window.LR.nextLrNumber = window.INV.nextLrNumber;

  /* Convenience: money formatter that always renders (incl. zero). */
  window.LR.fmtMoneyOrZero = function (v) { return fmtMoney(v || 0); };

  /* Docket number — short human-friendly transport reference, derived
     from a dedicated counter so it never clashes with the LR number. */
  window.LR.nextDocketNumber = function () {
    var ref = fbDB.collection('counters').doc('docket');
    return fbDB.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var data = snap.exists ? snap.data() : null;
        var seq  = (data && data.lastSeq ? data.lastSeq : 1000) + 1;
        tx.set(ref, { lastSeq: seq }, { merge: true });
        return String(seq);
      });
    });
  };

  /* ----------------------------------------------------------
     LR CHARGE TOTALS — single source of truth for LR maths.
     Mirrors the reference LR's FREIGHT & CHARGES block.
     Accounting-ready: every component is a flat numeric field.
  ---------------------------------------------------------- */
  window.LR.computeTotals = function (lr) {
    /* SINGLE TOTALS ENGINE: delegate to SHIP.computeCharges so the LR and
       the invoice ALWAYS total identically from the same order. Previously
       this had its own math that omitted halting/extra charges and ignored
       discount, causing the printed LR grand total to disagree with the
       invoice for any discounted or multi-charge shipment. */
    if (window.SHIP && window.SHIP.computeCharges) {
      var c = window.SHIP.computeCharges(lr);
      return {
        subTotal:   c.subTotal,
        discount:   c.discount,
        sgst:       c.sgst,
        cgst:       c.cgst,
        grandTotal: c.grandTotal
      };
    }
    /* Fallback (SHIP not loaded) — mirror the canonical formula exactly. */
    var freight        = toNum(lr.freight);
    var fov            = toNum(lr.fov);
    var labour         = toNum(lr.labour);
    var localCollection= toNum(lr.localCollection);
    var doorDelivery   = toNum(lr.doorDelivery);
    var docketCharges  = toNum(lr.docketCharges);
    var halting        = toNum(lr.haltingCharges);
    var extra          = toNum(lr.extraCharges);
    var discount       = toNum(lr.discount);

    var subTotal = freight + fov + labour + localCollection + doorDelivery + docketCharges + halting + extra;
    var taxable  = subTotal - discount;

    var sgstRate = toNum(lr.sgstRate);
    var cgstRate = toNum(lr.cgstRate);
    var sgst = taxable * sgstRate / 100;
    var cgst = taxable * cgstRate / 100;

    var grandTotal = taxable + sgst + cgst;

    return {
      subTotal:   subTotal,
      discount:   discount,
      sgst:       sgst,
      cgst:       cgst,
      grandTotal: grandTotal
    };
  };

  /* ----------------------------------------------------------
     PAYMENT STATUS — reuse the invoice vocabulary so both
     documents speak the same language across the platform.
  ---------------------------------------------------------- */
  window.LR.paymentLabel = window.INV.paymentLabel;
  window.LR.paymentClass = window.INV.paymentClass;
  window.LR.effectiveStatus = function (lr) {
    /* LR mirrors the invoice's payment status; fall back gracefully. */
    return lr.paymentStatus || 'pending';
  };

  /* ----------------------------------------------------------
     BUILD LR RECORD from quote + order (+ the invoice we just built)
     Auto-populates every transport field the platform already knows.
     Owner-supplied fields (vehicle, driver, weights…) are nullable and
     editable later — never blocking at creation time.

     The structure is intentionally FLAT and accounting-ready so it can
     feed Accounting / Excel / Reports later with no redesign.
  ---------------------------------------------------------- */
  window.LR.buildRecord = function (opts) {
    /* opts: { lrNumber, docketNumber, order, quote, invoice } */
    var order   = opts.order   || {};
    var quote   = opts.quote   || {};
    var invoice = opts.invoice || {};
    var now     = new Date();

    var shipmentType = order.shipmentType || quote.shipmentType || 'commercial';
    var isPersonal   = shipmentType === 'personal';

    /* Freight defaults to the agreed price (same source the invoice uses). */
    var freight = toNum(order.revisedPrice || quote.revisedPrice || invoice.freightCharges || 0);

    var rec = {
      /* identity + links (every doc belongs to the same Order) */
      lrNumber:      opts.lrNumber,
      docketNumber:  opts.docketNumber || null,
      orderId:       order.orderId   || invoice.orderId   || null,
      quoteId:       order.quoteId   || quote.quoteId     || null,
      invoiceId:     invoice.invoiceId || order.invoiceId || null,
      customerUid:   order.customerUid || quote.customerUid || null,

      /* shipment classification */
      shipmentType:  shipmentType,                 /* personal | commercial */

      /* ── CONSIGNOR (From) ── */
      consignorName:    order.consignorName ||
                          (isPersonal
                            ? (quote.senderName || order.customerName || '')
                            : (order.companyName || quote.companyName || order.customerName || '')),
      consignorAddress: order.consignorAddress || quote.registeredAddress || quote.pickupAddress || order.pickup || quote.pickup || '',
      consignorContact: order.consignorContact || (isPersonal ? (quote.senderMobile || quote.customerPhone || '') : (quote.companyMobile || quote.customerPhone || order.customerPhone || '')),
      consignorContactPerson: order.consignorContactPerson || (isPersonal ? '' : (quote.contactPerson || '')),
      consignorEmail:   order.consignorEmail || (isPersonal ? (quote.senderEmail || '') : (quote.companyEmail || order.customerEmail || '')),
      consignorGstin:   order.consignorGstin || (isPersonal ? '' : (quote.customerGst || order.customerGst || '')),

      /* ── CONSIGNEE (To) ── */
      consigneeName:    order.consigneeName || (isPersonal ? (quote.receiverName || '') : (quote.consigneeName || '')),
      consigneeAddress: order.consigneeAddress || quote.consigneeAddress || quote.deliveryAddress || order.delivery || quote.delivery || '',
      consigneeContact: order.consigneeContact || (isPersonal ? (quote.receiverMobile || '') : (quote.consigneeContact || '')),
      consigneeContactPerson: order.consigneeContactPerson || (isPersonal ? '' : (quote.consigneeContactPerson || '')),
      consigneeEmail:   order.consigneeEmail || (isPersonal ? (quote.receiverEmail || '') : (quote.consigneeEmail || '')),
      consigneeGstin:   order.consigneeGstin || quote.consigneeGstin || '',

      /* ── ROUTE ── */
      fromLocation:  order.pickup   || quote.pickup   || '',
      toLocation:    order.delivery || quote.delivery || '',
      lrDate:        firebase.firestore.Timestamp.fromDate(now),

      /* ── CONSIGNMENT (owner-editable) ── */
      packageCount:    order.packages || quote.packages || '',
      packingMethod:   quote.packingMethod || 'BUNDLES',
      materialDescription: order.materialType || quote.materialType || quote.material || '',
      actualWeight:    order.weight || quote.weight || quote.approxWeight || '',
      chargedWeight:   order.weight || quote.weight || quote.approxWeight || '',

      /* ── VEHICLE / DRIVER (owner fills at dispatch) ── */
      vehicleNumber: order.vehicleNumber || '',
      driverName:    '',
      driverMobile:  '',
      transportMode: 'Road',
      dispatchMode:  'Door',

      /* ── FREIGHT & CHARGES (freight auto; rest 0, owner-editable) ── */
      freight:         freight,
      fov:             0,
      labour:          0,
      localCollection: 0,
      doorDelivery:    0,
      docketCharges:   0,
      sgstRate:        0,
      cgstRate:        0,

      /* ── EXTRAS ── */
      specialInstructions: quote.specialInstructions || quote.notes || order.notes || '',
      insuranceDetails:    '',
      remarks:             '',
      ewayBill:            order.ewayBill || '',
      gstPayableBy:        isPersonal ? 'Consignor' : 'Consignee',

      /* ── PAYMENT (mirrors invoice; accounting-ready) ── */
      paymentStatus: invoice.paymentStatus || 'pending',

      /* ── SNAPSHOTS for Accounting / Excel / Reports ── */
      grandTotalAmount: freight,   /* refreshed below via computeTotals */

      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    var t = window.LR.computeTotals(rec);
    rec.grandTotalAmount = t.grandTotal;
    return rec;
  };

  /* ----------------------------------------------------------
     LR WATERMARK — designed specifically for the Lorry Receipt.
     Distinct from the invoice watermark (different composition and
     a "LORRY RECEIPT" descriptor) but built from the SAME brand colours
     and the SAME approved logo so both documents feel like one suite.
     Centered · low opacity · behind all content · never overlaps text.
  ---------------------------------------------------------- */
  function lrWatermarkHTML() {
    /* Reuse the approved logo, rendered large + faint behind content. */
    var faintLogo = window.INV.orbitLogoSVG(440);
    return '' +
      '<div class="lr-wm">' +
        '<div class="lr-wm-logo">' + faintLogo + '</div>' +
        '<div class="lr-wm-text">LORRY RECEIPT</div>' +
      '</div>';
  }

  /* ----------------------------------------------------------
     RENDER A4 LR HTML — Orbit branded, white bg, print/PDF ready.
     Returns the INNER markup of one A4 page (so the same function can
     be embedded standalone OR as page 2 of the combined PDF).
  ---------------------------------------------------------- */
  function lrPageHTML(lr, config) {
    config = config || window.INV.DEFAULT_CONFIG;
    var t = window.LR.computeTotals(lr);
    var b = BRAND;

    var sigBlock = config.signatureUrl
      ? '<img src="' + esc(config.signatureUrl) + '" alt="Signature" class="sig-img"/>'
      : '<div class="sig-line"></div>';

    var termsHTML = (config.terms || window.INV.DEFAULT_CONFIG.terms).map(function (term, i) {
      return '<li><span class="tnum">' + (i + 1) + '.</span> ' + esc(term) + '</li>';
    }).join('');

    function chargeRow(label, val) {
      return '<div class="fc-row"><span class="fc-k">' + esc(label) + '</span><span class="fc-v">' + fmtMoney(val) + '</span></div>';
    }

    var isPersonal = lr.shipmentType === 'personal';

    return '' +
    lrWatermarkHTML() +
    '<div class="layer">' +
      /* ── HEADER (reuses approved logo + company contact block) ── */
      '<div class="lr-head">' +
        '<div class="logo-wrap">' + window.INV.orbitLogoSVG(190) + '</div>' +
        '<div class="brand-mid">' +
          '<h1><span class="o">ORBIT</span> LOGISTICS</h1>' +
          '<div class="brand-tag">' + esc(b.tagline) + '</div>' +
        '</div>' +
        '<div class="contact">' +
          '<div class="ct"><span class="ci">\u260E</span>' + esc(b.phones) + '</div>' +
          '<div class="ct"><span class="ci">\u2709</span>' + esc(b.email) + '</div>' +
          '<div class="ct"><span class="ci">\u25C9</span><span>' + esc(b.address) + '</span></div>' +
        '</div>' +
        '<div class="lr-badge">LORRY RECEIPT</div>' +
      '</div>' +

      /* ── GST BAR (identical band to the invoice) ── */
      '<div class="gstbar">' +
        '<span>GST : <b>' + esc(b.gst) + '</b></span><span class="sep">|</span>' +
        '<span>PAN : <b>' + esc(b.pan) + '</b></span><span class="sep">|</span>' +
        '<span>UDYAM Reg : <b>' + esc(b.udyam) + '</b></span>' +
      '</div>' +

      /* ── CONSIGNOR / CONSIGNEE / META (3-column) ── */
      '<div class="cc-row">' +
        '<div class="cc-box">' +
          '<div class="cc-h"><span class="dot">\u25CF</span> CONSIGNOR <span class="cc-sub">(From)</span></div>' +
          '<div class="cc-line"><span class="cc-k">Name</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consignorName || '\u2014') + '</span></div>' +
          (lr.consignorContactPerson ? '<div class="cc-line"><span class="cc-k">Contact Person</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consignorContactPerson) + '</span></div>' : '') +
          '<div class="cc-line"><span class="cc-k">Address</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consignorAddress || '\u2014') + '</span></div>' +
          '<div class="cc-line"><span class="cc-k">Contact</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consignorContact || '\u2014') + '</span></div>' +
          (isPersonal ? '' :
          '<div class="cc-line"><span class="cc-k">GSTIN</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consignorGstin || '\u2014') + '</span></div>') +
          '<div class="cc-rail">F R O M</div>' +
        '</div>' +
        '<div class="cc-box">' +
          '<div class="cc-h"><span class="dot">\u25CF</span> CONSIGNEE <span class="cc-sub">(To)</span></div>' +
          '<div class="cc-line"><span class="cc-k">Name</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consigneeName || '\u2014') + '</span></div>' +
          (lr.consigneeContactPerson ? '<div class="cc-line"><span class="cc-k">Contact Person</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consigneeContactPerson) + '</span></div>' : '') +
          '<div class="cc-line"><span class="cc-k">Address</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consigneeAddress || '\u2014') + '</span></div>' +
          '<div class="cc-line"><span class="cc-k">Contact</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consigneeContact || '\u2014') + '</span></div>' +
          (isPersonal ? '' :
          '<div class="cc-line"><span class="cc-k">GSTIN</span><span class="cc-c">:</span><span class="cc-v">' + esc(lr.consigneeGstin || '\u2014') + '</span></div>') +
          '<div class="cc-rail">T O</div>' +
        '</div>' +
        '<div class="cc-meta">' +
          '<div class="mblk"><span class="mk">LR No.</span><span class="mv hot">' + esc(lr.lrNumber || '\u2014') + '</span></div>' +
          '<div class="mblk"><span class="mk">Docket No.</span><span class="mv">' + esc(lr.docketNumber || '\u2014') + '</span></div>' +
          '<div class="mblk"><span class="mk">Date</span><span class="mv">' + fmtDMY(lr.lrDate) + '</span></div>' +
          '<div class="mblk"><span class="mk">From</span><span class="mv">' + esc((lr.fromLocation || '\u2014').toUpperCase()) + '</span></div>' +
          '<div class="mblk"><span class="mk">To</span><span class="mv">' + esc((lr.toLocation || '\u2014').toUpperCase()) + '</span></div>' +
          '<div class="mblk"><span class="mk">Vehicle No.</span><span class="mv hot">' + esc(lr.vehicleNumber || '\u2014') + '</span></div>' +
          '<div class="mblk"><span class="mk">Driver Name</span><span class="mv">' + esc(lr.driverName || '\u2014') + '</span></div>' +
          '<div class="mblk"><span class="mk">Driver Contact</span><span class="mv">' + esc(lr.driverMobile || '\u2014') + '</span></div>' +
          '<div class="mblk"><span class="mk">Transport Mode</span><span class="mv b">' + esc(lr.transportMode || 'Road') + '</span></div>' +
          (lr.ewayBill ? '<div class="mblk"><span class="mk">E-Way Bill</span><span class="mv hot">' + esc(lr.ewayBill) + '</span></div>' : '') +
        '</div>' +
      '</div>' +

      /* ── GOODS TABLE ── */
      '<table class="goods">' +
        '<thead><tr>' +
          '<th>NO. OF<br>PACKAGE</th><th>METHOD OF<br>PACKING</th>' +
          '<th>DESCRIPTION (SAID TO CONTAIN)</th>' +
          '<th>ACTUAL<br>WEIGHT</th><th>CHARGED<br>WEIGHT</th>' +
        '</tr></thead><tbody><tr>' +
          '<td>' + esc(lr.packageCount || '\u2014') + '</td>' +
          '<td>' + esc((lr.packingMethod || '\u2014').toUpperCase()) + '</td>' +
          '<td class="goods-desc">' + esc((lr.materialDescription || '\u2014').toUpperCase()) + '</td>' +
          '<td>' + (lr.actualWeight ? esc(lr.actualWeight) + ' KG' : '\u2014') + '</td>' +
          '<td>' + (lr.chargedWeight ? esc(lr.chargedWeight) + ' KG' : '\u2014') + '</td>' +
        '</tr></tbody>' +
      '</table>' +

      /* ── CHARGES + SIDE PANELS ── */
      '<div class="mid-row">' +
        /* LEFT: side panel (special instructions, dispatch, GST, payment) —
           matches the original Express Goods Carrier LR layout. */
        '<div class="side-col">' +
          '<div class="sp">' +
            '<div class="sp-h">SPECIAL INSTRUCTIONS</div>' +
            '<div class="sp-b">' + (lr.specialInstructions ? esc(lr.specialInstructions) : '&nbsp;') + '</div>' +
          '</div>' +
          '<div class="sp">' +
            '<div class="sp-hd">MODE OF DISPATCH</div>' +
            '<div class="sp-bc">' + esc(lr.dispatchMode || 'Door') + '</div>' +
          '</div>' +
          '<div class="sp">' +
            '<div class="sp-hd">GST TO BE PAID BY</div>' +
            '<div class="sp-bc">' + esc(lr.gstPayableBy || config.gstPayableBy || 'Consignee') + '</div>' +
          '</div>' +
          '<div class="sp">' +
            '<div class="sp-hd">PAYMENT STATUS</div>' +
            '<div class="sp-bc">' + esc(window.LR.paymentLabel(window.LR.effectiveStatus(lr))) + '</div>' +
          '</div>' +
          (lr.insuranceDetails ?
          '<div class="sp">' +
            '<div class="sp-hd">INSURANCE</div>' +
            '<div class="sp-bc small">' + esc(lr.insuranceDetails) + '</div>' +
          '</div>' : '') +
        '</div>' +
        /* RIGHT: Freight & Charges. */
        '<div class="fc-box">' +
          '<div class="fc-head"><span>FREIGHT &amp; CHARGES</span><span>AMOUNT (Rs.)</span></div>' +
          chargeRow('FREIGHT', lr.freight) +
          chargeRow('F.O.V', lr.fov) +
          chargeRow('LABOUR', lr.labour) +
          chargeRow('LOCAL COLLECTION', lr.localCollection) +
          chargeRow('DOOR DELIVERY', lr.doorDelivery) +
          chargeRow('DOCKET CHARGES', lr.docketCharges) +
          (toNum(lr.haltingCharges) ? chargeRow('HALTING CHARGES', lr.haltingCharges) : '') +
          (toNum(lr.extraCharges) ? chargeRow('EXTRA CHARGES', lr.extraCharges) : '') +
          '<div class="fc-row fc-total"><span class="fc-k">TOTAL</span><span class="fc-v">' + fmtMoney(t.subTotal) + '</span></div>' +
          (toNum(t.discount) ? '<div class="fc-row"><span class="fc-k">DISCOUNT</span><span class="fc-v">- ' + fmtMoney(t.discount) + '</span></div>' : '') +
          '<div class="fc-row"><span class="fc-k">SGST ' + esc(lr.sgstRate || 0) + '%</span><span class="fc-v">' + fmtMoney(t.sgst) + '</span></div>' +
          '<div class="fc-row"><span class="fc-k">CGST ' + esc(lr.cgstRate || 0) + '%</span><span class="fc-v">' + fmtMoney(t.cgst) + '</span></div>' +
          '<div class="fc-grand"><span>GRAND TOTAL</span><span>' + fmtMoney(t.grandTotal) + '</span></div>' +
        '</div>' +
      '</div>' +

      /* ── RECEIVED / TERMS / BANK / SIGNATURE ── */
      '<div class="foot3">' +
        '<div class="fcol">' +
          '<div class="fhead-strong">RECEIVED the above goods in good condition</div>' +
          '<div class="recv">' +
            '<div class="rl"><span class="rk">No. of Packages</span><span class="rc">:</span><span class="rv">' + esc(lr.packageCount || '\u2014') + '</span></div>' +
            '<div class="rl"><span class="rk">Goods Description</span><span class="rc">:</span><span class="rv">' + esc((lr.materialDescription || '\u2014').toUpperCase()) + '</span></div>' +
            '<div class="rl"><span class="rk">Total Weight</span><span class="rc">:</span><span class="rv">' + (lr.chargedWeight ? esc(lr.chargedWeight) + ' KG' : '\u2014') + '</span></div>' +
            '<div class="rl"><span class="rk">Vehicle No.</span><span class="rc">:</span><span class="rv">' + esc(lr.vehicleNumber || '\u2014') + '</span></div>' +
            '<div class="rl"><span class="rk">From</span><span class="rc">:</span><span class="rv">' + esc((lr.fromLocation || '\u2014').toUpperCase()) + '</span></div>' +
            '<div class="rl"><span class="rk">To</span><span class="rc">:</span><span class="rv">' + esc((lr.toLocation || '\u2014').toUpperCase()) + '</span></div>' +
          '</div>' +
          (lr.remarks ? '<div class="recv-note"><b>Remarks:</b> ' + esc(lr.remarks) + '</div>' : '') +
          '<div class="recv-agree">We hereby agree to pay all charges including octroi and taxes as applicable. Goods booked at owner\u2019s risk.</div>' +
        '</div>' +
        '<div class="fcol"><div class="fhead">\u25A4 TERMS &amp; CONDITIONS</div><ul class="terms">' + termsHTML + '</ul></div>' +
        '<div class="fcol">' +
          '<div class="fhead">\u25A4 BANK DETAILS</div>' +
          '<p>Bank Name : <b>' + esc(config.bankName) + '</b></p>' +
          '<p>Account Number : <b>' + esc(config.accountNumber) + '</b></p>' +
          '<p>IFSC Code : <b>' + esc(config.ifsc) + '</b></p>' +
          '<div class="sigrow">' +
            '<div class="sigbox"><div class="sig-for">For <b>ORBIT LOGISTICS</b></div>' + sigBlock +
              '<div class="sig-name">' + esc(config.signatoryName || 'Authorized Signatory') + '</div>' +
            '</div>' +
            '<div class="sealbox"><div class="seal-ring">COMPANY<br>SEAL / STAMP</div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      /* ── DELIVERY ACKNOWLEDGEMENT — filled & signed by the receiver on
         delivery. Left: receiver name / signature / seal. Right: date+time.
         Blank fields by design so it can be completed by hand after print. */
      '<div class="ackband">' +
        '<div class="ack-title">DELIVERY ACKNOWLEDGEMENT</div>' +
        '<div class="ack-grid">' +
          '<div class="ack-cell ack-wide">' +
            '<div class="ack-lbl">Receiver Name</div>' +
            '<div class="ack-fill"></div>' +
          '</div>' +
          '<div class="ack-cell ack-wide">' +
            '<div class="ack-lbl">Receiver Signature</div>' +
            '<div class="ack-fill"></div>' +
          '</div>' +
          '<div class="ack-cell ack-seal">' +
            '<div class="ack-lbl">Company Seal / Stamp</div>' +
            '<div class="ack-fill ack-fill-seal"></div>' +
          '</div>' +
        '</div>' +
        '<div class="ack-grid ack-grid-2">' +
          '<div class="ack-cell"><div class="ack-lbl">Date</div><div class="ack-fill ack-fill-sm"></div></div>' +
          '<div class="ack-cell"><div class="ack-lbl">Time</div><div class="ack-fill ack-fill-sm"></div></div>' +
          '<div class="ack-cell ack-note">Goods received in good condition and full quantity as described above.</div>' +
        '</div>' +
      '</div>' +
      '<div class="trust">' +
        '<div class="ti"><svg class="tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>SAFE &amp; SECURE<br>TRANSPORT</span></div>' +
        '<div class="ti"><svg class="tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg><span>ON TIME<br>EVERY TIME</span></div>' +
        '<div class="ti"><svg class="tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 11l3 3 2-3 3 3M2 12l4-4 3 3"/><path d="M14 8l4-4 4 4-4 4"/></svg><span>TRUSTED BY<br>BUSINESSES</span></div>' +
      '</div>' +
      '<div class="thanks">Thank you for your business!</div>' +
    '</div>';
  }
  window.LR.pageHTML = lrPageHTML;

  /* ----------------------------------------------------------
     SHARED CSS — LR page styling. Self-contained so it can be
     injected into a standalone LR window OR the combined document.
     Visual language (orange #f26522, fonts, trust row, sig box) is
     deliberately matched to the invoice so the two read as one suite.
  ---------------------------------------------------------- */
  function lrStyles() {
    return '' +
'*{margin:0;padding:0;box-sizing:border-box;}' +
'body{font-family:Arial,Helvetica,sans-serif;background:#e9ecf1;color:#1a1a1a;padding:20px;}' +
'.page{width:794px;min-height:1123px;margin:0 auto 20px;background:#fff;position:relative;padding:30px 34px;overflow:hidden;box-shadow:0 6px 30px rgba(0,0,0,.12);}' +
/* ── LR WATERMARK (centered, low opacity, behind everything) ── */
'.lr-wm{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100%;text-align:center;pointer-events:none;z-index:0;}' +
'.lr-wm-logo{opacity:.05;display:flex;justify-content:center;}' +
'.lr-wm-text{font-family:Arial,sans-serif;font-weight:800;font-size:62px;letter-spacing:14px;color:rgba(120,130,145,.06);margin-top:-30px;}' +
'.layer{position:relative;z-index:1;}' +
/* ── HEADER ── */
'.lr-head{display:flex;gap:14px;align-items:flex-start;position:relative;padding-bottom:10px;}' +
'.logo-wrap{flex:none;width:190px;}' +
'.brand-mid{flex:1;text-align:center;padding-top:16px;}' +
'.brand-mid h1{font-size:32px;font-weight:800;letter-spacing:1px;line-height:1;}' +
'.brand-mid h1 .o{color:#f26522;}' +
'.brand-tag{font-size:11px;color:#1a1a1a;font-style:italic;font-weight:600;margin-top:5px;}' +
'.contact{flex:none;width:210px;font-size:9.5px;color:#333;padding-top:6px;}' +
'.contact .ct{display:flex;gap:6px;align-items:flex-start;margin-bottom:4px;line-height:1.3;}' +
'.contact .ci{color:#f26522;flex:none;}' +
'.lr-badge{position:absolute;top:-4px;right:0;background:#f26522;color:#fff;font-weight:800;font-size:13px;letter-spacing:1px;padding:6px 14px;border-radius:4px;}' +
/* ── GST BAR ── */
'.gstbar{border-top:2px solid #f26522;border-bottom:1px solid #ddd;padding:7px 0;text-align:center;font-size:11px;margin:6px 0 10px;}' +
'.gstbar b{font-weight:700;}.gstbar .sep{margin:0 14px;color:#bbb;}' +
/* ── CONSIGNOR / CONSIGNEE / META ── */
'.cc-row{display:flex;gap:8px;margin-bottom:10px;}' +
'.cc-box{flex:1;border:1px solid #d8dde3;border-radius:6px;padding:9px 11px;position:relative;overflow:hidden;}' +
'.cc-h{font-size:11px;font-weight:800;margin-bottom:6px;letter-spacing:.5px;}' +
'.cc-h .dot{color:#f26522;font-size:8px;vertical-align:middle;}' +
'.cc-h .cc-sub{font-weight:600;color:#777;font-size:9.5px;}' +
'.cc-line{display:flex;font-size:10px;line-height:1.45;margin-bottom:1px;}' +
'.cc-k{flex:none;width:54px;color:#666;}' +
'.cc-c{flex:none;width:8px;color:#666;}' +
'.cc-v{flex:1;font-weight:600;}' +
'.cc-rail{position:absolute;top:0;right:0;height:100%;width:20px;background:#1a1a1a;color:#fff;font-size:9px;font-weight:700;writing-mode:vertical-rl;text-orientation:upright;display:flex;align-items:center;justify-content:center;letter-spacing:1px;}' +
'.cc-box{padding-right:26px;}' +
'.cc-meta{flex:none;width:188px;border:1px solid #d8dde3;border-radius:6px;overflow:hidden;}' +
'.mblk{display:flex;justify-content:space-between;gap:6px;padding:4.5px 9px;border-bottom:1px solid #eef1f4;font-size:10px;}' +
'.mblk:last-child{border-bottom:none;}' +
'.mblk .mk{color:#666;}.mblk .mv{font-weight:700;text-align:right;}' +
'.mblk .mv.hot{color:#f26522;}.mblk .mv.b{font-weight:800;}' +
/* ── GOODS TABLE ── */
'.goods{width:100%;border-collapse:collapse;margin-bottom:10px;font-size:10px;}' +
'.goods th{background:#f4f6f8;border:1px solid #d8dde3;padding:6px 5px;font-size:9px;font-weight:800;text-transform:uppercase;}' +
'.goods td{border:1px solid #d8dde3;padding:14px 6px;text-align:center;font-weight:600;vertical-align:top;}' +
'.goods .goods-desc{text-align:left;}' +
/* ── CHARGES + SIDE ── */
'.mid-row{display:flex;gap:8px;margin-bottom:10px;}' +
'.fc-box{flex:1;border:1px solid #d8dde3;border-radius:6px;overflow:hidden;align-self:flex-start;}' +
'.fc-head{display:flex;justify-content:space-between;background:#1a1a1a;color:#fff;font-size:10px;font-weight:800;padding:6px 11px;}' +
'.fc-row{display:flex;justify-content:space-between;padding:5px 11px;font-size:10px;border-bottom:1px solid #eef1f4;}' +
'.fc-row .fc-k{color:#444;}.fc-row .fc-v{font-weight:600;}' +
'.fc-total{background:#f4f6f8;font-weight:800;}.fc-total .fc-k,.fc-total .fc-v{font-weight:800;}' +
'.fc-grand{display:flex;justify-content:space-between;background:#f26522;color:#fff;font-weight:800;font-size:11px;padding:7px 11px;}' +
'.side-col{flex:none;width:240px;display:flex;flex-direction:column;gap:6px;}' +
'.sp{border:1px solid #d8dde3;border-radius:6px;overflow:hidden;}' +
'.sp-h{background:#1a1a1a;color:#fff;font-size:9.5px;font-weight:800;padding:5px 10px;}' +
'.sp-b{padding:8px 10px;min-height:42px;font-size:10px;}' +
'.sp-hd{background:#1a1a1a;color:#fff;font-size:9.5px;font-weight:800;padding:5px 10px;text-align:center;}' +
'.sp-bc{padding:6px 10px;text-align:center;font-weight:800;font-size:11px;}' +
'.sp-bc.small{font-weight:600;font-size:9.5px;}' +
/* ── FOOTER ── */
'.foot3{display:flex;gap:10px;border-top:1px solid #e2e6ea;padding-top:10px;margin-bottom:10px;}' +
'.fcol{flex:1;font-size:9.5px;}' +
'.fhead{font-weight:800;font-size:10px;margin-bottom:5px;}' +
'.fhead-strong{font-weight:800;font-size:11px;margin-bottom:6px;}' +
'.recv .rl{display:flex;font-size:9.5px;line-height:1.5;}' +
'.recv .rk{flex:none;width:92px;color:#666;}.recv .rc{flex:none;width:8px;}.recv .rv{flex:1;font-weight:600;}' +
'.recv-note{margin-top:5px;font-size:9.5px;}' +
'.recv-agree{margin-top:6px;font-size:8.5px;color:#555;line-height:1.4;}' +
'.terms{list-style:none;}' +
'.terms li{font-size:9px;line-height:1.4;margin-bottom:4px;display:flex;gap:4px;}' +
'.terms .tnum{font-weight:700;color:#f26522;}' +
'.fcol p{font-size:9.5px;line-height:1.6;}' +
'.sigbox{margin-top:8px;border-top:1px dashed #ccc;padding-top:6px;text-align:center;}' +
'.sig-for{font-size:9px;margin-bottom:2px;}' +
'.sig-img{height:42px;width:auto;display:block;margin:0 auto;}' +
'.sig-line{height:34px;border-bottom:1px solid #999;margin:0 16px;}' +
'.sig-name{font-size:9px;color:#555;margin-top:2px;}' +
/* ── SIGNATURE ROW + COMPANY SEAL (item 1) ── */
'.sigrow{display:flex;gap:8px;align-items:flex-end;margin-top:8px;}' +
'.sigrow .sigbox{flex:1;margin-top:0;}' +
'.sealbox{flex:none;width:78px;text-align:center;}' +
'.seal-ring{width:62px;height:62px;margin:0 auto;border:1.5px dashed #c4a35a;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:700;color:#b78b3a;letter-spacing:.3px;line-height:1.3;text-align:center;}' +
/* ── DELIVERY ACKNOWLEDGEMENT BAND (item 2) ── */
'.ackband{border:1px solid #d8dde3;border-radius:6px;padding:8px 10px;margin-bottom:10px;}' +
'.ack-title{font-size:9.5px;font-weight:800;letter-spacing:1px;color:#f26522;margin-bottom:7px;text-transform:uppercase;}' +
'.ack-grid{display:flex;gap:10px;}' +
'.ack-grid-2{margin-top:9px;align-items:flex-end;}' +
'.ack-cell{flex:1;}' +
'.ack-wide{flex:2;}' +
'.ack-seal{flex:none;width:96px;}' +
'.ack-lbl{font-size:8px;color:#666;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;}' +
'.ack-fill{height:26px;border-bottom:1px solid #9aa3ad;}' +
'.ack-fill-sm{height:20px;}' +
'.ack-fill-seal{height:44px;border:1px dashed #c9ced4;border-radius:4px;}' +
'.ack-note{font-size:8px;color:#777;line-height:1.4;align-self:center;}' +
/* ── TRUST ROW ── */
'.trust{display:flex;justify-content:space-around;border-top:1px solid #e2e6ea;padding-top:10px;margin-top:4px;}' +
'.ti{display:flex;gap:7px;align-items:center;font-size:9px;font-weight:700;color:#444;}' +
'.tic{width:22px;height:22px;color:#f26522;flex:none;}' +
'.thanks{margin-top:10px;background:#1a1a1a;color:#fff;text-align:center;font-weight:700;font-size:12px;padding:8px;border-radius:4px;}' +
/* ── PRINT ── */
'@media print{body{background:#fff;padding:0;}.page{box-shadow:none;width:100%;min-height:auto;margin:0;page-break-after:always;}.page:last-child{page-break-after:auto;}@page{size:A4;margin:7mm;}}';
  }
  window.LR.styles = lrStyles;

  /* ----------------------------------------------------------
     STANDALONE LR DOCUMENT
  ---------------------------------------------------------- */
  window.LR.renderHTML = function (lr, config) {
    return '' +
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + esc(lr.lrNumber || 'Lorry Receipt') + ' \u2014 Orbit Logistics</title>' +
'<style>' + lrStyles() + '</style></head><body>' +
'<div class="page">' + lrPageHTML(lr, config) + '</div>' +
'</body></html>';
  };

  /* ----------------------------------------------------------
     COMBINED DOCUMENT — Page 1: Tax Invoice · Page 2: Lorry Receipt
     Reuses INV.renderHTML for page 1 by extracting its <body> .page,
     and LR.pageHTML for page 2, under one print stylesheet so a single
     "Save as PDF" produces the two-page combined file.
  ---------------------------------------------------------- */
  window.LR.renderCombinedHTML = function (invoice, lr, config) {
    /* Build the invoice page using the EXISTING invoice renderer, then
       lift just its inner .page markup so we control pagination here. */
    var invDoc = window.INV.renderHTML(invoice, config);
    var invPage = '';
    var m = invDoc.match(/<div class="page">([\s\S]*?)<\/body>/);
    if (m) {
      invPage = m[1].replace(/<\/div>\s*$/, ''); /* trim trailing wrapper close */
    }

    /* The invoice ships its own scoped CSS inside its <head>; pull it so
       page 1 renders identically to a standalone invoice. */
    var invCss = '';
    var c = invDoc.match(/<style>([\s\S]*?)<\/style>/);
    if (c) { invCss = c[1]; }

    return '' +
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<title>' + esc(invoice.invoiceNumber || 'Document') + ' + ' + esc(lr.lrNumber || 'LR') + ' \u2014 Orbit Logistics</title>' +
/* Invoice CSS first (scoped to its own classes), then LR CSS. Both use
   a .page block; the shared print rule paginates them as two A4 pages. */
'<style>' + invCss + '</style>' +
'<style>' + lrStyles() + '</style>' +
'<style>@media print{.page{page-break-after:always;}.page:last-child{page-break-after:auto;}}</style>' +
'</head><body>' +
/* PAGE 1 — TAX INVOICE */
'<div class="page">' + invPage + '</div>' +
/* PAGE 2 — LORRY RECEIPT */
'<div class="page">' + lrPageHTML(lr, config) + '</div>' +
'</body></html>';
  };

  /* ----------------------------------------------------------
     OPEN / PRINT helpers — mirror INV.openInvoiceWindow exactly
  ---------------------------------------------------------- */
  window.LR.openLrWindow = function (lr, autoPrint) {
    return window.INV.loadConfig().then(function (config) {
      var html = window.LR.renderHTML(lr, config);
      var w = window.open('', '_blank');
      if (!w) { return false; }
      w.document.write(html);
      w.document.close();
      if (autoPrint) setTimeout(function () { w.focus(); w.print(); }, 500);
      return true;
    });
  };

  window.LR.openCombinedWindow = function (invoice, lr, autoPrint) {
    return window.INV.loadConfig().then(function (config) {
      var html = window.LR.renderCombinedHTML(invoice, lr, config);
      var w = window.open('', '_blank');
      if (!w) { return false; }
      w.document.write(html);
      w.document.close();
      if (autoPrint) setTimeout(function () { w.focus(); w.print(); }, 600);
      return true;
    });
  };

})();

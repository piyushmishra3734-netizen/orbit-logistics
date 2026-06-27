/* ============================================================
   COMPANIES.JS — Company directory for Commercial shipments
   Express Goods Carrier / Orbit Logistics

   Powers the Commercial quote flow:
     - type-ahead company suggestions as the customer types
     - auto-fill of GST / registered address / city / state / contact
       when an existing company is selected (customer only verifies)
     - "Add New Company" so unknown companies are saved for future reuse

   Stored in Firestore collection `companies`, keyed by a slug of the
   name so the same company is not duplicated. Structure is flat and
   accounting-ready (mirrors the LR/invoice convention).

   Depends on: window.EGC (phase3-core.js), fbDB, firebase
   ============================================================ */

(function () {
  'use strict';

  window.CO = window.CO || {};

  /* In-memory cache so the type-ahead does not hit Firestore on every
     keystroke. Loaded once, then refreshed after any add. */
  var _cache = null;
  var _loading = null;

  function slugify(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }
  window.CO.slugify = slugify;

  /* Load the full directory once (companies lists are small for an SMB). */
  window.CO.load = function () {
    if (_cache) return Promise.resolve(_cache);
    if (_loading) return _loading;
    _loading = fbDB.collection('companies')
      .orderBy('name')
      .get()
      .then(function (snap) {
        _cache = [];
        snap.forEach(function (doc) {
          var d = doc.data(); d._id = doc.id; _cache.push(d);
        });
        return _cache;
      })
      .catch(function (err) {
        console.warn('[CO] load failed (continuing with empty directory):', err.message);
        _cache = [];
        return _cache;
      })
      .finally(function () { _loading = null; });
    return _loading;
  };

  /* Case-insensitive prefix/substring search over cached companies. */
  window.CO.search = function (term) {
    term = String(term || '').trim().toLowerCase();
    if (!_cache || !term) return [];
    return _cache.filter(function (c) {
      return (c.name || '').toLowerCase().indexOf(term) !== -1
          || (c.gst  || '').toLowerCase().indexOf(term) !== -1;
    }).slice(0, 8);
  };

  window.CO.findBySlug = function (slug) {
    if (!_cache) return null;
    return _cache.filter(function (c) { return c._id === slug; })[0] || null;
  };

  window.CO.findByName = function (name) {
    if (!_cache) return null;
    var s = slugify(name);
    return window.CO.findBySlug(s);
  };

  /* Save (or merge-update) a company. Returns the saved record.
     Safe to call when verifying an existing company too — merge keeps
     any fields the customer left untouched. */
  window.CO.save = function (data) {
    var name = (data.name || '').trim();
    if (!name) return Promise.reject(new Error('Company name is required.'));
    var slug = slugify(name);

    var rec = {
      name:             name,
      gst:              (data.gst || '').trim(),
      registeredAddress:(data.registeredAddress || '').trim(),
      city:             (data.city || '').trim(),
      state:            (data.state || '').trim(),
      contactPerson:    (data.contactPerson || '').trim(),
      phone:            (data.phone || '').trim(),
      email:            (data.email || '').trim(),
      updatedAt:        firebase.firestore.FieldValue.serverTimestamp()
    };
    /* Optionally remember this customer's most recent shipment pattern (route,
       consignee, material). Used ONLY to offer a one-click "same as last time?"
       prefill on the next phone booking — never auto-applied, never critical
       data filled silently. Stored as a plain sub-object; merge keeps it. */
    if (data.lastShipment && typeof data.lastShipment === 'object') {
      rec.lastShipment = {
        pickup:        (data.lastShipment.pickup || '').trim(),
        delivery:      (data.lastShipment.delivery || '').trim(),
        consigneeName: (data.lastShipment.consigneeName || '').trim(),
        materialType:  (data.lastShipment.materialType || '').trim(),
        at:            Date.now()
      };
    }

    var ref = fbDB.collection('companies').doc(slug);
    return ref.get().then(function (snap) {
      if (!snap.exists) {
        rec.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      }
      return ref.set(rec, { merge: true });
    }).then(function () {
      rec._id = slug;
      /* Refresh cache so the new company is immediately searchable. */
      if (_cache) {
        var existing = window.CO.findBySlug(slug);
        if (existing) { Object.assign(existing, rec); }
        else { _cache.push(rec); _cache.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); }); }
      }
      return rec;
    });
  };

})();

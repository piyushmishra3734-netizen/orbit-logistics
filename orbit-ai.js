/* ============================================================================
   ORBIT AI — Client assistant (floating UI)
   ----------------------------------------------------------------------------
   A modern floating assistant that talks to the secure `orbitAI` Cloud Function.
   It NEVER touches Gemini or business data directly — it sends the user's
   message + lightweight page context + recent history to the server, which
   enforces auth/role and returns an answer plus any client actions (navigate /
   draft) that the user is already allowed to perform.

   Role-aware: suggested prompts and tone adapt to owner vs customer. The server
   is the security authority; this file is presentation + safe action dispatch.
   ============================================================================ */
(function () {
  'use strict';

  /* Wait until Firebase + auth are ready (pages already load compat SDKs). */
  function whenReady(cb) {
    var tries = 0;
    (function poll() {
      tries++;
      if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth) {
        var u = firebase.auth().currentUser;
        if (u) return cb(u);
        firebase.auth().onAuthStateChanged(function (usr) { if (usr) cb(usr); });
        return;
      }
      if (tries < 80) setTimeout(poll, 100);
    })();
  }

  var OWNER_EMAIL = 'piyushmishra3734@gmail.com';
  var state = {
    open: false,
    busy: false,
    user: null,
    isOwner: false,
    history: [],          // {role:'user'|'model', text}
    briefShown: false,    // morning brief shown this session?
    briefData: null,      // prefetched brief
    lastInsightKey: null, // last screen-context we proactively spoke about
  };

  /* ---- callable wrapper ---- */
  function callOrbit(message) {
    var fn = firebase.functions ? firebase.functions('us-central1').httpsCallable('orbitAI') : null;
    if (!fn) return Promise.reject(new Error('Orbit AI is unavailable (functions SDK not loaded).'));
    return fn({
      message: message,
      history: state.history.slice(-12),
      context: pageContext(),
    }).then(function (res) { return res.data; });
  }

  /* ---- morning brief (owner only) ---- */
  function fetchMorningBrief() {
    var fn = firebase.functions ? firebase.functions('us-central1').httpsCallable('orbitMorningBrief') : null;
    if (!fn) return Promise.reject(new Error('unavailable'));
    return fn({ narrate: true }).then(function (res) { return res.data; });
  }

  /* Render the brief as a friendly bot bubble. Prefers the model narration;
     falls back to a clean structured list if narration is unavailable. */
  function renderBrief(data) {
    var body = document.getElementById('oaiBody');
    if (!body || !data) return;
    var text = (data.narration || '').trim();
    if (!text) {
      var b = data.brief || {};
      var lines = [];
      // Warm, employee-style opener that signals the AI already did a check.
      var greet = (b.greeting || 'Hello.').replace(/\.$/, '');
      if (b.allClear) {
        lines.push(greet + ' 👋');
        lines.push('I\'ve already checked today\'s work — nothing urgent right now.');
        (b.items || []).forEach(function (i) { if (i.kind === 'pending_deliveries') lines.push('• ' + i.text); });
        lines.push('You can relax for a bit.');
      } else {
        lines.push(greet + ' 👋  I\'ve already looked over today\'s numbers.');
        (b.items || []).forEach(function (i) { lines.push('• ' + i.text); });
        if ((b.recommendations || []).length) {
          lines.push('');
          lines.push('I\'d start here: ' + b.recommendations.join(' '));
        }
      }
      text = lines.join('\n');
    }
    body.appendChild(bubble('model', text));
    state.history.push({ role: 'model', text: text });
    body.scrollTop = body.scrollHeight;
  }

  /* ---- lightweight, NON-authoritative page context (hints only) ---- */
  function pageContext() {
    var page = (location.pathname.split('/').pop() || '').replace('.html', '') || 'home';
    var activeTab = document.querySelector('.dash-tab.on');
    var ctx = { page: page, tab: activeTab ? activeTab.getAttribute('data-tab') : null };
    // accounting sub-page (hash) so insights know if it's outstanding/trial/pl…
    if (page === 'accounting') ctx.hash = (location.hash || '').replace('#', '').split('?')[0] || 'dashboard';
    // selected invoice/order on screen, if any (purely a hint; server re-checks)
    var sel = document.querySelector('[data-selected-id]');
    if (sel) ctx.selectedId = sel.getAttribute('data-selected-id');
    return ctx;
  }

  /* ---- proactive page insight ---- */
  function fetchInsight() {
    var fn = firebase.functions ? firebase.functions('us-central1').httpsCallable('orbitInsight') : null;
    if (!fn) return Promise.reject(new Error('unavailable'));
    return fn({ context: pageContext() }).then(function (res) { return res.data && res.data.insight; });
  }
  function renderInsight(insight) {
    if (!insight || !insight.text) return false;
    var body = document.getElementById('oaiBody');
    if (!body) return false;
    // Psychology: don't repeat the same shipment status the customer already
    // saw last visit — say "no changes" instead, to avoid noise/fatigue.
    var text = insight.text;
    if (!state.isOwner && insight.stateKey) {
      var seen = null;
      try { seen = localStorage.getItem('oai_seen_' + (state.user && state.user.uid || '')); } catch (e) {}
      if (seen && seen === insight.stateKey) {
        text = 'Welcome back 👋  No changes since your last visit — your shipment is still on track. I\'ll let you know the moment anything moves.';
        insight = { text: text, suggest: insight.suggest };
      }
      try { localStorage.setItem('oai_seen_' + (state.user && state.user.uid || ''), insight.stateKey); } catch (e) {}
    }
    var b = bubble('model', text);
    body.appendChild(b);
    state.history.push({ role: 'model', text: text });
    if (insight.suggest && insight.suggest.message) {
      var wrap = el('div', 'oai-followups');
      var chip = el('button', 'oai-followup', insight.suggest.label || 'Yes');
      chip.addEventListener('click', function () {
        if (state.busy) return;
        wrap.remove();
        var ta = document.getElementById('oaiText'); ta.value = insight.suggest.message; send();
      });
      wrap.appendChild(chip);
      b.appendChild(wrap);
    }
    body.scrollTop = body.scrollHeight;
    return true;
  }

  /* ---- safe action dispatch (only things the user can already do) ---- */
  function runActions(actions) {
    (actions || []).forEach(function (a) {
      if (!a || !a.kind) return;
      if (a.kind === 'navigate') {
        if (a.target && typeof window.openTabExternal === 'function') window.openTabExternal(a.target);
        else if (a.target) {
          var btn = document.querySelector('.dash-tab[data-tab="' + a.target + '"]');
          if (btn) btn.click();
        }
        if (a.action === 'open_manual_order' && window.OWN && OWN.openManualOrder) OWN.openManualOrder();
        if (a.action === 'track_shipment' && window.CUST && CUST.track) {
          var input = document.getElementById('trkInput');
          if (input && a.query) { input.value = a.query; }
          if (CUST.trackQuick && a.query) CUST.trackQuick(a.query); else if (CUST.track) CUST.track();
        }
      }
      if (a.kind === 'draft_manual_order' && window.OWN && OWN.openManualOrder) {
        OWN.openManualOrder();
        prefillManualOrder(a.draft || {});
      }
      if (a.kind === 'open_record') { openRecord(a); }
    });
  }

  /* Deep-link to a specific record. Owner-only surfaces; on the customer
     dashboard these simply no-op if the function isn't present. */
  function openRecord(a) {
    var k = a.recordKind;
    // accounting pages live on accounting.html — navigate with a hash deep-link
    if (a.target === 'accounting') {
      var hash = '#' + (a.page || 'dashboard') + (a.party ? ('?party=' + encodeURIComponent(a.party)) : '');
      if (/accounting\.html$/.test(location.pathname)) {
        if (window.ACC && ACC.goTo) ACC.goTo(a.page || 'dashboard', { party: a.party });
        else location.hash = hash;
      } else {
        location.href = 'accounting.html' + hash;
      }
      return;
    }
    // invoice / LR / order open within the owner dashboard
    if (k === 'invoice' && window.OWN && OWN.viewInvoice) OWN.viewInvoice(a.identifier);
    else if (k === 'lr' && window.OWN && OWN.viewLR) OWN.viewLR(a.identifier);
    else if (k === 'order' && window.OWN && OWN.manageShipmentFromInvoice) {
      // order id → manage shipment; fall back to navigating to orders tab
      var ob = document.querySelector('.dash-tab[data-tab="orders"]'); if (ob) ob.click();
    }
  }

  function prefillManualOrder(d) {
    setTimeout(function () {
      function set(id, v) { var el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; }
      if (d.shipmentType === 'personal' && window.OWN && OWN.manualPickType) OWN.manualPickType('personal');
      set('mCompanyName', d.companyName); set('mConsigneeName', d.consigneeName);
      set('mPickup', d.pickup); set('mDelivery', d.delivery);
      set('mWeight', d.weight); set('mFreight', d.freight);
      if (d.materialType) { var mt = document.getElementById('mMaterial'); if (mt) mt.value = d.materialType; }
    }, 120);
  }

  /* ---- harmless usage learning (client-only, localStorage) ----------------
     We remember ONLY harmless interaction patterns to reduce the owner's
     thinking: how often each suggestion chip is clicked vs shown, and which
     screens are opened. Nothing sensitive, nothing leaves the device, no
     permissions involved. Used only to reorder suggestions the user already
     sees — never to fabricate or to widen access. */
  var PREFS = {
    key: function () { return 'oai_prefs_' + ((state.user && state.user.uid) || 'anon'); },
    load: function () {
      try { return JSON.parse(localStorage.getItem(this.key()) || '{}'); } catch (e) { return {}; }
    },
    save: function (p) { try { localStorage.setItem(this.key(), JSON.stringify(p)); } catch (e) {} },
    bump: function (group, field) {
      var p = this.load(); p[group] = p[group] || {};
      p[group][field] = (p[group][field] || 0) + 1; this.save(p);
    },
    // a chip's affinity = clicks minus a fraction of ignores, so chips the user
    // keeps ignoring drift down and ones they pick rise.
    score: function (label) {
      var p = this.load(); var c = (p.click && p.click[label]) || 0; var s = (p.show && p.show[label]) || 0;
      return c * 3 - Math.max(0, s - c) * 0.5;
    },
  };

  /* Reorder a base suggestion list by learned affinity (stable for ties, so the
     curated order is preserved until the user shows a real preference). */
  function rankSuggestions(list) {
    return list
      .map(function (label, i) { return { label: label, i: i, sc: PREFS.score(label) }; })
      .sort(function (a, b) { return (b.sc - a.sc) || (a.i - b.i); })
      .map(function (x) { return x.label; });
  }

  /* ---- suggested prompts by role ---- */
  /* Context-aware suggestions: what's useful depends on the screen the owner
     is looking at right now, so they never have to think about what to ask.
     Falls back to a sensible default set. */
  function suggestions() {
    if (!state.isOwner) {
      var ctxC = pageContext();
      if (ctxC.tab === 'tracking') return ['Where is my shipment?', 'When will it arrive?', 'Explain my invoice charges'];
      if (ctxC.tab === 'invoices') return ['Show my payment status', 'Download my latest invoice', 'Explain my invoice charges'];
      return ['Where is my shipment?', 'Show my payment status', 'Explain my invoice charges', 'What is GST?'];
    }
    var ctx = pageContext();
    // Accounting screens (page = accounting, current hash = sub-page)
    var hash = (location.hash || '').replace('#', '').split('?')[0];
    if (ctx.page === 'accounting') {
      if (hash === 'outstanding') return ['Who should I chase first?', 'Show slow-paying customers', 'Draft a reminder for the biggest due'];
      if (hash === 'trial')       return ['Is my trial balance balanced?', 'Explain trial balance like I\'m new', 'Any accounting mistakes?'];
      if (hash === 'pl')          return ['How is my profit this month?', 'Why did profit change?', 'Explain profit & loss simply'];
      if (hash === 'ledger')      return ['Explain this customer\'s balance', 'Is this customer slow-paying?', 'Draft a reminder for them'];
      if (hash === 'balance')     return ['Explain my balance sheet simply', 'How much do I own vs owe?'];
      return ['Business health score', 'Who should I chase first?', 'Any accounting mistakes?', 'How is my profit?'];
    }
    // Owner dashboard tabs
    if (ctx.tab === 'orders')    return ['Create a manual order', 'Which deliveries are pending?', 'Open outstanding'];
    if (ctx.tab === 'invoices')  return ['Which invoices are unpaid?', 'Who owes me the most?', 'Open a specific invoice'];
    if (ctx.tab === 'pending')   return ['Show pending quotations', 'Which quotes need my action?'];
    if (ctx.tab === 'lr')        return ['Open a Lorry Receipt', 'Find a shipment by LR number'];
    // Default (home/first open)
    return ['Business health score', 'Who should I chase first?', 'Revenue this month', 'Create a manual order', 'Any accounting mistakes?'];
  }

  /* ===================================================== UI =============== */
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  function build() {
    if (document.getElementById('orbitAiRoot')) return;
    var root = el('div', 'oai-root'); root.id = 'orbitAiRoot';

    /* floating launcher */
    var fab = el('button', 'oai-fab', ''
      + '<span class="oai-fab-glow"></span>'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><ellipse cx="12" cy="12" rx="10" ry="4.4"/><ellipse cx="12" cy="12" rx="10" ry="4.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.4" transform="rotate(120 12 12)"/></svg>');
    fab.id = 'oaiFab'; fab.title = 'Orbit AI';
    fab.addEventListener('click', toggle);

    /* panel */
    var panel = el('div', 'oai-panel'); panel.id = 'oaiPanel';
    panel.innerHTML = ''
      + '<div class="oai-head">'
      +   '<div class="oai-brand">'
      +     '<div class="oai-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><ellipse cx="12" cy="12" rx="10" ry="4.4"/><ellipse cx="12" cy="12" rx="10" ry="4.4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.4" transform="rotate(120 12 12)"/></svg></div>'
      +     '<div><div class="oai-name">Orbit AI</div><div class="oai-sub">Powered by Gemini</div></div>'
      +   '</div>'
      +   '<button class="oai-x" id="oaiClose" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'
      + '</div>'
      + '<div class="oai-body" id="oaiBody"></div>'
      + '<div class="oai-suggest" id="oaiSuggest"></div>'
      + '<div class="oai-input">'
      +   '<textarea id="oaiText" rows="1" placeholder="Ask Orbit AI…"></textarea>'
      +   '<button id="oaiSend" class="oai-send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>'
      + '</div>';

    root.appendChild(panel); root.appendChild(fab);
    document.body.appendChild(root);

    document.getElementById('oaiClose').addEventListener('click', toggle);
    document.getElementById('oaiSend').addEventListener('click', send);
    var ta = document.getElementById('oaiText');
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });

    renderWelcome();
    renderSuggest();
  }

  function renderWelcome() {
    var body = document.getElementById('oaiBody');
    var greet = state.isOwner
      ? 'Hi! I\'m Orbit AI. Ask me about orders, invoices, customers, outstanding or accounting, say "create a manual order", or "explain GST like I\'m new". And if you just feel like chatting, that\'s fine too.'
      : 'Hi! I\'m Orbit AI. I can track your shipments, show your invoices and LRs, and explain your charges. Ask me "where is my shipment?" — or just chat if you like.';
    body.appendChild(bubble('model', greet));
  }

  function renderSuggest() {
    var wrap = document.getElementById('oaiSuggest');
    wrap.innerHTML = '';
    // Order the curated suggestions by what this user actually tends to use.
    var list = rankSuggestions(suggestions());
    list.forEach(function (s) {
      PREFS.bump('show', s);   // harmless: count that this chip was offered
      var chip = el('button', 'oai-chip', s);
      chip.addEventListener('click', function () {
        PREFS.bump('click', s); // harmless: count that the user chose it
        document.getElementById('oaiText').value = s; send();
      });
      wrap.appendChild(chip);
    });
  }

  function bubble(role, text) {
    var b = el('div', 'oai-msg ' + (role === 'user' ? 'oai-user' : 'oai-bot'));
    b.appendChild(el('div', 'oai-msg-in', escapeHtml(text).replace(/\n/g, '<br>')));
    return b;
  }

  function typing() {
    var t = el('div', 'oai-msg oai-bot'); t.id = 'oaiTyping';
    t.appendChild(el('div', 'oai-msg-in oai-typing', '<span></span><span></span><span></span>'));
    return t;
  }

  function toggle() {
    state.open = !state.open;
    document.getElementById('oaiPanel').classList.toggle('on', state.open);
    document.getElementById('oaiFab').classList.toggle('hidden', state.open);
    if (state.open) {
      var dot = document.getElementById('oaiDot'); if (dot) dot.remove();
      // Always refresh suggestions to match the screen the user is on right now.
      renderSuggest();
      var sg = document.getElementById('oaiSuggest'); if (sg) sg.style.display = '';
      // Owner: the morning greeting belongs on the dashboard. Show it once on
      // first open there. On other screens (e.g. Accounting), skip the brief and
      // give a screen-specific proactive insight instead.
      var onOwnerDashboard = /owner-dashboard/.test(location.pathname);
      if (state.isOwner && onOwnerDashboard && !state.briefShown) {
        state.briefShown = true;
        if (state.briefData) { renderBrief(state.briefData); }
        else {
          var body = document.getElementById('oaiBody');
          if (body) body.appendChild(typing());
          fetchMorningBrief().then(function (data) {
            var tp = document.getElementById('oaiTyping'); if (tp) tp.remove();
            renderBrief(data);
          }).catch(function () {
            var tp = document.getElementById('oaiTyping'); if (tp) tp.remove();
            /* brief unavailable (e.g. before deploy) — stay silent, no error noise */
          });
        }
      } else {
        // Proactive page insight: speak first about THIS screen, once per
        // distinct screen-context per session. Silent if nothing genuine to say.
        maybeShowInsight();
      }
      setTimeout(function () { var t = document.getElementById('oaiText'); if (t) t.focus(); }, 120);
    }
  }

  function insightKey() {
    var c = pageContext();
    return (c.page || '') + '|' + (c.hash || c.tab || '');
  }
  function maybeShowInsight() {
    var key = insightKey();
    PREFS.bump('screen', key);   // harmless: which screens this user opens with AI
    if (state.lastInsightKey === key) return;   // already spoke about this screen
    state.lastInsightKey = key;
    fetchInsight().then(function (insight) {
      if (insight) renderInsight(insight);
    }).catch(function () { /* best-effort; stay quiet */ });
  }

  function send() {
    if (state.busy) return;
    var ta = document.getElementById('oaiText');
    var msg = (ta.value || '').trim();
    if (!msg) return;
    ta.value = ''; ta.style.height = 'auto';
    var body = document.getElementById('oaiBody');
    body.appendChild(bubble('user', msg));
    state.history.push({ role: 'user', text: msg });
    document.getElementById('oaiSuggest').style.display = 'none';
    body.appendChild(typing());
    body.scrollTop = body.scrollHeight;
    state.busy = true; document.getElementById('oaiSend').disabled = true;

    callOrbit(msg).then(function (data) {
      var tp = document.getElementById('oaiTyping'); if (tp) tp.remove();
      var answer = (data && data.text) || "I don't have enough information for that.";
      var b = bubble('model', answer);
      body.appendChild(b);
      state.history.push({ role: 'model', text: answer });
      if (data && data.actions) runActions(data.actions);
      addFollowups(b, answer);
      body.scrollTop = body.scrollHeight;
    }).catch(function (err) {
      var tp = document.getElementById('oaiTyping'); if (tp) tp.remove();
      var m = (err && err.message) || 'Something went wrong.';
      body.appendChild(bubble('model', 'Sorry — ' + m));
      body.scrollTop = body.scrollHeight;
    }).finally(function () {
      state.busy = false; document.getElementById('oaiSend').disabled = false;
      document.getElementById('oaiText').focus();
    });
  }

  /* After an explanation-type answer, offer one-tap depth controls so the user
     can go deeper or simpler without typing. Shown only when the answer reads
     like an explanation (keeps the UI uncluttered for data answers). */
  function addFollowups(afterEl, answer) {
    var looksExplanatory = /\b(GST|TDS|debit|credit|ledger|journal|trial balance|profit|balance sheet|invoice|freight|entry|account)\b/i.test(answer) && answer.length > 120;
    if (!looksExplanatory) return;
    var wrap = el('div', 'oai-followups');
    [['Explain more', 'Explain that in more detail with a worked example.'],
     ['Explain like I\'m new', 'Explain that again like I have never studied accounting — very simple, with an everyday example.']
    ].forEach(function (pair) {
      var chip = el('button', 'oai-followup', pair[0]);
      chip.addEventListener('click', function () {
        if (state.busy) return;
        wrap.remove();
        var ta = document.getElementById('oaiText'); ta.value = pair[1]; send();
      });
      wrap.appendChild(chip);
    });
    afterEl.appendChild(wrap);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---- boot ---- */
  whenReady(function (user) {
    state.user = user;
    state.isOwner = (user.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase();
    build();
    // Owner on the dashboard: prefetch the morning brief and flag the launcher.
    if (state.isOwner && /owner-dashboard/.test(location.pathname)) {
      fetchMorningBrief().then(function (data) {
        state.briefData = data;
        if (!state.open) {
          var fab = document.getElementById('oaiFab');
          if (fab && !document.getElementById('oaiDot')) {
            var dot = document.createElement('span'); dot.id = 'oaiDot'; dot.className = 'oai-dot';
            fab.appendChild(dot);
          }
        }
      }).catch(function () { /* before deploy / no key — silent */ });
    }
  });
})();

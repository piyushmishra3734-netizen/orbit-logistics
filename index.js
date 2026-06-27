/* ============================================================================
   Orbit AI — CALLABLE CLOUD FUNCTION (the secure mediator)
   ----------------------------------------------------------------------------
   Flow per request:
     1. Firebase verifies the caller's ID token (callable functions do this;
        request.auth is trustworthy and cannot be forged by the client).
     2. We derive role server-side from the verified email — never from the body.
     3. We build a per-request DataAccess bound to that verified uid/role.
     4. We run a Gemini function-calling loop, offering ONLY role-appropriate
        tools. Each tool executes through the scoped data layer.
     5. The model's text answer is returned, plus any client action (navigate /
        draft) the UI may perform — actions are limited to things the user can
        already do.

   The API key lives ONLY here (functions config / env), never in the browser.
   The LLM is never a privilege boundary: it only ever sees data the verified
   user could already read, and it can only DRAFT state changes, never commit
   them (creation still goes through the existing pipeline + Firestore rules).
   ============================================================================ */
'use strict';
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { DataAccess, AccessDenied } = require('./data-access');
const { toolsForRole, execute } = require('./tools');
const { buildContents, systemPrompt } = require('./context');
const { buildMorningBrief } = require('./morning-brief');
const { ownerInsight, customerInsight } = require('./page-insight');
const { reports } = require('./accounting-bridge');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const OWNER_EMAIL = (functions.config().orbit && functions.config().orbit.owner_email) || 'piyushmishra3734@gmail.com';

function geminiKey() {
  // Prefer Functions config (firebase functions:config:set gemini.key="..."),
  // fall back to env for local emulator. NEVER hard-code.
  return (functions.config().gemini && functions.config().gemini.key) || process.env.GEMINI_KEY || '';
}

/* ---- Orbit AI persona is defined in ./context.js (systemPrompt) ---- */

/* Convert a tool result into a function-response part for Gemini. */
function fnResponse(name, result) {
  return { functionResponse: { name, response: { result } } };
}

exports.orbitAI = functions
  .region('us-central1')
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onCall(async (data, context) => {
    /* 1. AUTH — verified by Firebase. No token → reject. */
    if (!context.auth) {
      throw new functions.https.HttpsError('unauthenticated', 'Please sign in to use Orbit AI.');
    }
    const email = (context.auth.token && context.auth.token.email) || '';
    const uid = context.auth.uid;
    const isOwner = email && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
    const authCtx = { uid, email, isOwner };

    /* 2. INPUT */
    const userMessage = String((data && data.message) || '').slice(0, 4000);
    const history = Array.isArray(data && data.history) ? data.history.slice(-12) : [];
    const pageCtx = (data && data.context) || {};   // current page / selected ids (hints only)
    if (!userMessage.trim()) {
      throw new functions.https.HttpsError('invalid-argument', 'Empty message.');
    }

    const key = geminiKey();
    if (!key) {
      throw new functions.https.HttpsError('failed-precondition', 'Orbit AI is not configured (missing model key).');
    }

    /* 3. SCOPED DATA ACCESS bound to the verified identity */
    const da = new DataAccess(db, authCtx);

    /* 4. GEMINI function-calling loop */
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash',
      systemInstruction: systemPrompt(isOwner ? 'owner' : 'customer'),
      tools: [{ functionDeclarations: toolsForRole(isOwner) }],
    });

    // Thread prior turns + page context (in-conversation memory).
    const contents = buildContents(history, userMessage, pageCtx);

    const clientActions = [];
    let finalText = '';
    const MAX_TURNS = 5;   // tool round-trips guard

    try {
      let resp = await model.generateContent({ contents });
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const cand = resp.response.candidates && resp.response.candidates[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

        if (!calls.length) { finalText = resp.response.text(); break; }

        // Execute each requested tool through the SCOPED layer.
        const toolParts = [];
        contents.push({ role: 'model', parts });
        for (const call of calls) {
          let result;
          try {
            result = await execute(call.name, call.args || {}, da, authCtx);
            if (result && result._clientAction) { clientActions.push(result._clientAction); }
          } catch (e) {
            result = (e instanceof AccessDenied)
              ? { error: 'permission_denied', message: e.message }
              : { error: 'tool_error', message: 'That lookup failed. ' + (e.message || '') };
          }
          toolParts.push(fnResponse(call.name, result));
        }
        contents.push({ role: 'user', parts: toolParts });
        resp = await model.generateContent({ contents });
        if (turn === MAX_TURNS - 1) finalText = resp.response.text();
      }
    } catch (e) {
      console.error('[orbitAI] model error:', e && e.message);
      throw new functions.https.HttpsError('internal', 'Orbit AI had trouble responding. Please try again.');
    }

    /* 5. AUDIT (owner actions + customer queries are logged, like the rest of
          the system). Fire-and-forget; never blocks the answer. */
    db.collection('auditLogs').add({
      action: 'orbit_ai_query',
      actorUid: uid, actorEmail: email, role: isOwner ? 'owner' : 'customer',
      summary: 'Orbit AI: ' + userMessage.slice(0, 140),
      details: { actions: clientActions.map((a) => a.kind) },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    return {
      text: finalText || "I don't have enough information for that.",
      actions: clientActions,
      role: isOwner ? 'owner' : 'customer',
    };
  });

/* Derive a friendly owner name from the verified token + profile (never the
   client body). Falls back gracefully. */
async function resolveOwnerName(db, uid, token) {
  let name = (token && (token.name || token.displayName)) || '';
  if (!name) {
    try {
      const snap = await db.collection('customerProfiles').doc(uid).get();
      if (snap.exists) name = snap.data().contactPerson || '';
    } catch (e) { /* ignore */ }
  }
  // first name only, like the rest of the UI
  return (name || '').trim().split(/\s+/)[0] || '';
}

/* ============================================================================
   MORNING BRIEF — proactive owner summary.
   A separate callable so the client can request it once on owner login. The
   AI then narrates the structured brief in the owner's name and language.
   OWNER ONLY; returns real figures only (never fabricated).
   ============================================================================ */
exports.orbitMorningBrief = functions
  .region('us-central1')
  .runWith({ timeoutSeconds: 60, memory: '512MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Please sign in.');
    const email = (context.auth.token && context.auth.token.email) || '';
    const isOwner = email && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
    if (!isOwner) throw new functions.https.HttpsError('permission-denied', 'The morning brief is for the owner.');

    const authCtx = { uid: context.auth.uid, email, isOwner: true };
    const da = new DataAccess(db, authCtx);
    const ownerName = await resolveOwnerName(db, context.auth.uid, context.auth.token);

    let bundle, orders;
    try {
      bundle = await da.accountingBundle();
      orders = await da.myOrders(1000);
    } catch (e) {
      throw new functions.https.HttpsError('internal', 'Could not assemble the brief.');
    }
    const brief = buildMorningBrief({ ownerName, bundle, orders });

    /* Optionally let the model narrate it warmly. If no key, return the
       structured brief and let the client render it directly (graceful). */
    const key = geminiKey();
    let narration = '';
    if (key && (data && data.narrate !== false)) {
      try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({
          model: 'gemini-1.5-flash',
          systemInstruction: 'You are Orbit AI greeting the OWNER of Express Goods Carrier with a morning brief. Speak warmly and briefly, like a trusted senior colleague, addressing them by name. Use ONLY the figures provided in the JSON — never add, estimate, or invent any number. Present it as a short, skimmable list of points, then the recommendation(s). Mirror the owner\'s likely language (Hindi/Hinglish is welcome for an Indian transport business, but keep numbers and ₹ clear).',
        });
        const r = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: 'Here is the brief data as JSON. Narrate it.\n' + JSON.stringify(brief) }] }] });
        narration = r.response.text();
      } catch (e) { narration = ''; /* fall back to structured */ }
    }

    return { brief, narration, ownerName };
  });

/* ============================================================================
   ORBIT INSIGHT — proactive, context-aware line for the current screen.
   The client calls this when the user opens the assistant on a given page, so
   Orbit AI can speak first ("you have ₹4.2 lakh outstanding; chase Acme") with
   REAL data, scoped to the user's role. Returns { text, suggest? } or null
   (null = nothing genuinely useful to say → the AI stays quiet, never invents).
   ============================================================================ */
exports.orbitInsight = functions
  .region('us-central1')
  .runWith({ timeoutSeconds: 30, memory: '512MB' })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Please sign in.');
    const email = (context.auth.token && context.auth.token.email) || '';
    const uid = context.auth.uid;
    const isOwner = email && email.toLowerCase() === OWNER_EMAIL.toLowerCase();
    const authCtx = { uid, email, isOwner };
    const da = new DataAccess(db, authCtx);
    const pageCtx = (data && data.context) || {};

    try {
      if (isOwner) {
        // Only assemble the (heavier) accounting bundle for accounting pages
        // that actually use it; keep it light otherwise.
        const needsBundle = pageCtx.page === 'accounting';
        if (!needsBundle) {
          // Non-accounting owner pages currently have no always-on insight;
          // the morning brief covers the dashboard. Stay quiet.
          return { insight: null };
        }
        const bundle = await da.accountingBundle();
        const api = reports(bundle);
        const insight = ownerInsight(api, pageCtx, {});
        return { insight };
      }
      // Customer: most-recent active shipment (their own only)
      const orders = await da.myOrders(50);
      const active = orders
        .filter((o) => o.status && o.status !== 'cancelled')
        .sort((a, b) => {
          const av = (a.updatedAt && a.updatedAt._seconds) || 0;
          const bv = (b.updatedAt && b.updatedAt._seconds) || 0;
          return bv - av;
        })[0] || null;
      const insight = customerInsight(active, pageCtx);
      return { insight };
    } catch (e) {
      // Insights are best-effort; never block the UI or leak errors.
      return { insight: null };
    }
  });

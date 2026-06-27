# Orbit AI — Setup, Deploy & Verify

Orbit AI is the built-in assistant for Orbit Logistics. It behaves like a senior
transport accountant + dispatcher + ERP operator: it understands the full
workflow, guides the user, opens the right module, explains accounting in plain
language, and answers from real data — **strictly scoped to the user's role**.

It is built as a **secure server-side mediator** (a Firebase Callable Cloud
Function). The Gemini API key lives only on the server. The AI is never a
privilege boundary: it can only ever see data the signed-in user is already
allowed to see, and it can only *draft* actions (e.g. a manual order), never
commit them — creation still flows through the existing pipeline and Firestore
rules.

---

## Architecture

```
Browser (orbit-ai.js)
   │  message + recent history + page-context hint + Firebase ID token
   ▼
Cloud Function  orbitAI   (functions/index.js)
   │  1. Firebase verifies the ID token  → trustworthy uid + email
   │  2. role derived server-side (owner vs customer) — never from the client
   │  3. DataAccess bound to that verified identity (functions/data-access.js)
   │       • customer queries hard-scoped: where customerUid == uid
   │       • owner-only collections refused for customers
   │  4. Gemini function-calling loop, offered ONLY role-appropriate tools
   │       • data tools run through the scoped layer
   │       • accounting tools reuse the REAL ACC engine (accounting-bridge.js)
   ▼
Gemini (key held server-side only)
```

### Files

| File | Role |
|------|------|
| `functions/index.js` | Callable functions: `orbitAI` + `orbitMorningBrief` |
| `functions/morning-brief.js` | Proactive owner daily brief (real figures only) |
| `functions/data-access.js` | The security boundary — role-scoped reads |
| `functions/tools.js` | Tool schemas + executors (role-gated) |
| `functions/accounting-bridge.js` | Runs the real `acc-*.js` so numbers match the UI |
| `functions/sync-vendor.js` | Predeploy: copies accounting source into `functions/vendor` |
| `functions/test/orbit-ai.test.js` | Offline security/tool suite (48 checks) |
| `orbit-ai.js` / `orbit-ai.css` | The floating assistant UI (both dashboards) |

---

## Prerequisites

1. **Firebase Blaze plan** — Cloud Functions require it. (Spark/free cannot deploy functions.)
2. **A Gemini API key** from Google AI Studio. **Rotate the key** if it has ever been shared.
3. Firebase CLI: `npm install -g firebase-tools` and `firebase login`.

---

## One-time setup

```bash
# 1. install function dependencies
cd functions
npm install
cd ..

# 2. store the Gemini key on the SERVER (never in client code or git)
firebase functions:config:set gemini.key="YOUR_NEW_GEMINI_KEY"

# (optional) override the owner email if it ever changes
firebase functions:config:set orbit.owner_email="piyushmishra3734@gmail.com"
```

> The key is read by the function via `functions.config().gemini.key`. It is
> **never** sent to the browser. Do not place it in `firebase-config.js`,
> `orbit-ai.js`, or any client file.

---

## Deploy

```bash
# functions (the predeploy hook syncs the accounting source into functions/vendor)
firebase deploy --only functions

# hosting (serves the dashboards + orbit-ai.js/.css)
firebase deploy --only hosting

# rules/indexes if changed
firebase deploy --only firestore:rules,firestore:indexes
```

The function pins region **us-central1**, matching the client
(`firebase.functions('us-central1')` in `orbit-ai.js`). If you change the
region, change it in both places.

---

## Local development (emulator)

```bash
# set the key for the emulator
export GEMINI_KEY="YOUR_NEW_GEMINI_KEY"
cd functions && npm run serve     # firebase emulators:start --only functions
```

The function also reads `process.env.GEMINI_KEY` as a fallback for the emulator.

---

## Verification checklist (after deploy)

Automated, already passing offline (no network needed):

```bash
cd functions && npm test          # 48 security/tool checks
```

These prove the privilege boundary: a customer cannot reach another customer's
records (by list, id, or tool), cannot reach owner-only tools/collections, gets
a clean "not found" with no leak on cross-account lookups, and that even a fully
hijacked model cannot leak. Accounting answers come from the real engine.

**Live checks to run in the browser after deploy (require the model + network):**

Owner account:
- [ ] Open Orbit AI (floating button, bottom-right). Branding reads "Powered by Gemini".
- [ ] "Show unpaid customers" → returns real outstanding figures (match the Accounting screen).
- [ ] "Revenue this month" → matches the dashboard.
- [ ] "Find invoice INV-…" → returns that shipment's status/route/payment.
- [ ] "Why doesn't the trial balance match?" → explains; states whether it balances.
- [ ] "Create a manual order from Indore to Mumbai, freight 12000" → opens + pre-fills the Manual Order form (does NOT auto-create).
- [ ] "Explain GST / TDS" → plain-language explanation, no invented company numbers.

Customer account (use a real customer login):
- [ ] "Where is my shipment?" → navigates to Tracking / shows their shipment.
- [ ] "Show my payment status" → only their invoices.
- [ ] Ask for another company's invoice by number → AI says it can't find it / only shows your own. **It must never reveal another customer's data.**

**Security spot-check (most important):**
- [ ] Signed in as a customer, confirm Orbit AI never returns any order, invoice,
      LR, payment, accounting figure, report, or company belonging to anyone else,
      even when asked directly or with a specific known number.

---

## Cost & limits

- Each question is one function invocation + 1–5 Gemini calls (tool round-trips,
  capped at 5). Uses `gemini-1.5-flash` for low latency/cost.
- The function logs every query to `auditLogs` (action `orbit_ai_query`), so AI
  usage is auditable like the rest of the system.

---

## Security guarantees (summary)

- **Auth is server-verified** — the function trusts `context.auth` (Firebase
  verifies the ID token), never the request body.
- **Role is derived server-side** from the verified email.
- **Customer data is hard-scoped** at the query level; owner-only collections
  are refused; cross-account reads return null (indistinguishable from absent).
- **The LLM is not a boundary** — it only sees what the user could already read,
  and it cannot commit state changes (drafts only).
- **The key is server-only** — never shipped to the browser.

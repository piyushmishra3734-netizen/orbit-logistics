# Security Policy

Orbit handles real business and financial data. Security is treated as a
first-class, non-negotiable requirement.

## Security model (how Orbit protects data)

- **Auth + Firestore Rules are the boundary.** `firestore.rules` enforces that a
  customer can read only their own shipments/invoices/LRs and never company-wide
  accounting, other parties, or reports. The owner is identified by a verified
  email.
- **Orbit AI is never the privilege boundary.** Cloud Functions verify the
  caller's ID token server-side, derive the role from the verified email, and
  expose only role-scoped tools (`functions/data-access.js`). Cross-account reads
  return null (indistinguishable from "not found") with a defense-in-depth guard.
- **The Gemini API key is server-side only.** It is read from
  `functions.config().gemini.key` or `process.env.GEMINI_KEY` and never shipped to
  the browser.
- **No fabricated data.** The AI answers business facts only from tool results; if
  data doesn't exist, it says so.
- **Confirmation before mutation.** No state change happens without explicit
  user action.

## On the Firebase web API key

The Firebase **web** `apiKey` in `firebase-config.js` is *designed to be public* —
it only identifies the project. Real protection comes from Firestore Rules and
Auth, not from hiding it. For a clean public repo, the config and project id are
templated (`firebase-config.example.js`, `.firebaserc.example`) and the real files
are git-ignored.

## Secrets policy

- Never commit `firebase-config.js`, `.firebaserc`, `.env`, `.runtimeconfig.json`,
  or any Gemini key. These are git-ignored.
- If a Gemini key is ever exposed (committed, pasted in a chat/issue, logged),
  **rotate it immediately** in Google AI Studio / Google Cloud. No source file
  depends on a specific key value.
- Do not store secrets in `userMemories`, comments, or test fixtures.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

1. Email the maintainer (the project owner) with details and reproduction steps.
2. Allow reasonable time for a fix before any public disclosure.
3. We will acknowledge the report and keep you updated on remediation.

## Hardening checklist before going live

- Replace the owner email constant for your business across rules, functions and
  client.
- Deploy `firestore.rules` and `firestore.indexes.json`.
- Verify, in a real browser, that a customer cannot reach any other customer's
  data, the journal, reports, or accounting.
- Confirm the Gemini key is server-side only and rotated if ever exposed.
- Replace the UDYAM placeholder in `invoice.js`.

# Changelog

All notable changes to Orbit Logistics are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-06-27

First clean, GitHub-ready baseline. Feature-complete and extensively tested
offline; live deployment verification is still required before production use.

### Core ERP
- Quote → Order → Invoice → Lorry Receipt → Accounting → Reports pipeline.
- Customer quote requests with owner approval; **owner manual orders** for phone
  bookings sharing the same canonical pipeline.
- GST-aware invoicing, advances, part-payments, transport-specific charges.
- Lorry Receipt (LR/Bilty) with E-Way Bill fields, delivery acknowledgement and
  signature/seal area.

### Accounting
- Double-entry engine with Chart of Accounts and auto-posting on approval/payment.
- Derived reports: Customer Ledger, Outstanding (ageing), Sales/Purchase Register,
  Cash & Bank Book, Trial Balance, P&L, Balance Sheet.
- Plain-language vouchers (**Receive Payment / Make Payment / Cash ↔ Bank**),
  jargon-free pickers, human confirmations that persist past background refreshes.

### Orbit AI
- Secure server-side assistant (Cloud Functions); Gemini key never on the client;
  never bypasses Firestore rules.
- Adaptive persona (casual ↔ teacher ↔ consultant ↔ operator ↔ mentor) with four
  invariant rules: honesty as an AI, no fabricated data, absolute security,
  confirm before mutation.
- **Morning Brief**, **Business Health Score**, proactive **page insights**,
  **"Explain like I'm new"** accounting help, conversation memory.
- Harmless usage learning (client-only) to rank suggestions and offer one-click
  recalls (e.g. a customer's last route) — always confirmed, never auto-applied.

### Usability
- First-run guidance and actionable empty states.
- One-click **Record Payment** from unpaid invoices, with optional one-click order
  sync after a linked receipt (no double entry).
- Persistent **"delivered — still to collect"** band so payments are never forgotten.
- Manual-order success offers the natural next step (print LR + Invoice).
- Customer "no changes since your last visit" to avoid notification fatigue.

### Tooling & release
- Offline test suites: functions logic (orbit-ai, morning-brief, page-insight) and
  app/UI (e2e, edge, regression, ui, ui-ai, ui-accounting).
- Project cleaned for GitHub: removed abandoned scratch code, old build artifacts
  and regenerable vendor files; templated Firebase config and project id; added
  `.gitignore`, README and contributor/security/release docs.

### Security
- No secrets committed. Firebase web config and project id are templated
  (`*.example`) and git-ignored. Firebase web apiKey is public-by-design; real
  access control is in `firestore.rules` + Auth.

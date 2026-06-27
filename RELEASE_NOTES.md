# Release Notes — Orbit Logistics v1.0.0

**Date:** 2026-06-27
**Type:** First clean, GitHub-ready baseline

This release establishes the stable baseline that future development builds on.
It is **feature-complete and extensively tested offline**. Live deployment
verification on a Blaze-plan Firebase project is required before production use.

## What's in this release

A complete road-freight ERP — Quote → Order → Invoice → Lorry Receipt →
Accounting → Reports — with:

- Customer quote flow and owner manual orders (phone bookings) through one
  canonical pipeline.
- GST-aware invoicing and LR/Bilty generation (E-Way Bill fields, delivery
  acknowledgement, signature/seal).
- A jargon-free double-entry accounting workspace with all standard registers and
  financial statements, derived strictly from the SSoT Order document.
- **Orbit AI** — a secure, server-side AI business partner: Morning Brief,
  Business Health Score, proactive page insights, plain-language accounting
  teaching, conversation memory, and harmless usage learning — with hard
  invariants (no fabrication, absolute security, confirm before mutation).

## Repository preparation in this release

- Removed abandoned scratch code (an early `functions/` prototype), an old build
  artifact (`release/`), and regenerable vendor files.
- Stripped debug `console.log` listener traces that leaked uid/result counts.
- Templated project-specific config: `firebase-config.example.js` and
  `.firebaserc.example`; real config + project id are now git-ignored.
- Verified **no secrets** anywhere in the tree; the only Firebase web apiKey is
  public-by-design and has been replaced with a placeholder.
- Added README, LICENSE (MIT), CHANGELOG, CONTRIBUTING, SECURITY, and this file.
- Confirmed all HTML script/link references and all `require()` paths resolve.

## Test status (offline)

All suites green at release time:

| Suite | Checks |
| --- | --- |
| functions/orbit-ai | 99 |
| functions/morning-brief | 16 |
| functions/page-insight | 19 |
| qa/e2e | 91 |
| qa/edge | 37 |
| qa/regression | 61 |
| qa/ui | 47 |
| qa/ui-ai | 46 |
| qa/ui-accounting | 17 |

> These are **offline** results (mocked Firestore, no live Gemini). They verify
> logic, security scoping, and UI wiring — not the live model's behaviour.

## Before production

Follow the **Production Deployment Checklist** in the README. In particular:
deploy rules/indexes, configure the Gemini key server-side (rotating any exposed
key), replace the owner email and UDYAM placeholder for your business, and perform
the in-browser owner/customer security spot-checks on the deployed build.

## Not in this release (roadmap)

WhatsApp/email reminder *sending*, payment-date prediction, cash-flow forecasting,
response streaming, and a configurable owner identity.

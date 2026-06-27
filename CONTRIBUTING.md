# Contributing to Orbit Logistics

Thanks for your interest in improving Orbit. This project favours **reducing
friction over adding features** — the best contributions make daily work easier,
not the feature list longer.

## Guiding principles (please honour these)

- **Single Source of Truth.** The Order document is master. Invoice, LR,
  Accounting, Reports and Excel must *project* from it — never maintain parallel
  state.
- **No duplicated logic.** Reuse existing modules (`SHIP.computeCharges`, the
  accounting engine, the order pipeline) instead of re-implementing.
- **No fabricated numbers.** Business figures come only from real data/tools. If
  the ERP doesn't track something, say so — never invent it.
- **Security before convenience.** Never widen data access for UX. The
  owner/customer boundary in `firestore.rules` and `functions/data-access.js` is
  absolute.
- **Explain before acting; confirm before mutation.** Any state change is
  user-initiated and confirmed. The AI may *suggest* actions, never perform them
  silently.
- **No build step.** The frontend is intentionally plain, statically-served JS.

## Before you open a PR

1. **Read the relevant code first.** Inspect existing components before writing
   new ones.
2. **Keep changes modular and minimal.** Prefer the smallest change that solves
   the problem.
3. **Browser-test your change** (the `qa/ui*.js` Playwright suites) and **run the
   full regression**:
   ```bash
   node EGC-Logistics-System/functions/sync-vendor.js
   node EGC-Logistics-System/functions/test/orbit-ai.test.js
   node EGC-Logistics-System/functions/test/morning-brief.test.js
   node EGC-Logistics-System/functions/test/page-insight.test.js
   cd qa && node e2e.js && node edge.js && node regression.js \
     && node ui.js && node ui-ai.js && node ui-accounting.js
   ```
   All suites must be green.
4. **Add/adjust tests** for any behaviour you change.
5. **Never commit secrets.** `firebase-config.js`, `.firebaserc`, `.env` and
   `functions/vendor/` are git-ignored — keep it that way.

## Coding style

- Vanilla JS, window-namespaced modules (`EGC`, `INV`, `LR`, `SHIP`, `OWN`,
  `CUST`, `DASH`, `CO`, `ACC`, `TOS`).
- Match the surrounding code; keep functions small and readable.
- Comment the *why*, not the *what*.
- Indian transport domain vocabulary is expected (LR/bilty, consignor/consignee,
  GST/IGST, FOV, halting, Udyam, etc.).

## Commit messages

Use clear, imperative summaries (e.g. "Add delivered-unpaid collect band to order
card"). Reference the screen/workflow affected.

## Reporting issues

Open an issue describing the workflow, what you expected, and what happened. For
**security** issues, follow [`SECURITY.md`](SECURITY.md) instead of filing a
public issue.

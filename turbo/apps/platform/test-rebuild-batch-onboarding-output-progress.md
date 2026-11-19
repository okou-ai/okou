# Onboarding output, skips, and draft progress

| File                      | Frozen rows | Selected and passing rows |
| ------------------------- | ----------: | ------------------------: |
| onboarding-output-formats |           7 |                         4 |
| onboarding-entry-skip     |          12 |                         6 |
| onboarding-preview-skip   |          11 |                         6 |
| onboarding-progress       |          16 |                         8 |
| onboarding-pasted-text    |          15 |                         8 |
| Total                     |          61 |                        32 |

The tests enter through the production Router and retain the selected frozen
actions and assertions. The GWT checklist records each scenario against its
registration. The execution ledger matches all 32 Vitest rows to the selection
in both directions.

The draft rollback test returns the current typed 404 error envelope from the
fixture. It still exercises an unavailable draft endpoint and checks that the
browser draft restores the ready step and task text. The paste tests cover
private upload, failure and retry, clipboard fallback, the attachment cap, the
10 MB boundary, locale changes, and navigation cancellation.

Targeted Vitest, the test TypeScript project, ESLint, and Oxlint passed. The
five corresponding BDD files were removed. The browser-card computed-style
and browser-session renewal evidence is retained in the earlier batch records.

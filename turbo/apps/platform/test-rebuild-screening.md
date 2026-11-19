# App test rebuild screening and review sample

The screen uses the 5,111 runnable scenarios frozen at b0a10287edf42.
See [the per-ID ledger](test-rebuild-screening.tsv) for a disposition and
reason for each scenario. The [upstream reconciliation](test-rebuild-upstream.md)
tracks the separate incoming changes from main 4b72b660f827.

The first pass proposes 4,840 retains, 202 consolidations, seven removals
and 62 items for further review. Consolidations reference a proposed retained
donor and remain conditional on current-source comparison. The seven
removals are direct tests of MSW's test harness. The BDDs remain available as
evidence. The first pass supports candidate selection and does not establish
the final net reduction.

All 65 original intent flags were investigated against the source. The
source-assisted pass returned 64 dispositions. The SharedWorker realtime
case was checked directly and still needs a decision about the production
boundary. Preview credential isolation, protocol handling, theme contrast
and browser layout need a separate owning-boundary decision before removal.
Protect real permission, recovery and tenant isolation outcomes while
reviewing these cases.

The two upstream Enable outcomes are retain candidates. Retain the retry
and exact-target guarantee as well as the already-recovered outcome that
clears a stale update without restarting the automation. These additions
are outside the frozen denominator.

## Representative sample

The [signed-out unsubscribe page tests](src/views/email-unsubscribe/__tests__/email-unsubscribe-page.test.tsx)
map to email-unsubscribe-page-001 through email-unsubscribe-page-003. On
this main revision, focused Vitest passed all three scenarios with one
worker. Each exercise uses the real route and Router, a case-owned
testContext, the documented click helper and a user-observable sentinel.
The invalid and successful responses use the typed HTTP mock, and the
missing-token case needs no endpoint response. The BDD remains adjacent
while the sample is under review.

Ethan review points:

- Confirm the sample's scope for the missing-token and invalid-token paths.
  The visible error and the presence of a submit action distinguish the paths.
- Review an additional sample that receives an external asynchronous event
  or retries an operation, such as the updated Automation paused card.
- Confirm which transport, accessibility and layout cases deserve separate
  owning-boundary coverage. Verify consolidation donors across batches,
  then revisit the gap to the 30% target before declaring screening complete.

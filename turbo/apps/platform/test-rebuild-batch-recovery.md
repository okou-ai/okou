# Workflow attribution and recovery screening

The [Workflow attribution](test-rebuild-workflow-attribution.tsv) accounts
for all eight executions removed upstream in #48898. Credit two frozen
deductions to that PR. Three remaining results retain separately tested
route or status guarantees and three require further coverage
comparison. The two upstream additions remain tracked separately.
Each credited removal has one stable donor with source evidence.

The [recovery review](test-rebuild-recovery-review.tsv) covers all 77
browser automatic recovery and 58 chat model rows at 77 registration
sites. It is a source-assisted pass with 123 provisional retains and 12
rows for deeper comparison. Browser recovery varies by failure timing,
connection role, membership and ownership of input receipts. Model
recovery maps structured reasons to different descriptions, controls
and continuation behavior. A shared retry renderer or test helper does
not establish equivalent transitions. No deduction is credited here.

The [boundary review](test-rebuild-boundary-review.tsv) covers 15 auth URL
diagnostics rows and nine scheduling utility rows. One diagnostics test
is fully carried by the existing Telegram parameter row. Keep separate
console and PostHog redaction coverage while these sinks remain active.
Scheduling utilities exercise real command behavior, including separate
App and worker Store ownership. Locate production consumers and match
their outcomes before deciding placement or removal.

## Counting and next review

The [deduction ledger](test-rebuild-confirmed-deductions.tsv) now records
15 confirmed net removed frozen executions, including two attributed to
the upstream Workflow PR. That is 0.29% of 5,111, leaving 1,519 to reach
the 1,534 threshold. The changes attributed to upstream are included once
in the frozen count. Cases without a verified donor stay outside it.

The 107 retirement-or-compatibility flags, 137 potential internal
assertion rows and 1,018 matching API contract names are previous source
scan counts. The sets overlap and measure candidates rather than
savings. Even complete removal of the first two sets would contribute
at most 244 executions before overlap. The API signal can find repeated
transport checks but the current pass provides no broad evidence that
their page outcomes are covered elsewhere. The current evidence
does not show a credible path to the threshold from these bins alone.

Next, inspect retirement mentions by actual route and feature removal,
then compare app-versus-API authorization and error matrix families
using matched contract operations and first-party callers. Retain
user-visible and scope-sensitive guarantees. Keep samples and rebuild
pending while the deletion gate remains unmet.

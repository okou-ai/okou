# App test rebuild deletion gate

The frozen denominator is 5,111 registered executable rows from
b0a10287edf42. The rebuild may resume once at least 1,534 frozen rows
are confirmed net removals, leaving at most 3,577 baseline-equivalent
executions. A consolidation counts only if a stable retained donor
covers the original precondition, trigger and observable outcome,
including meaningful differences among parameter rows. Track any extra
coverage needed to replace baseline cases in the net calculation. The
two upstream additions in [the upstream inventory](test-rebuild-upstream.md)
are recorded separately.

## Evidence and status

- The [source audit](test-rebuild-source-audit.tsv) covers the 202 original
  merge candidates and 62 review items. It records 82 recommendations to
  retain, 146 requiring review and 36 potential consolidations. The audit
  records source and donor line references. 257 comparisons were assisted
  by a model, with direct source checks for missing results and selected
  findings. Candidate decisions require independent verification before
  they count.
- Seven previously source-checked test-harness cases are confirmed removals.
  This is 0.14% of the frozen baseline and leaves 1,527 further confirmed
  net removals needed. Even all 36 potential consolidations would raise the
  count only to 43, or 0.84%.
- A scan of the 4,840 initial retain rows found no cross-file identical
  Given / When / Then wording and found 12 [cross-file title overlaps](test-rebuild-cross-file-review.tsv).
  This retrieval pass surfaces leads for comparison. It establishes no
  consolidation or product equivalence.
- The SharedWorker check directly observes an Ably subscription and token
  count. In current source, the permission-allow signals use the event to
  invalidate the grant list and host-authorization-block refreshes its
  approval eligibility. The visible card update in
  chat-capability-permissions-004 is a candidate for covering grant
  refresh. Check the host-approval and transport guarantees separately.

## Confirmed comparison batch

The [pair decisions](test-rebuild-pair-decisions.tsv) record both frozen
scenarios and the reason for the disposition across 36 consolidation
candidates and 12 cross-file overlaps. One row can consolidate into its
linked retained scenario. The other 47 comparisons retain their distinct
route, actor, provider, action ordering or visible result. The retired
onboarding team route has a single unconditional redirect, and its
admin and member fixtures prove the same destination and redeem code.

The [confirmed additions to the deduction ledger](test-rebuild-confirmed-deductions.tsv)
record that consolidation and four harness-only removals. Including the
seven previously confirmed harness rows, the cumulative confirmed net
reduction is 12 of 5,111 rows (0.23%), leaving 1,522 needed. No upstream
addition is counted in that reduction.

## Browser address submission

[The address matrix review](test-rebuild-address-matrix.tsv) maps all 82
rows to source registrations and behavior families. Compare the fixtures
and expected destinations against addressSubmission and its normalization,
navigation-intent and completion branches. Ordinary Enter and Ctrl+Enter
are different public triggers. The host-length boundary, Unicode query
encoding, composition, and paste filtering carry distinct guarantees.
Some same-family variants still need a narrower branch comparison. No
row from this matrix contributes to the cumulative deduction yet.

Continue source-backed screening by module. Prioritize large address
submission, browser viewer and remote access matrices. Review fixtures
and product branches before grouping parameter rows. Keep the automation
retry sample and further rebuild work pending until the deletion gate is
met.

## Latest tally

See [authorization, subscription and recovery screening](test-rebuild-batch-authorization-feedback.md)
for the current count of 64 confirmed frozen deductions and the remaining
1,470-row gap. Earlier figures are batch checkpoints.

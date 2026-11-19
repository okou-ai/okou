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

Continue source-backed screening by module. Start with the 36 possible
donors, then review same-module parameter matrices and cross-file user
journeys. Keep the automation retry sample and further rebuild work pending
until the deletion gate is met.

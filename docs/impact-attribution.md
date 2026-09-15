# Impact attribution

Impact attribution is owned by Marketing. See [the current handoff and billing
contract](impact-marketing-handoff.md).

The old App cookie/query collector, Clerk and organization attribution sync, and
Stripe click snapshots have been retired. The nullable columns introduced by
migration `1102_impact_attribution` remain for deployment compatibility with older
API processes; current code neither reads nor writes them for attribution.
Applied migrations are immutable. Historical Stripe receipts remain readable by
Marketing for deduplication and refund corrections, never as consent evidence.

# API-first run usage handoff

API-first Pi inference does not traverse the Runner MITM addon. When API-first
execution transfers ownership to a Sandbox, the API therefore includes the
usage it has observed in the existing handoff payload:

- legacy ownership transfer: `PiApiFirstTurnManifest.apiUsage`
- durable ownership transfer: `PiSandboxContinuation.apiUsage`

The contract and tolerant readers are delivered by #34787. Issue #35413 enables
the producer only after those readers are deployed and older strict readers
have drained. The snapshot is observational. It does not change billing,
execution ownership, output publication, retry behavior, or whether a Sandbox
is launched.

`observed` carries the provider evidence available at the handoff boundary as
disjoint ordinary input, cache-read, cache-creation, and output quantities.
Each quantity is either a non-negative safe integer or `null` when the provider
did not establish it. Coverage remains `complete`, `partial`, or `unavailable`;
`complete` requires every quantity to be known, `partial` requires at least one
known quantity, and `unavailable` requires every quantity to be `null`. Known
zero is preserved as zero. `no-inference` is emitted only when ownership
transfers before any provider attempt can start.

Absence of `apiUsage` means the producer has no handoff-time snapshot. Readers
must treat absence as unavailable, never as zero. This includes payloads from an
older API, reconstructed historical results without retained provider evidence,
and transfers that occur while a provider result is still unknown. The initial
feature does not backfill a result that arrives after ownership has already
transferred.

The handoff objects intentionally strip unknown additive fields instead of
rejecting the payload. Semantic discriminants, versions, identities, bounds,
and token quantities remain validated. This keeps old payloads readable and
allows this producer to add optional metadata without breaking the deployed
reader.

There is no API usage table or Runner read endpoint in this source. A compatible
Runner can capture the durable continuation from its assigned run and combine
the API snapshot once with the independently sampled MITM source. The combined
query must continue to expose source-level coverage and freshness; handoff
metadata does not make the two sources atomic.

# API-first run usage handoff reader contract

API-first Pi inference does not traverse the Runner MITM addon. When API-first
execution transfers ownership to a Sandbox, compatible readers can accept an
optional API usage snapshot on either existing handoff carrier:

- legacy ownership transfer: `PiApiFirstTurnManifest.apiUsage`
- durable ownership transfer: `PiSandboxContinuation.apiUsage`

Issue #34787 prepares the contract and readers only. The API producer remains
disabled until #35413, after these readers are deployed and older strict readers
have drained. The snapshot is observational: accepting it does not change
billing, execution ownership, output publication, retry behavior, or whether a
Sandbox is launched.

`observed` carries the provider evidence available at the handoff boundary as
disjoint ordinary input, cache-read, cache-creation, and output quantities.
Each quantity is either a non-negative safe integer or `null` when the provider
did not establish it. Coverage remains `complete`, `partial`, or `unavailable`;
`complete` requires every quantity to be known, `partial` requires at least one
known quantity, and `unavailable` requires every quantity to be `null`. Known
zero is preserved as zero. `no-inference` identifies ownership transferred
before any provider attempt could start.

Absence of `apiUsage` means there is no handoff-time snapshot. Readers must treat
absence as unavailable, never as zero. This includes all payloads before #35413,
payloads from an older API, reconstructed historical results without retained
provider evidence, and future transfers that occur while a provider result is
still unknown.

The handoff objects intentionally strip unknown additive fields instead of
rejecting the payload. Semantic discriminants, versions, identities, bounds,
and token quantities remain validated. This keeps old payloads readable and
allows the later #35413 producer to add optional metadata without breaking the
deployed reader.

There is no API usage table or Runner read endpoint in this source. A compatible
Runner can capture the durable continuation from its assigned run and combine
the API snapshot once with the independently sampled MITM source. The combined
query must continue to expose source-level coverage and freshness; handoff
metadata does not make the two sources atomic.

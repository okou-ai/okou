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

## Current-assignment query

When the `runUsage` switch was captured as enabled for an official API-backed
assignment, the Runner freezes the host-assigned Run identity, the immutable
durable-continuation observation and the current MITM addon generation before
Agent work starts. The guest can then call `run.usage` with exactly empty
parameters:

```json
{ "version": 1, "method": "run.usage", "params": {} }
```

The method accepts no Run ID, addon generation, path, endpoint or source totals.
It requires no SSH grant. The result is versioned and source preserving:

```json
{
  "schemaVersion": 1,
  "runId": "a0000000-0000-4000-8000-000000000001",
  "combined": {
    "state": "observed",
    "coverage": "partial",
    "observedTokens": {
      "input": 12,
      "cacheRead": 2,
      "cacheCreation": 3,
      "output": 4,
      "total": 21
    }
  },
  "sources": {
    "apiFirstTurn": {
      "state": "observed",
      "sampledAt": 1720000000000,
      "coverage": "partial",
      "tokens": {
        "input": 5,
        "cacheRead": null,
        "cacheCreation": null,
        "output": null,
        "total": null
      }
    },
    "sandboxProxy": {
      "state": "observed",
      "sampledAtMs": 1720000001000,
      "revision": 3,
      "coverage": "complete",
      "reasons": [],
      "observedResponses": 1,
      "outstandingResponses": 0,
      "tokens": {
        "input": 7,
        "cacheRead": 2,
        "cacheCreation": 3,
        "output": 4,
        "total": 16
      }
    }
  }
}
```

`apiFirstTurn` is one of:

- `unavailable` with `missing-handoff` or `invalid-handoff`;
- `no-inference` with the non-negative safe-integer epoch-millisecond
  `sampledAt` value, including valid zero;
- `observed` with `complete`, `partial` or `unavailable` coverage and nullable
  token categories. Its `total` is present only when every category is known.

`sandboxProxy` is either an observed MITM snapshot or `unavailable` with
`not-observed`, `launch-unavailable`, `busy`, `timed-out`, `invalid-response`
or `transport`. An observed source preserves its independent sample time,
generation-local revision, coverage reasons, response counts and outstanding
inference. Complete MITM coverage has no reasons; partial coverage retains the
bounded sticky reasons reported by the addon.

`combined` is `observed`, `unavailable` or `overflow`. An observed result adds
each known handoff quantity once to one on-demand MITM snapshot; it never adds a
previous query result. Complete combined coverage requires a complete or
`no-inference` API source and a complete MITM source. All other observed values
are lower bounds and remain partial. If neither source establishes a numeric
observation, the reason is `no-observation`. If a category or the combined total
would exceed JavaScript's safe-integer range, the Runner emits `overflow`
without unsafe combined integers and retains both source records.

The API and MITM times are deliberately independent. A complete source cannot
repair missing history in the other source, and the handoff remains immutable:
provider usage first observed after ownership transfer is not backfilled.
`okou run usage` renders these distinctions; `okou run usage --json` wraps a
valid result as `{ "schemaVersion": 1, "status": "ok", "usage": ... }`.
Errors use `{ "schemaVersion": 1, "status": "error", "error": { "kind":
..., "delivery": ... } }`, exit nonzero and are never retried or replaced by
billing rows, logs, history or an API request.

This query is observational debugging and telemetry. It is not billing,
settlement, credit calculation, a final provider total or historical Run
reporting.

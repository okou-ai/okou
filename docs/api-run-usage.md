# Sandbox run usage

Foreground Pi inference and usage belong to the Sandbox and Runner. The
current query exposes the Runner's independently sampled MITM source, not an
API-owned inference handoff. Unknown usage remains unavailable rather than
being coerced to zero.

## Current-assignment query

For every official API-backed assignment, the Runner freezes the host-assigned
Run identity and the current MITM addon generation before Agent work starts. The guest can then call
`run.usage` with exactly empty parameters:

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
      "input": 7,
      "cacheRead": 2,
      "cacheCreation": 3,
      "output": 4,
      "total": 16
    }
  },
  "sources": {
    "sandboxProxy": {
      "state": "observed",
      "sampledAtMs": 1720000001000,
      "revision": 3,
      "coverage": "partial",
      "reasons": ["missing_usage"],
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

`sources` contains only `sandboxProxy`. Unsupported source shapes are treated
as `invalid-response`.

`sandboxProxy` is either an observed MITM snapshot or `unavailable` with
`not-observed`, `launch-unavailable`, `busy`, `timed-out`, `invalid-response`
or `transport`. An observed source preserves its independent sample time,
generation-local revision, coverage reasons, response counts and outstanding
inference. Complete MITM coverage has no reasons; partial coverage retains the
bounded sticky reasons reported by the addon.

`combined` is `observed`, `unavailable` or `overflow`. An observed result
carries one on-demand MITM snapshot; it never adds a previous query result.
Combined coverage is the MITM coverage, and partial values are lower bounds. If
the MITM source establishes no numeric observation, the reason is
`no-observation`. If a category or the total would exceed JavaScript's
safe-integer range, the Runner emits `overflow` without unsafe combined
integers.

`okou run usage` renders these distinctions; `okou run usage --json` wraps a
valid result as `{ "schemaVersion": 1, "status": "ok", "usage": ... }`.
Errors use `{ "schemaVersion": 1, "status": "error", "error": { "kind":
..., "delivery": ... } }`, exit nonzero and are never retried or replaced by
billing rows, logs, history or an API request.

This query is observational debugging and telemetry. It is not billing,
settlement, credit calculation, a final provider total or historical Run
reporting.

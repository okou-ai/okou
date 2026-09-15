# Run cancellation reconciliation

API slice [#34383](https://github.com/vm0-ai/vm0/issues/34383) supplies durable
stop intent for the Runner reconciliation work in
[#34384](https://github.com/vm0-ai/vm0/issues/34384), under
[#34359](https://github.com/vm0-ai/vm0/issues/34359).

## Stored intent

`agent_runs.runner_cancellation_mode` is nullable text constrained to
`cooperative` or `hard`. NULL means no recorded stop intent, including historical
rows; terminal status alone must not be interpreted as a hard stop. There is no
backfill, cancellation journal, tombstone, or history-retention change.

- Ordinary cancellation persists the effective mode in the same transaction as
  the terminal transition and queue removal. Historical Runs without cancellation
  recovery retain their existing hard-cancellation behavior, now persisted before
  publication.
- A genuine hard request may upgrade an already-cancelled Run under the same row
  lock, without resetting completion or recovery state. Cooperative requests
  never downgrade hard intent. Repeated hard requests do not republish it.
- Threadless cleanup hard-cancels active candidates, but preserves any existing
  cancellation intent when retrying terminal cleanup or losing a race with
  another cancellation. Cleanup redrive is not a new hard request.
- Member revocation, account/organization deletion, timeout cleanup, and Pi
  API-first completion persist hard intent in their existing terminal transaction.
  Ordinary Guest completion records no new stop intent.
- Queue-only expiration and pre-claim erasure have no claimed execution to stop;
  their existing transitions remain unchanged.

Ably publication stays the fast path. Its payload and consumers are unchanged;
the canonical cancellation dispatcher publishes the committed effective mode.
Deletion may subsequently remove the Run row, as it does today.

## Authenticated read

`GET /api/runners/runs/:runId/cancellation` accepts the existing signed sandbox
Run token as a Bearer credential and query parameters `runnerGroup`, `runnerId`
and `heartbeatGeneration`. The token must be unexpired, have sandbox scope, and
match the path Run ID. No live user, organization, membership or Run join is
required to authenticate this narrow endpoint, so the token remains useful
after deletion until its existing expiry.

Responses have `protocolVersion: 1`, the authenticated `runId`, and one of:

| State                                    | Meaning                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `present`, `mode: null`                  | Matching Run exists with no recorded stop intent.                        |
| `present`, `mode: cooperative` or `hard` | Matching Run exists with explicit stop intent.                           |
| `gone`                                   | An authoritative primary-database lookup by Run ID found no row.         |
| `unavailable`                            | A row exists but its owner, organization, group or claim does not match. |

The lookup deliberately filters only by Run ID, then validates the other
attributes. Filtering by ownership or claim would incorrectly turn mismatches
into disappearance. Official claims compare Runner ID and generation exactly;
older/personal claims with both attributes NULL remain valid. Partially populated
claims are unavailable. Reads are marked `Cache-Control: no-store`.

Authentication failures, invalid requests, database failures, aborted requests,
missing endpoints, proxy responses, and unknown response versions are not proof
of disappearance. A consumer must validate the complete typed response and Run
identity before acting. The existing token lifetime is unchanged and this slice
adds no refresh path.

## Rollout

Apply migration 1143 before promoting the new API. The new column has no default,
so every existing row receives NULL and already satisfies the CHECK. The CHECK
intentionally remains `NOT VALID`: new inserts and updates are enforced without
an unnecessary historical-row scan or follow-up validation migration. The
migration runner retains its one-second lock and ten-second statement limits.
Existing API and Runner versions continue to work after this nullable additive
migration; old writers leave the field NULL. New API code requires the column.
Keep the additive schema if rolling API code back.

Deploy this API slice across the serving fleet before enabling Runner polling in
#34384. Mixed or rolled-back API versions can return an unsupported endpoint or
omit durable intent; the Runner must treat those outcomes as unavailable and
retain its existing stop mechanisms. An API-only deployment does not establish
a new maximum stop delay: polling, local registration, exact-instance guards,
shutdown ownership and Runner-side failure policy belong to #34384.

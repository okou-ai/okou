# Run cancellation reconciliation

API slice [#34383](https://github.com/vm0-ai/okou/issues/34383) supplies durable
stop intent consumed by Runner reconciliation in
[#34384](https://github.com/vm0-ai/okou/issues/34384), under
[#34359](https://github.com/vm0-ai/okou/issues/34359).

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

## Runner ownership and delivery

ApiProvider captures the current cancellation handle before sending a claim.
Only a successful response with a validated matching Run ID can attach an
observer to that captured registration. The observer uses the claim's sandbox
token and the provider's group, Runner ID and heartbeat generation. It starts
before execution handoff, including for Runs without active input, and remains
eligible through preparation, execution, cooperative recovery and final cleanup.
LocalProvider does not start observers. PAT-backed claims retain their existing
claim permission boundary and use their returned sandbox credential for reads.

Each registration owns one tracked observer with independent read and delivery
futures. HTTP permits are released before delivery. One watch slot retains the
strongest observed stop mode; hard supersedes a queued cooperative delivery.
Delivery uses the same monotonic cancellation signals and transfer gate as Ably.
A blocked gate does not hold HTTP capacity or prevent another Run's delivery.
Cooperative cancellation does not retire the observer: a later hard escalation
must still be observed.

Retirement has its own token. Unregister retires the exact entry before making
its Run ID available again, cancels queued and in-flight reads and gate waits,
then waits for the observer outside the registry lock. Reconciled delivery
rechecks retirement after acquiring the gate and uses the shared monotonic
signal update. Existing Ably and LocalProvider entry points retain their
behavior. A late result never looks
up a successor by Run ID. Provider shutdown prevents new observer admission and
drains all observers; dropping the provider also cancels their work. Completed
observer tasks retain no active sandbox credentials.

Only HTTP 200 with an exact, bounded v1 response can make a stop decision. The
Runner decodes the generated response type and additionally validates required
fields, permitted fields, version and exact Run ID. The ten-second deadline
covers the request, body read and decoding. Both declared and streamed bodies
are limited to 4096 bytes. Errors log a bounded category without bearer tokens
or response content, and are rechecked at the ordinary cadence.

## Cadence and observation bound

The first eligible read is immediate. Subsequent due times are anchored to the
previous dispatch plus thirty seconds, rather than response completion. Each
observer has at most one pending FIFO semaphore acquisition or HTTP request;
eight requests may be in flight across the provider. Missed ticks coalesce.
There are no immediate application retries, detached delivery tasks or retained
historical queue entries. State and tasks are proportional to eligible live
registrations, including cleanup overlap.

For maximum eligible population N during the observation window, assuming valid
credentials and successful API reads completing within ten seconds, a
conservative bound from committed intent to validated observation is:

`30 seconds + ceil(N / 8) * 10 seconds + local scheduling overhead`.

After a read that just misses the commit, the next due time is no later than
thirty seconds after that read's dispatch. A due acquisition joins the FIFO
queue once. At most N minus one other registrations can be ahead or occupying
permits; their queued rechecks and later arrivals cannot overtake that
acquisition. The request itself fits within the same ceiling of ten-second
waves. Queue saturation lengthens the effective per-Run interval instead of
creating more work. Below saturation the rate is approximately N/30 requests
per second. Examples are forty seconds for N <= 8 and seventy for N <= 32.

This bounds API observation, not process exit or resource release. Transfer
gates, Guest control delivery, recovery and teardown have separate budgets.
Diagnostics distinguish observation/queue time from gate wait. The existing
token lifetime and local execution/health deadlines are unchanged; expired
credentials never prove disappearance.

## Process evidence and rollout gate

Controlled HTTP and clock tests establish response safety, scheduling and exact
registration teardown. They do not establish a supported production host
envelope or substitute for real virtualization evidence. Before closing #34384
or claiming rollout coverage, retain evidence from an isolated test Runner:

- Withhold only test-owned cancellation notifications, covering disconnected
  Ably and a connected subscription with the selected notification dropped.
- Keep a healthy control Run and verify cooperative recovery/checkpoints,
  subsequent hard escalation, hard stop and a permitted physical Run deletion.
- Record canonical API commit, validated observation, exact-process stop
  delivery, process exit and Sandbox/resource release separately.
- Measure peak eligible registrations and API latency; show process delivery
  before the Guest heartbeat fallback at that measured envelope. Adjust tested
  concurrency or revisit the parent batch alternative if it cannot meet this
  gate. Do not reduce job admission to hide queue delay.

Use the existing capable CI/staging infrastructure. Do not induce a production
Ably outage or add a public fault-control endpoint. API cancelled status and a
cancelled chat event alone do not prove the process stopped.

## Rollout

Apply migration 1143 before promoting the new API. The new column has no default,
so every existing row receives NULL and already satisfies the CHECK. The CHECK
intentionally remains `NOT VALID`: new inserts and updates are enforced without
an unnecessary historical-row scan or follow-up validation migration. The
migration runner retains its one-second lock and ten-second statement limits.
Existing API and Runner versions continue to work after this nullable additive
migration; old writers leave the field NULL. New API code requires the column.
Keep the additive schema if rolling API code back.

Deploy the API slice and every stop writer across the serving fleet before
claiming new-Runner coverage. Mixed or rolled-back API versions can return an
unsupported endpoint or omit durable intent; the Runner makes no stop decision
and continues bounded probing so a later API rollout can become usable. Old
NULL data does not invent a mode. Existing Ably and Guest-health behavior remain
available. Old Runners ignore the additive endpoint and field. Runner rollback
needs no database rollback; API rollback retains the column and loses the new
observation guarantee. An API-only deployment establishes no new stop bound.

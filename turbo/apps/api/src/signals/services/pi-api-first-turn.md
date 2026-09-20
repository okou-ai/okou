# API-first transition boundary

This is the local module contract for #33570. The wider Pi SDK, memory, and
compatibility map is [Pi runtime architecture](../../../../../../docs/pi-runtime-architecture.md).

## Responsibilities and dependency direction

- `pi-api-first-turn-registration.service.ts` owns cancellation registration,
  release in `finally`, and completion side-effect dispatch. The configured
  dispatcher and public `runPiApiFirstTurn$` entry retain their source fencing.
- `pi-api-first-turn.service.ts` owns preparation, the provider attempt, and
  guarded effects. Its module-scope commands share history validation and
  immutable launch identity locally; no command accessors escape into helpers.
  `runPiApiFirstTurnCore$` interprets explicit completed/transferred results,
  then a recovery decision, then canonical terminal arbitration.
- `../../lib/pi-api-first-turn-policy.ts` owns pure history, H1, recovery and
  terminal decisions, with the existing typed errors. It receives observed
  facts and time values and imports no service, database, signal or clock.
- `../../lib/pi-api-first-turn-events.ts` is the actual API public-event
  producer. It receives the runtime's already-normalized assistant, preserves
  ordered blocks and final-block provenance, and has no accounting effects.
- `pi-api-first-turn-lifecycle.service.ts` retains the advisory transaction lock
  shared with active-input reservation and cancellation. Usage remains in
  `pi-api-first-turn-usage.service.ts`; Runner/proxy billing is independent.

The service depends on the pure modules, not the reverse. Preparation and guarded
effects remain adjacent because they share authenticated H0 and launch identity;
splitting those helpers into an IO interface would add indirection without
removing a responsibility. Registration and provider runtime remain separate.

## Authority and precedence

The runtime's `ownership.stage` is the irreversible provider-request fact.
`commitProgress.started` is a separate irreversible publication fact. Both keep
their existing owners; decisions are immutable snapshots, not a second lifecycle.

1. Validated blob metadata selects large-history transfer before API resource
   loading or history materialization. Raw and encoded bounds remain independent.
2. Before transport, the lifecycle lock validates run status, immutable identity
   and active delivery. Active input transfers H0 without an API request.
3. Before the first H1 side effect, the lock revalidates eligibility and marks
   commit started. Pending tools take precedence over active input; settled
   active input transfers H1 as a new prompt; otherwise the API completes once.
4. On error, classification and recovery selection happen **before** private
   attempt abort. A raw model/usage error cannot acquire deadline recovery merely
   because cleanup aborted the attempt. #32751's specified preparation failures,
   pre-commit API deadline and eligible model failures retain same-route recovery.
   Classified rate limits, overload, server failures, stream timeouts and lost
   connections remain eligible model failures under the same recovery guards.
   Reconnect, provider balance, subscription usage limits, other non-transient
   reasons, 401/403 and corrupt credentials/history are terminal. Final incomplete
   output is terminal with `output_token_limit`; pending tool continuation still
   transfers ownership.
5. Commit start prevents H0 replay even if publication's response was lost. The
   large-history manifest marks this fact immediately before publication too.
6. Every selected handoff still validates status, identity, deadline and durable
   delivery under the same lock. Network calls and H0 readback/hash checks stay
   inside their existing critical section. The API-attempt deadline and the
   later coordination cap are not interchangeable.
7. Failed handoff or ineligible recovery first checks canonical cancellation;
   failure then rereads under the lock. Cancellation or another terminal owner
   wins without another completion. Existing prepared-sandbox cleanup remains.

Late provider results belong to the original API attempt. Owned `waitUntil`
observers may record actual usage with the original response/category
idempotency, but never output, checkpoint or another terminal event. The captured
`PiExecutionRoute`, exact account and one edge materializer remain authoritative.

The runtime also returns independent, content-free
[provider usage evidence](../../../../../packages/pi-agent-runtime/src/usage-observation.md).
It distinguishes explicit zero, missing categories and partial/failed results
without changing these billing counters. Persisting and serving that evidence
through the API is tracked separately by #34787; reconstructed historical
results without evidence remain unavailable.

## Shared failure completion

API-first and Sandbox Pi, Codex and Claude Code use the same normalized provider
failure reasons and `completeAgentRun$` terminal handling. Native adapters own
provider evidence classification; the API does not infer a different reason
from its wrapper message or an earlier attempt's HTTP status.

Only canonical completion applies the credential-owner failure policy, after
the lifecycle transition wins. Recognized personal-provider limits and account
rejections retain failed state and the public reason without operator warnings.
Safety refusals retain their existing guidance and provider-independent policy
for personal and built-in credentials. An HTTP 200 response can still contain
a failed model result, including overload or explicit safety refusal; native
adapters preserve that semantic failure without replaying its content.
Built-in capacity, unknown failures, missing checkpoints and preparation,
commit or handoff faults retain the common actionable-failure policy. A failed
handoff reports its own final failure rather than the preceding model rejection.

API-first has no separate terminal warning or completion-log suppression based
on recovery eligibility. Successful recovery, attempt timeout, cancellation and
discarded late-result observations remain; a planned recovery alone does not
prove that a Sandbox attempt occurred. The durable no-replay fence still applies.

The winning canonical failure record uses the same persisted product route and
credential-owner projection for Sandbox Pi, Codex, Claude Code and API-first.
The completion input remains identical in responsibility across executors: it
carries the canonical reason, not a rich execution diagnostic. Runner records
Codex, Claude Code and Sandbox Pi execution diagnostics before forwarding that
reason. API-first mirrors that boundary locally after its terminal transition
wins, using INFO for classified provider outcomes and ERROR for unclassified
failures. Its bounded category/status/transport evidence never becomes a
Pi-only completion field or a persisted provider response.

## Durable producer mode

`PiApiFirstTurnActivation` explicitly distinguishes `legacy-sandbox-race` from
`durable-inference`; job absence is never an ownership signal. The durable mode
is written only for eligible chat starts behind the org-scoped, default-off
`piDeferredSandbox` switch. It carries the Run/user/org, original API clock,
model-visible H0/resources, selected route and immutable object hashes, not a
complete Runner context.

The creation path derives deterministic hashes for configuration, context and one
encrypted activation credential object (with an optional deferred body-secret
payload), then overlaps their publication and subscription admission with
speculative SDK preparation. One canonical admission transaction writes the Run,
session/input claim, v4 inference row and retention edges. Failed or stale
admission disposes speculative preparation. The committed winner schedules
request-independent `waitUntil` dispatch before response-side telemetry;
disabling the start switch later does not disable readers, cancellation or
maintenance recovery.

For durable mode, lifecycle state is additional authority:

- `ready/not-started` must atomically become `provider/may-have-started` for the
  same epoch and attempt ID before the runtime transport marker resolves.
- H1 plus its producer receipt is retained at `publishing/settled` before usage;
  response-derived idempotency then permits recovery to repair a missing ledger
  write before setting `usageSettled` and resuming local effects.
- Direct completion uses the normal event/checkpoint/completion owners and never
  creates Sandbox demand. Pending tools, accepted active input and explicit
  untouched-H0 fallback use `publishPiSandboxDemand`; a false result is not an
  executable handoff.
- Recovery advances the common epoch. It may restart only `ready/not-started`
  from the narrow retained credential snapshot (never a reconstructed Runner
  payload), may resume only usage/local work from `publishing/settled`, and
  terminalizes `provider/may-have-started` without resetting or replaying H0.
  Canonical terminal fencing advances the epoch once more.

Independent provider/organization advisory locks enforce the positive
`PI_INFERENCE_PROVIDER_MAX_IN_FLIGHT` and `PI_INFERENCE_ORG_MAX_IN_FLIGHT`
limits. Rejection is typed `429 PI_INFERENCE_BUSY`; it neither consumes nor waits
for a Sandbox slot. Active inference phases retain the reservation; terminal
uncertainty retains it for the bounded 55-second grace even if local usage
settles, because transport abort is not remote-stop evidence. This is technical
protection, not customer concurrency.

## Fixed cross-language examples

`fixtures/pi-public-events.json` has hand-authored raw Guest input, normalized API
input and expected common messages. Runtime `api.test.ts` checks the real input
normalizer; API `pi-api-first-turn-events.test.ts` checks the service's producer;
Guest `pi_rpc.rs` checks `PiRpcProjection` followed by
`provider_event_normalization`. Expected values are fixture data.

Common assertions cover content order, response/fallback ID, model, four public
token counters and citation provenance. API events start at zero and the API
owns its guarded result. Guest sequencing starts at the installed handoff
boundary; only `agent_settled` emits its result with Guest session/elapsed time.
The empty-message terminal default differs intentionally. Existing shared
`pi-memory-citations.json` parser cases and route lifecycle/late-usage tests retain
their separate boundaries. No persisted/wire format, reader, billing writer,
deadline, byte limit, provider policy or release authority changes here.

## Creator-owned admission overlap

After request authorization and final payload construction, the creation command
issues a private creator-authorized preparation input through the configured
dispatch seam. It starts snapshot and credential reads concurrently, preserving
resource-error precedence, then loads authenticated H0 and prepares the official
SDK session. Metadata-only large-history and slash-input checks precede resource
work. `preparePiApiTurn` receives no provider ownership or publication callback;
`executePreparedPiApiTurn` consumes its session once. The combined runtime entry
remains available.

The legacy atomic run/session/full Runner job/input-claim transaction is unchanged.
Only its pending winner transfers the in-memory preparation handle to activation.
Runner notification and the create response do not join preparation. Queued,
claim-lost, stale and failed admissions abort their private preparation and give
its eventual disposal to `waitUntil`; a retry or promotion prepares fresh inputs.
Request cancellation during admission does not decide ownership: the actual
transaction result does. The handle is absent from persisted activation/context
JSON, wire formats and shared caches.

The public coordinator still reads canonical `triggerSource` before adopting an
early handle or starting a promoted attempt. Adoption checks the entire captured
activation, including final prompt, resource/memory/H0 identity, account, route,
effort/tier and original deadlines. An early failure keeps its original typed
classification only after successful identity validation. Prepared credentials
do not retain a revoked provider grant: execution revalidates managed credential
sources using the captured account identity, without refreshing or replacing the
prepared values. Subscription checks retain terminal reconnect state and the
existing reconnect-required failure classification. These reads remain outside
the lifecycle lock. Final lifecycle,
cancellation and active-input checks still precede provider transport. The
43-second model/initialization boundary (45 seconds minus commit budget),
45-second API budget and 55-second coordination cap stay anchored to the captured
API start. SDK initialization that outlives abort remains joined by an explicit
cleanup owner, outside the lifecycle lock; eventual sessions are disposed once.

`pi_admission_preparation` records bounded `started`, `ready`, `failed`, `adopted`,
`discarded` and `released` boundaries, with a separate discard reason for queued,
claim-lost, stale, admission-failed and finished activation. Existing `pi_prepare_*`
children remain. Correlate their absolute timestamps with admission and the
actual provider HTTP span; overlapping intervals must not be summed as serial
latency. Discarded preparation is work, not a canonical run publication. These
observations establish scheduling behavior, not a measured production speedup.

No database migration is needed for the producer because the v4 lifecycle and
immutable-object schema already exist. Legacy queued contexts keep the same
complete payload and deadline refresh. Durable demand requires the accepted v4
consumer, capable Runner and commit-addressed CLI reader; switched-off starts
remain legacy while already-written v4 recovery stays enabled.

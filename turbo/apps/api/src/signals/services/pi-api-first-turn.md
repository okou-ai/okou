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
   Reconnect/failureReason, 401/403, corrupt credentials/history and incomplete
   output retain their existing terminal handling.
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

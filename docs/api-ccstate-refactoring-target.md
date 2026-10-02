# API ccstate refactoring target

This is the approved target for [#37513](https://github.com/okou-ai/okou/issues/37513),
not a statement that the current implementation is already complete. Initial
implementation covers blocks 1, 2, 5, 6, 10 and 11. The source examples are
[#37360](https://github.com/okou-ai/okou/pull/37360),
[#37430](https://github.com/okou-ai/okou/pull/37430) and the merged
[#37313](https://github.com/okou-ai/okou/pull/37313).

## Terminal shape

1. Database helpers become computed reads or commands. No database handle is
   passed in parameters, args, runtime objects, state, callbacks or escaping
   closures. Reads obtain `get(db$)` in their node; writes obtain `set(writeDb$)`
   in their command. Pure value, predicate and SQL builders execute no I/O.
2. Prefer no explicit transaction. Use real business unique keys, conditional
   `UPDATE ... WHERE ... RETURNING`, `INSERT ... ON CONFLICT` and gated CTEs.
   An old multi-table operation is not automatically a strong-consistency
   requirement. Keep a short, lightweight transaction only for a demonstrated
   core invariant or necessary transaction-local setting/snapshot. All SQL is
   inside one command's transaction callback: never pass `tx` onward or perform
   external I/O there.
3. Keep each file's public computed/command surface small and business-oriented.
   Returned factory interfaces are public surfaces too. Internal nodes share
   dependencies in their owner's lexical scope, not computed/command parameters,
   signal bundles, callbacks or closure adapters. Ordinary ccstate accessor
   calls remain valid. Pass plain captured facts or prepared plans across
   operation boundaries; do not use state parameter slots or repeated reads to
   evade this rule. Construct command graphs before command execution.
4. Extra external resources may be recoverable orphans. Prefer bounded existing
   cleanup/GC and declarative eventual synchronization over requiring external
   resources and SQL to commit together. Define ownership, adoption/publication
   conditions, orphan eligibility and recovery. This does not permit unauthorized
   reads, duplicate money effects, expired execution authority or lost data.
5. Preserve already-correct pick ownership, single-read snapshots, independent
   preparation, actual write-result/revision state and entry-owned orchestration.
   Keep cancellation explicit, with the signal as the final positional argument.
   Do not add locks, retries, coordination fields, timeout increases, test hooks,
   database-row assertions, suppressions or fallback protocols.

## MCP is a Web adapter, not a second chat product

The approved change intentionally removes the MCP-specific protocol:

- Delete `create_chat_thread` and its special creation/replay implementation.
  Sending without `threadId` creates an ordinary conversation; sending with it
  continues one through the same Web command. Send input mirrors Web's `agentId`,
  `prompt` and optional `threadId`/`model`.
- Delete mandatory MCP `requestId`, the 24-hour exact replay contract,
  `retryUntil`, `replayed`, dedicated `inputRef`/receipt/disposition, `nextAction`
  handoffs and combined-creation UUID derivation. Do not automatically retry an
  uncertain send. Ordinary Web client-event identity is not removed by this
  decision.
- Reads expose ordinary conversation lists/details, paginated messages/events and
  Run facts. Delete the MCP lifecycle state machine, `waitMs`, waiter admission
  and observation-count protocols.
- Keep edit/revoke/stop only where Web offers equivalent semantics, through the
  same command. Retain OAuth, scope, tenant and ownership checks.
- Change tool registration, contracts, documentation and public-boundary tests
  together. Do not retain the removed protocol as a compatibility fallback or
  dual path. Do not delete shared historical persisted-source decoding merely
  because its old MCP protocol has been removed.

Low-frequency feature-switch writes do not need to atomically invalidate every
Pi projection. Brief stale configuration is accepted. Existing authorization
checks remain; do not introduce complex coordination solely to eliminate a
short-lived stale projection.

## Required file scope

Paths below are relative to `turbo/apps/api/src/signals/`. These are required
business chains, not a requirement to produce one PR per file. A file whose
implementation already meets the target may remain unchanged only with an
explicit source-backed completion record. Moving or wrapping a helper is not
completion.

| Block                      | Primary files                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: thread creation/editing | `services/chat-thread.service.ts`, `services/chat-thread-metadata-update.service.ts`, `services/mcp-chat-creation.service.ts` (delete the special implementation), `services/welcome-chat-thread.service.ts`, `services/chat-title.service.ts`                                                       |
| 2: enqueue/pick/start      | `services/chat-thread-queue-drain.service.ts`, `services/pick-chat-run.service.ts`, `services/claim-run-context.ts`, `services/agent-run-execution.service.ts`                                                                                                                                       |
| 5: shared publication      | `services/shared-thread.service.ts`                                                                                                                                                                                                                                                                  |
| 6: durable export          | `services/background-job.service.ts`, `services/user-export.service.ts`, `services/user-export-source.service.ts`, `services/user-export-assembly.service.ts`, `services/user-export-authorization.service.ts`, `services/user-export-durable.service.ts`, `services/user-export-cleanup.service.ts` |
| 10: tasks/rewards          | `routes/get-started.ts`, `services/get-started-rewards.service.ts`, `services/get-started-review.service.ts`, `services/get-started-member-reward.service.ts`, `services/get-started-invitation-acceptance.service.ts`                                                                               |
| 11: feature switches       | `services/feature-switches.service.ts`                                                                                                                                                                                                                                                               |

Required associated interfaces:

- `services/chat-thread-create.service.ts`
- `services/chat-thread-event.service.ts`
- `services/chat-event.service.ts`
- `services/model-selection.service.ts`
- `services/model-catalog.service.ts`
- `services/shared-thread-artifacts.service.ts`
- `services/shared-thread-artifact-snapshot.service.ts`
- `services/pi-stable-context-generation.service.ts`
- `services/usage-allowance.service.ts`
- `services/get-started-invitation.service.ts` (including its callers and
  cancellation boundary; do not rewrite already-compliant code merely for churn)

The MCP decision also requires the affected `mcp-chat-send`, `submission`,
`status`, `status-wait-admission`, `thread-update` and `cancellation` services,
`chat-events.command.ts`, `queued-chat-thread.service.ts`,
`routes/mcp-server.ts`, `external/mcp-server.ts`, MCP contracts and tests under
`turbo/packages/api-contracts`, `docs/mcp-server.md` and public MCP API tests.
Necessary callers must migrate with each interface. Cross-owner shared APIs are
coordination points, not reasons to silently leave handle or node injection in
place or rewrite unrelated modules wholesale.

## Acceptance

For every business slice, record:

- Actual files and call chains, including moved/new files and required callers.
- The final small public interface and evidence that handle/node parameter
  passing, including indirect forms, is eliminated.
- Transactions removed, combined, retained and moved separately. For each
  retained transaction, its exact invariant or local setting, owner, and SQL-only
  callback. A moved transaction is not a removed transaction.
- The expected state and ownership/recovery of eventual synchronization and
  orphan cleanup.
- Public API coverage of the applicable authorization, replay, idempotency,
  cancellation, fencing, reward and publication/revocation contracts. Remove
  tests of the deleted MCP protocol; do not weaken retained Web contracts.
- Applicable formatting, static analysis, types and CI results, with unverified
  boundaries explicitly disclosed. A lexical scan or green CI alone does not
  establish terminal architectural conformance.

This scope does not authorize review automation, merge, release or production
operations, nor blanket governance of blocks 3/4/7/8/9/12. Independent work may
proceed concurrently; wait only for a concrete functional/correctness dependency
or repository protection, not expected file overlap or merge-order reservation.

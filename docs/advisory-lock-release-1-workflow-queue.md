# Release 1 Workflow Queue Command Boundaries

This inventory describes the queue boundary prepared in Release 1. It is not a
claim that the complete workflow lifecycle or Release 1 is ready. The canonical
[terminal state](./advisory-lock-terminal-state.md) applies to every remaining
caller: commands accept business inputs and an optional final `AbortSignal`,
obtain `writeDb$` internally, and execute finite SQL without passing database or
transaction handles to another function.

## Implemented boundaries

- `prepareWorkflowAutomationQueueInput$` owns display-context reads and invokes
  the model preparation command before queue publication. Its result contains
  ordinary event, context and conflict-policy values.
- `enqueueIntegrationChatInput$` owns provider context, event, queue and ingress
  receipt writes for Telegram, AgentPhone, Teams, Slack, Discord and Feishu.
  Discord's current claim token and route must still match. No integration
  supplies an `appendInput(tx)` callback to this command.
- `enqueueWorkflowInput$` owns ordinary workflow publication and the existing
  webhook or chat-run-finished receipt. Duplicate callback admission rolls back
  the candidate event. It does not add coordination fields or JSON state.
- Forms, Calendar, Gmail, Google Meet, Notion and Stripe use explicit source queue
  commands with ordinary prepared source values. Provider calls and attachment
  preparation happen before those local transactions. The retained Google Meet
  and Notion builtin-credential compatibility key is unchanged; this refactor
  does not remove that credential protocol's separate rollout requirements.
- `enqueueStripeWorkflowInput$` loads the accepted runtime catalog before its
  transaction. Its finite SQL validates the current connector identity, Live
  mode variable, enabled automation, feature settings, member/agent visibility
  and thread binding. The existing delivery revision, health projection, event
  and queue entry commit together. The context/event, connector, automation,
  feature-row and receipt lock order remains compatible with the outgoing queue
  writer. No Stripe or KMS call occurs in this transaction.
- `checkQueuedWorkflowLaunchReadiness$` checks prior-run and owner access before
  preparing a model pin. A rejected or disabled target therefore cannot trigger
  lazy model-policy preparation first.
- `recordWorkflowAutomationRunStart$` receives a plain launch description. The
  former returned callback capturing a database handle has been removed.
  `recordWorkflowAutomationLastRun$` owns its finite write; journaled schedules
  re-read their claim sequence after acquiring the automation row, so an older
  claim cannot overwrite a newer run.

## Implementation still required

These are implementation tasks, not conditions satisfied by draining old API
requests:

- Morning Brief's schedule claim, queue-event binding and pending-tick coalescing
  still pass transaction callbacks through the legacy enqueue path.
- Producer Run binding still carries `persistProducerRunBinding(tx, run)` into
  the shared Run creation transaction.
- Workflow launch still forwards a database handle through compute-unit grant
  preparation and shared launch/target helpers.
- Stripe workflow ingress fan-out, delivery claim/finalization and missing-source
  projection repair still have inherited database/transaction helper chains.
  Removing its queue-publication callback does not finish those paths.
- Telegram reply-chain and Discord discovery/destination helpers still forward
  database handles. Route/thread/event
  publication itself now uses owning commands for all six integrations; Discord
  receipt/ingress admission and Slack/Feishu receipt publication also have their
  own finite commands. These completed
  boundaries do not finish the surrounding Storage, dispatch or credential graph.

## Test changes and validation boundary

`chat-events-message-queue.test.ts` no longer requires an exact number of Ably
refresh hints for concurrent steering declarations. It still checks rich input
materialization, repeated reads, repeated declaration results, the next queued
input and the final empty queue. Public thread-event reads now require exactly
one replacement after concurrent declarations and retry, and exactly one
`input.prompt` replacement per source in order, bound to the intended Run. The
active-input notification presence assertion remains.

Two Stripe automation fault-injection cases no longer install database triggers:

- The former complete two-tenant fan-out rollback test is replaced by a public
  webhook replay test. Both connected tenants receive exactly one input, replay
  after delivery produces no further execution, and both expose delivered health.
- The forced queue-admission failure/retry case is removed. Existing public API
  tests already exercise concurrent duplicate webhook/execution admission and
  verify one canonical input plus delivered health. They also retain exact source
  selection, reconnect/deletion, disabled-feature and deauthorization behavior.

The dedicated `fail-next-ingress-for-automation`,
`fail-next-queue-admission-for-automation` and `clear-forced-failures` fixture
operations, their two trigger functions and their trigger creation code are
removed. Public duplicate/retry coverage does not prove rollback under arbitrary
injected SQL failure; this document does not claim that removed test mechanism
has equivalent coverage. No replacement internal gate or trigger was introduced.

Scoped formatting and lint checks cover these edits. Behavioral verification
must come from the combined PR HEAD's pipeline; no full local Vitest or local
application server is run for this work.

## SSH and VNC test ownership cleanup

The SSH and VNC connection-lock fixture APIs and their PostgreSQL waiter
inspection are removed. They previously held a connection row open and inspected
`pg_blocking_pids` to enforce an internal execution order. The VNC-only fixture
route and contract are deleted; SSH's unrelated runtime and credential fixtures
remain explicitly outside this cleanup.

The SSH automation test retains public host pinning, subsequent chat-access
revocation, denied further pinning and unchanged trust/generation assertions.
Separate existing public API tests retain equal and conflicting concurrent first
observations, exactly one trust winner, stale generations and credential isolation.
It no longer asserts that a request waits for a manufactured row lock.

The VNC shared-Agent test now invokes real Agent deletion and membership-deletion
webhook requests concurrently, requires both to succeed, and checks that the
removed member's hosts disappear while the creator's independent host remains.
It no longer asserts that Agent deletion completes at a particular internal lock
wait point. The separate public concurrent credential-rotation test is unchanged:
two requests with `expectedRevision: 1` must yield exactly one 200 and one 409,
advance dependent hosts, preserve an independent host and reject stale writes.

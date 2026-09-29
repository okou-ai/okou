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

- `enqueueWorkflowScheduleInput$` owns the Morning Brief occurrence claim, exact
  queue-event binding, ordinary schedule coalescing, event and queue wake-up.
  The poller sends an ordinary claim ID, owner identity and schedule anchor;
  neither a transaction callback nor a database handle crosses that boundary.
  The existing native-owner compatibility key and native/automation row order
  remain. Claim sequence is sampled after the automation row is locked. A lost
  occurrence rolls back its candidate input, and a failed admission identifies
  its exact claim for the existing settlement path. Pending tick coalescing is
  one set-based statement scoped to that automation and thread; manual inputs
  are excluded and the existing unique revoke edge arbitrates a concurrent pick.
  This removes the inherited per-event SQL loop; it does not claim a fixed row
  cap on a pre-existing schedule backlog.

- The poller now owns its bounded lane reads and conditional due-row claim in
  commands. Membership/access checks precede model preparation, and only plain
  occurrence values cross into launch. Failure handling no longer captures a
  database handle in its returned callback state.
- Morning Brief journal settlement, ordinary cron/loop completion, pre-run
  failure and expiry now execute direct SQL inside their owning commands.
  They retain native-owner-before-automation ordering, exact occurrence and
  latest-claim checks, the three-failure policy, credit-error exemption,
  current-timezone recurrence and native revocation on an enabled-state change.
  Expiry uses bounded existence probes for claimed/pending work rather than
  loading the complete thread queue. The scheduling lanes and retry loops run
  outside these local transactions.

- Queued workflow context, target and source-autonomy reads now belong to
  commands. `assembleWorkflowAutomationRun$` receives plain launch inputs and
  invokes owned model/Computer Use host preparation before Run creation. The
  host read preserves thread ownership, host owner/org and revocation checks;
  its queued-chat caller also passes only business values.
- `recordQueuedWorkflowReward$` owns the existing workflow provenance claim's
  finite transaction. It preserves the creator beneficiary, actor/source unique
  key, existing-grant exclusion and reward amount; this does not change later
  grant/redemption behavior. No transaction enters reward helpers.
- Workflow occurrence-to-Run binding is now represented by an in-memory queue
  event ID. Pending and failed Run persistence apply the same conditional journal
  UPDATE before callbacks can observe the Run, without a workflow-supplied
  transaction callback.

- Schedule automation insertion now owns its exact binding-row lock and
  automation INSERT in `insertScheduleAutomation$`; it does not materialize an
  empty thread. Official automation metadata attachment owns its exact plain-row
  lock, staged reservation verification, conditional metadata UPDATE and active
  identity publication in `persistOfficialAutomationMetadata$`. Pure field and
  predicate builders receive ordinary values only. The response's committed
  Stripe/Calendar/webhook reads run after that transaction in an owning command.

- Generic event automation creation now uses `insertEventAutomation$` for the
  complete finite source-selection, workflow binding, optional thread and created
  event, and automation write. It retains the outgoing builtin credential key,
  Agent-before-Workflow parent order, binding exclusion, exact expected account
  predicate and Forms publication snapshot. SQL builders take ordinary values;
  no store/helper executes through this transaction. The caller receives the
  committed receipt before its existing watch compensation/cancellation handoff.
  Creation contexts no longer contain `db`; Gmail/Calendar/Forms and generic
  chat-run-finished/GitHub entry paths invoke the owned writer directly. Failed
  watch cleanup invokes an owning single-row DELETE command instead of capturing
  a database handle in `onRejection` callbacks.

- Notion configuration creation, Official reconfiguration preparation and
  re-enable validation invoke owning credential commands with business inputs.
  Account selection is an owned scalar read; the shared pure SQL builder preserves
  explicit null selections rather than falling back to a default account.
  GitHub configuration preparation and update own their exact installation/read
  and automation/write SQL. Official chat-run-finished preparation owns its
  watched-thread authorization and self-watch binding reads; Official Meet
  preparation owns account selection. These commands do not receive a database
  handle. Event-update orchestration no longer carries a `db` argument into
  Gmail/Calendar configuration commands through object spread.

## Implementation still required

These are implementation tasks, not conditions satisfied by draining old API
requests:

- Schedule tick coalescing still operates on the existing pending backlog for
  one automation/thread. Its own transaction now uses one set statement, but
  a fixed row bound remains to be implemented without revoking a winner before
  its new occurrence is admitted.
- Morning Brief preference, native delivery, installation/reconciliation and
  revocation still have inherited native-authority helper chains. Webhook and
  Stripe-specific creation and workflow copy still propagate handles through the
  shared thread initializer; their entry contexts are ordinary values now, but
  those remaining transaction internals are not completed. The final enable
  writer, workflow ownership/loading helpers and Official reconfiguration commit
  still have inherited transaction work; Meet watch/credential preparation remains
  separate from its completed account-selection read. The absent
  native-owner key remains necessary for the current shared writer protocol:
  first materialization can otherwise race an ordinary/selected classification.
  Preparing its terminal protocol is still implementation work, not merely an
  outgoing-request drain gate.
- Shared Run persistence still owns inherited transaction-aware helpers.
  Workflow schedule binding now crosses that boundary as a plain queue-event ID;
  the two Run persistence paths directly update its exact unbound journal row.
  The separate `persistProducerRunBinding(tx, run)` graph remains for integration
  thread reassignment and Pi memory Stage 1/2 admission. Removing the workflow
  callback does not complete those independent producer or Run boundaries.
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

## Schedule test control cleanup

The schedule-claims suite no longer creates an automation row lock, polls
PostgreSQL blocked waiters or cancels their queries to force an admission
rollback. Its second artificial failure case no longer injects an exception
immediately after Run persistence. Both test cases and their exclusive fixture
helpers are removed, together with the production persistence-observer hook.

Existing tests retain concurrent/repeated completion, the exact thirty-minute
admission boundary, timezone changes during a run, ordinary cron/loop behavior,
revoked membership and repeated-failure disablement. Queue tests retain manual
Run now input alongside automated coalescing and concurrent manual admission.
These observable behavior cases do not prove rollback at an arbitrary internal
SQL instruction. Existing journal/native-state read fixtures elsewhere in the
suite remain a separate test-boundary cleanup item; their presence is not
reported as compliant user-API-only coverage.

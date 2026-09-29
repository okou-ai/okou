# Release 1 model policy command boundary

This is a scoped implementation record, not a declaration that the entire
Model Policy package or Release 1 is complete.

## Completed replacement publication

`model-policy.service.ts:commitOrgModelPolicyReplacement$` owns the complete
policy replacement commit. Its caller supplies the organization, user, policy
list, revision, and final `AbortSignal`. The command obtains `writeDb$`, opens
its transaction, executes the finite SQL directly, and awaits the commit. No
`Db` or transaction is passed to another function or command in this commit.
The validation and write-plan helpers consume ordinary snapshots and values.
SQL predicates and the retained lock statement are pure builders.

The publication preserves these existing business guarantees:

- An empty set is arbitrated through the existing unique default slot. Any
  stale or invalid replacement rolls back its preparatory default insertion.
- Provider, connection, and surface parents are locked before policy rows.
  Validation uses the parent values read under those locks; a deleted or
  foreign provider cannot become an authorized route through a later helper
  read.
- Ordered policy ownership is compared with a fresh complete set before
  validating the caller's revision. The bounded three-attempt identity check
  remains unchanged.
- Current entitlement and catalog restrictions, exactly one default, cloud
  mapping validity, member-only OAuth, and unchanged restricted routes retain
  their existing validation rules.
- Removing a model relocates member preferences and clears their service tier
  in the same commit as replacing the policies. The existing partial unique
  default constraint remains the default-slot authority.

There is no external I/O, new persistent field, or new coordination table in
this transaction. The shared entitlement status-to-runtime mapping is a pure
function, reused by the read path and replacement validation.

## Completed onboarding publication

`onboarding-completion.command.ts:markOrgOnboardingComplete$` accepts ordinary
organization/member/answer values and the final `AbortSignal`. It owns the
metadata completion, insert-only entitlement bootstrap, and untouched model
policy initialization in one finite direct-SQL transaction. The existing
metadata completion predicate admits only the first completion; model seeding
still preserves any administrator-customized policy set. Ordered provider
parents and complete policy-set ownership match replacement publication.
The reusable policy helpers return only values, predicates, or SQL statements;
they never receive or execute a database handle. Member completion and timezone
fallback now also own their SQL commands, and Morning Brief provisioning runs
after the onboarding transaction has committed.

## Compatibility and unfinished ownership

The existing `model-policy:<orgId>` advisory key remains for outgoing seed and
replacement writers that do not acquire the complete current policy set. All
three Release 1 writer protocols already use the default-slot and parent/set
ownership rules. Removing that key requires evidence that incompatible APIs
are no longer serving, their in-flight work has drained, and retained rollback
targets use the prepared protocol.

## Completed lazy initialization and ordinary routing snapshots

`ensureOrgModelPolicyFacts$` now owns the lazy seed/default-repair transaction.
The command accepts the organization, user, an optional already-observed plan,
and the final optional `AbortSignal`. It obtains `writeDb$` locally. The slow
path inserts only the unique default-slot candidate, takes ordered provider,
connection and surface parents, verifies ownership of the complete current
policy set, re-reads the entitlement, and directly commits the finite repair
SQL. The bounded three-attempt ownership check remains. Main's retired-model
repair, restricted-plan default, and preservation of administrator-customized
sets remain in the pure write plan.

Policy read projection, default and explicit selection, and input-model capture
now use business-input commands. `loadModelRouteSources$` returns ordinary
member-account, organization-provider and surface observations. Effective route
resolution is pure: the private database `Symbol`, deferred personal-account
loader, and database-capturing metadata closure have been removed. Personal
metadata is read only when the selected models can use a personal subscription.
The policy response uses the same route snapshots and command-owned catalog,
feature-switch and runtime-cooldown reads. No credentials are decrypted or
captured by this metadata preparation.

The caller graph includes chat creation/input/run selection, metadata updates,
MCP discovery/creation/projection, Discord interaction and welcome threads,
integration thread creation, and workflow trigger preparation. Integration
thread writers receive a plain prepared default pin and validate a required
selection only when they actually create a thread; reusing an existing route
does not require a valid new-thread default. Telegram, AgentPhone and Teams
route publication now obtains member defaults before the transaction and owns
the route, thread and created-event SQL in one command. A unique-route loser
deletes only its candidate thread and reads the winner once; existing direct
message routes retain their destination updates. Plain value and event-SQL
builders never receive a database handle.

`ensureWorkflowUserAutomationThread$` prepares its default pin, localized title
and member defaults before opening its own finite transaction. It directly
locks the agent/workflow parents, owns the existing unique binding, inserts a
thread and its created event, and publishes the binding together. Trigger,
manual-run and poller lazy creation use this command. Atomic automation creation
still uses its existing transaction with ordinary prepared thread values; no
model-policy command or database-aware model selection helper executes inside
that inherited transaction.

## Ownership still unfinished outside this boundary

The existing atomic automation-creation and workflow-copy helpers still pass
their transaction to the thread/event insertion helper. Feishu, Slack and Discord
route/thread/event writers, Telegram reply-chain publication, and poller
schedule claim/failure helpers also retain legacy database propagation.
Moving lazy model selection out of those transactions does not complete their
remaining write protocols. They must be migrated explicitly; serving drain,
elapsed time and the retained model-policy advisory key do not do this work.

The existing database-aware built-in runtime and plan read helpers remain for
other callers outside this migrated graph. New model-policy and selection paths
use their command-owned variants. Their remaining consumers belong to the full
API transaction-ownership inventory.

## Verification

The replacement preserves the existing API tests for concurrent initialization
and complete replacement, mandatory/current revisions, preserving another
administrator's configuration, provider and custom-surface validation, plan
restrictions, and relocating member preferences. The four retired tests that
controlled internal row locks or compared artificially unrepaired database
snapshots are not restored.

Focused formatting, plain Oxlint and ESLint cover the changed commands and
callers. A scoped API core typecheck identified only the parallel owners' pending
callsite/export integration at the intermediate branch, which is not a combined
HEAD pass. The main PR owns final types and behavioral pipeline verification.
No local Vitest suite or development server was run for this change.

## MCP discovery ownership

`listMcpAgents$` and `listMcpModels$` now receive business inputs and a final
`AbortSignal`; the MCP transport no longer supplies its database handle to
these operations. The Agent preparation command obtains `writeDb$` and owns
its direct, bounded read. Cursor signing and response-size accounting operate
on committed ordinary rows after that transaction closes.

The model snapshot command directly reads one entitlement, the active policy
set and one member preference inside its own finite read-only transaction.
Member/provider sources, feature-switch context and built-in route availability
are obtained through their owning commands after that transaction commits.
No transaction is supplied to a query-budget callback or route resolver. The
response retains the 15-second cancellation budget and 16 KiB size limit;
SQL in the owned discovery snapshots retains the per-query timeout. Discovery
still refuses missing or unrepaired policy configuration rather than repairing
it, and explicitly reports that actual admission is checked when sending.

Existing MCP API tests cover visible/foreign/private Agents, signed cursor
binding and expiry, default and member model configuration, unavailable
credentials, plan restrictions and discovery without lazy initialization. This
ownership change does not remove or weaken those assertions. Scoped lint and
formatting pass. The isolated worktree's core type check currently fails only
at other caller migrations to the new model command exports; the combined
HEAD must pass types and behavior checks in the main PR pipeline.

## Chat metadata and MCP publication

`updateChatThreadMetadata$` prepares model selection after an owned-thread check,
then `commitMetadata$` directly owns the current thread row, validates the existing
mutation receipt, updates metadata, and appends at most three ordered thread events
in one finite transaction. A matching accepted mutation is replayed before a now
unavailable model can reject it. The event statement builder receives only ordinary
values; sequence allocation and event insertion remain in the same commit.

MCP creation now prepares the model and member defaults before publication. Its
own command directly checks the selected Agent, inserts the request-ID thread and
its exact creation event, and commits them together. A conflicting request ID is
read back under the existing principal, identity and 24-hour retry rules. Thread
and event readback share one finite read snapshot; model response projection runs
after that snapshot commits. MCP thread list/get commands own their finite reads,
and model projection uses ordinary route snapshots. No helper receives their
`Db` or transaction. Realtime remains after the publication commit.

Direct chat input and queued-run model preparation now invoke the same commands
without supplying a database. Credit admission on this model path uses owned
balance reads and the bounded allowance-availability command. The broader direct
send queue callback, launch/producer graph and other legacy credit-admission
callers still require their own ownership migration; this section does not mark
those paths complete.

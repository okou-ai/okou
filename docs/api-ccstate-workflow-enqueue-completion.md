# Workflow enqueue/source receipt slice

## Scope and baseline

This increment starts at `9900095aaafb9386daeedfea5d51dcfcac9734b5` on
`refactor/api-ccstate-terminal-37513`, for Draft PR #37525 / issue #37513.
It changes the workflow enqueue owner, its pure event/source plan builders,
and only the source-plan arguments/imports in these producers:

- Chat-run-finished, Gmail, Google Calendar, Google Forms, Google Meet, Notion,
  Stripe and signed workflow webhook automation event services.
- `workflow-automation-run.service.ts`, `workflow-automation-enqueue.service.ts`,
  `workflow-input-queue.service.ts`, and `workflow-stripe-queue.service.ts`.
- Necessary sibling `workflow-{gmail,google-calendar,google-forms,google-meet,notion,schedule}-queue.service.ts`
  interfaces: the old executing transaction helpers become pure SQL/predicate
  builders, or are deleted in favor of those builders.

No shared chat event, pick/claim, queue-drain, model-catalog, MCP, workflow
registration, schema or deployment files are modified.

## Closed interface and ownership

The only public command in the workflow run module remains
`runWorkflowAutomationNow$(args, signal)`. Its private, module-scope graph
prepares the model, display name and source SQL plan, commits, and publishes.
It does not create nodes during command execution or receive injected nodes,
accessors or operation callbacks.

`RunWorkflowAutomationNowArgs.sourcePlan` is a discriminated union of plain
source receipts/facts. Stripe additionally carries the already accepted plain
connector catalog snapshot. No source captures a signal, database or
transaction. No plan is serialized into the chat event payload.

`workflowAutomationQueueEventPlan` prepares a canonical event row and its
entry-owned automation context. Source plans contain finite parameterized SQL
statements and closed failure discriminants, not executing callbacks. SQL
builders and error mapping perform no I/O. The owning command alone calls
`set(writeDb$).transaction`, and all its SQL executes directly on its local
`tx`; the transaction is never passed onward. Numeric timing marks carry no
SQL resource and are recorded outside that callback, including failure paths.

## Transactions and consistency

This is **one moved/retained workflow enqueue transaction, not a removed
transaction**. The retained invariant is that a context/input/queue publication
must commit together with the source receipt, cursor or exact occurrence claim.
A lost source fence or failed source authorization must roll back all those
writes, including revocations of older ticks. The finite callback performs only
local SQL; model/catalog/provider preparation and publication stay outside.

- Schedule: retain the native-to-automation anchor consumption order, owner
  epoch, exact anchor, grace bound, journal sequence and queue-event binding.
  Claim first, then coalesce, so a losing occurrence cannot revoke the winner.
- Coalescing: select only this automation's run-less, unrevoked, non-manual
  inputs, excluding the new event. Append ordered revocations as one canonical
  batch, preserving immutable context pointers and later timestamps. Manual
  Run now remains a distinct input. Queue upsert still advances `queuedAt`
  without modifying a live lease.
- Chat-run-finished: stable queue identity and callback receipt CAS remain.
  A receipt miss is distinguished from an already admitted callback inside the
  transaction; a conflict does not run source transitions.
- Webhook: source delivery insert and last-received projection use one CTE.
  The existing delivery-key uniqueness and rollback contract are retained.
- Forms: processed receipt insertion, exact cursor CAS and current
  watch/consumer authority are one gated CTE. A duplicate, cursor miss or
  source loss returns no row and the owner rolls back. Foreign-key failures
  keep the existing source-changed classification.
- Gmail/Calendar/Meet: the current account/watch/subscription/consumer
  predicates are retained as pure admission SQL.
- Notion: independently prepare and validate the consumer configuration;
  processing the running pending receipt is gated by that exact current
  configuration and connector. A configuration change cannot publish a stale
  input. No provider read runs in the transaction.
- Stripe: prepare the accepted catalog snapshot, consumer, connector and
  feature overrides outside the transaction. Brief feature-switch staleness is
  explicitly accepted. SQL revalidates current tenant/owner, consumer config,
  connector identity/credential-storage facts, Live-mode variable, workflow and
  agent visibility, destination, and pending delivery revision. Receipt and
  latest-delivery health remain a fenced CTE. A target changing between
  preparation and commit is conservatively rejected; the current guard uses
  `automation_no_longer_matches` for that race. No money effect, external API
  action, lock or retry is introduced.

No new external orphan is created by this slice. Existing source receipts,
processed-event recovery and post-commit pick/notification remain their owners'
responsibility; their broader implementations are intentionally unchanged.

## Parent integration requirements

`enqueueChatInput` now has zero callers in this tree. The parent owns
`chat-thread-queue-drain.service.ts` and can remove its unused function,
`EnqueueChatInput`, `EnqueueChatInputStep` and `measureEnqueueStep`, then prune
imports that become unused. This increment intentionally does not edit it.

The event owner's APIs consumed here are:

- Pure `prepareChatEvent(input.automation)` returning its canonical `.row`.
- Pure `appendCanonicalChatEventsSql(rows, conflict)` with `none`, `id` and
  `any` conflict modes. Its result must have one output row per actual inserted
  event, so direct execution's `rowCount` remains authoritative. No raw driver
  row is read by this slice.
- The exported `PreparedChatEventRow` type for the known-valid, payload-free
  `control.revoke` batch. No event command is called from the transaction.

Integrating an event-owner change should preserve these pure SQL/value
interfaces, not reintroduce an event command or transaction-taking adapter.

## Verification and remaining boundaries

Completed on the worker tree:

- Complete API `TSC_CHECKERS=1 pnpm --filter api run check-types`, including all
  seven compiler programs and the chat-event acceptance type program.
- Affected-file Prettier and API-cwd ESLint with zero warnings.
- API-cwd basic Oxlint and full production/test type-aware Oxlint. The initial
  unrestricted type-aware process exited 137 on the 4 GiB sandbox; after
  resource diagnosis, single-threaded runs with `GOMEMLIMIT=1800MiB` passed.
- `git diff --check` and source/caller scans.

API-workspace Knip reports three unused exports: parent-owned
`enqueueChatInput`, and `loadedMemberModelRouteContext` / `loadOrgModelPolicyFacts`.
The latter two already have declaration-only occurrences at the exact baseline;
no owned export is newly unused. Knip is **not green** pending parent cleanup.

No local Vitest, database behavior test or dev server was run. Existing public
route coverage is compiled, not executed: `workflow-queue.test.ts` covers
coalescing/manual preservation/concurrent draining; webhook suites cover
retries and receipt behavior; Forms covers disabled-during-retrieval and
metadata-only replay; Stripe covers tenant replay, newer health preservation,
flag changes and deauthorization; `official-workflows-schedule-claims.test.ts`
covers the journaled schedule boundary. Parent CI must verify these on the
integrated exact head. Query-plan costs and live concurrent source-change
behavior are not established by static checks.

Broader producer `db`/`startRun` helper governance, event append/replacement
migration, pick/claim and parent-wide terminal acceptance are outside this
exclusive slice and remain with their owners. This increment does not claim
that the entire Draft PR has reached the terminal target.

# Issue #37513: merge assessment and verified boundaries

This records the requested four merge-readiness actions for PR #37525. It is a
bounded implementation/contract audit, not a claim that the entire PR has had a
complete-diff review or that the complete #37513 architecture target is met.

## 1. Preserve current main's business changes

### Automation enqueue lock order (#37567)

The actual mutation owner is now `commitWorkflowInput$` in
`workflow-automation-run.service.ts`, not the old callback in
`workflow-automation-enqueue.service.ts`.

The owner reserves/appends the event sequence before inserting
`chatAutomationContext`. Only an actual accepted event writes its context. Both
remain in the same SQL-only transaction: a context failure rolls back the event
and sequence; a duplicate loser returns without a context write. Schedule,
source transition and queue mutation remain after the event/context write.

This preserves the sequence-before-thread-FK ordering of the concurrent
pick/session writer. Ordinary Web send in `chat-events.command.ts` likewise
executes its pure context SQL plan after the successful input append. No new lock,
retry, suppression or timeout was added.

The upstream four-message Gmail label scenario and FIFO public Run coverage are
preserved. Integration must be accepted by the final-head API pipeline, not the
prior head's green checks.

### Connector prefetch (#37563)

Keep main's captured Agent bootstrap and its catalog projection, connector
selection, source/credential and permission facts. The Thread owner validates
prefetch user/org/agent against the selected execution identity and queue head;
a matching failed prefetch is rejected rather than silently re-read.

`claimBootstrap$` supplies connector selection, accounts and sources to the
actual consumers. Preserve account/session/queue write-boundary checks: captured
metadata is not a permanent credential or execution-authority grant. Public
Runner claims observe the captured default for one pick and the next default for
the next pick. Accepted input still returns before speculative bootstrap work
finishes, and unused speculative failure must not prevent active-run steering.

The model prefetch from #37562 also remains authoritative for the approved
credits/plan observation and persisted admission bit. Expired-credit and member
usage-pack reads stay live; unique admission and authority checks stay at the
mutation boundary.

## 2. Critical business-boundary audit

Paths below are under `turbo/apps/api/src/signals/services/`.

| Boundary                          | Source-backed implementation result                                                                                                                                                                                                                                                                                                                                                                                                                  | Retained public coverage / verification boundary                                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reward duplication and provenance | `get-started-member-reward.ts` gates the grant INSERT on the unresolved token/status claim UPDATE in the same statement. Reward key/slot and grant idempotency uniqueness remain. Invitation acceptance fields share the same claim mutation. Wallet preparation is separate, not a source of independently repeated grants.                                                                                                                         | Get Started public status/credits tests include interrupted review takeover, duplicate invariance and a late reviewer unable to overwrite the replacement result. No duplicate-money defect was demonstrated in this bounded audit.                                                         |
| Queue/Run ownership               | `thread-claim-run.service.ts` pending writer executes pure admission plans locally, fences the exact claim token, preserves session/account validation, producer/source writes and issued allowance window rules. The unique active-Run INSERT remains last; failure rolls the pending transaction back.                                                                                                                                             | Final-head chat/Runner, workflow, identity and admission suites must pass. Soft capacity and approved prefetched credits are observations, not new strict reservations.                                                                                                                     |
| Export execution authority        | `background-job.service.ts` and durable stage SQL retain owner/token/status and database-clock lease predicates. Materialized lease checks acquire the existing row lock before evaluating expiry; checkpoint/inventory changes are gated by that ownership.                                                                                                                                                                                         | Public recovery tests include a stale worker after replacement, completed byte equality, interrupted multipart recovery and notification behavior. This does not establish every possible SQL plan cost or scheduling interleaving.                                                         |
| Export publication authority      | `user-export-durable.service.ts` finishes external bytes outside SQL, reads current Clerk membership, then checks current product-visible inventory under the retained publication transaction. Lease progress and result publication remain one protected mutation. A failed authority check does not expose a download result.                                                                                                                     | Public tests exclude another member's Agent and deny publication after resource reachability changes. No new cross-provider atomicity promise is made.                                                                                                                                      |
| Export cleanup / pins             | `user-export-cleanup.service.ts` completes bounded external cleanup before releasing references. The actual conditional owner DELETE drives entries/parts cleanup in one statement; changed ownership deletes no inventory. Original source snapshot/memory objects are not cleanup targets.                                                                                                                                                         | Public archive/cleanup/recovery behavior must pass on the integrated head. The removed internal kernel tests are not claimed to have a one-to-one public replacement.                                                                                                                       |
| Shared publication / revocation   | `shared-thread.service.ts` records successful SQL insert receipts before checking cancellation, indexed by publication attempt rather than a latest slot. `shared-thread-artifacts.service.ts` checks owned SQL identity/current membership and uses policy ETags for preparing-to-active or revoked transitions. Catalog projection is not the public grant. Cleanup preserves revocation tombstones and only deletes the attempt's owned identity. | Public sharing tests cover foreign-source privacy, owner deletion, publication ownership recheck, client-ID collision and deletion during copying without republishing. Same-Store receipt isolation was also source-traced; that is not claimed as a separately executed concurrency test. |
| MCP parity and privacy            | Send/edit/recall/stop invoke ordinary Web business commands. Dedicated create/replay/receipt/wait protocols are deleted by explicit owner approval; OAuth scopes/current membership/tenant and ownership remain.                                                                                                                                                                                                                                     | Retained parity/read suites verify production outcomes. Do not restore extracted upstream legacy-protocol suites or remove historical source/message decoding.                                                                                                                              |
| Feature overrides                 | Database JSONB conflict merge avoids application read-merge-write lost keys. Pi invalidation/rebuild is independent under the approved low-frequency stale-configuration tolerance. Actual permission checks are not replaced by a feature projection.                                                                                                                                                                                               | Public switch scope/concurrent-key and Pi behavior need final-head acceptance. No new synchronization lock or revision protocol is justified merely by temporary projection staleness.                                                                                                      |

### Lease contracts are not interchangeable

Get Started's review expiry currently makes a claim eligible for takeover. Its
result mutation checks token/status, so an actual takeover fences the older
reviewer. Source and existing public tests do not establish an additional hard
result deadline when no takeover occurs. Do not silently add that different
contract or claim that reward uniqueness proves it.

Export background leases, in contrast, explicitly require an active DB-clock
lease for progress/publication and cannot be treated as takeover-only hints.

Business input rejection uses unique revocation identity, while some existing
preparation-rejection paths are not independently gated on the queue token.
This is an unresolved contract/architecture audit item, not evidence of a newly
introduced duplicate Run or a reason to add coordination locks automatically.

## 3. Final-head verification record

Before this integration, `b65c6dc9ff3d695f861554eba1588ee9ee3e40f7` had 90
successful checks and 23 legitimate skips, including all eight API shards and
all four required gates. Those checks do not validate the changes above.

The current-main integration and the lock-order repair passed the full API
aggregate type pipeline and normal commit hooks. Affected ESLint and full API
normal Oxlint pass after preserving the operational-function length limit via a
pure insertion-outcome predicate. No local Vitest or dev server was run. Final
exact-head public CI is recorded separately in the PR body; cancelled runs are
not passes, and failed jobs are not blindly retried.

## 4. Completed slices versus remaining target work

Source-backed completed slices include MCP protocol removal/Web adaptation,
feature override atomic writes, shared publication receipt isolation, atomic
reward/acceptance writes, export lease/checkpoint/cleanup mutation ownership,
normal enqueue/source SQL ownership and the stable receipt-derived outer picker.

This does **not** mean every listed business chain is terminal-complete:

- The new Thread/execution owners and Pi maintenance path still include broader
  handle-taking read/materialization interfaces inherited from the main cutover.
  These require fresh owner/caller convergence; retiring the old files does not
  prove their replacement meets the target.
- Export snapshot/pin/publication and Run pending transactions are retained for
  the described current contracts. Further removal requires a demonstrated
  equivalent conditional statement and recovery behavior, not a count target.
- Public node counts, source read duplication, escaping capabilities and the
  rejection/lease contracts above still need complete architectural auditing.
- Type/lint/CI success does not establish query-plan/resource equivalence,
  production latency, deployment acceptance or all concurrency interleavings.

Do not expand this PR with unrelated whole-module cleanup. Do not label the full
#37513 target complete or close it solely because this PR merges. A complete
current-head diff review and protected merge gates remain separate from this
bounded contract assessment; no release, production activation or protection
bypass is authorized by this document.

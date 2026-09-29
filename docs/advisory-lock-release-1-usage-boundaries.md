# Release 1 usage and Storage transaction boundaries

This note records the implemented boundary changes and the remaining implementation work. It does not certify Release 1 readiness. The remaining transaction propagation below is unfinished work, not an outgoing-writer compatibility exception.

## Usage publication

`emitRunUsageEventAttempt$` owns its transaction and executes the context read, amount breakdown, hot-event lookup, archive-pointer validation and canonical append directly. Pure query/SQL builders receive only values. Canonical sequence allocation and event insertion remain one statement; initial events use the deterministic run identity and replacements retain the unique revoke edge and exact context pointer.

Archive downloads finish before this transaction starts. The transaction checks the captured archive pointer when no hot event exists. A changed pointer or a hot event moved by retention causes a fresh attempt; stale absence cannot create a second initial event alongside an outgoing writer's random identity. Realtime publication remains after commit.

The retained `chat_usage_message` key still coordinates outgoing random-ID/no-retry writers. Remove it only when pre-Release-1 APIs are no longer serving, their in-flight requests have drained, and the rollback target has the deterministic append protocol. The archive reader still receives a normal read-only database capability outside this transaction; the wider read-service interface cleanup is not represented as complete.

## Allowance preparation

Stripe subscription retrieval receives an immutable entitlement snapshot before standalone settlement, managed Social settlement, built-in run activation, and allowance availability transactions. Its response is transient data, not a new database field or coordination record. There is no Stripe retrieval fallback in the locked entitlement loader.

An expired entitlement accepts prepared work only when its complete existing-row snapshot still matches. Publication uses conditional SQL against the same snapshot. A changed entitlement or an expiry boundary crossed without prepared evidence aborts the financial operation; event claims, allowances and debits roll back together. This prevents stale provider work from restoring a revoked entitlement or changing which wallet pays.

Empty settlement and events already covered by issued allowance windows skip unnecessary refresh preparation. Free or already settled Social jobs also skip it. Historical allowance anchors retain the existing live-run fallback pending a complete production convergence census.

The `credit_` compatibility key remains necessary because outgoing settlement writers read pending events before unconditional completion and do not own allowance-window creation. Release 1 writers claim pending events before pricing and own the existing balance/entitlement rows. Its removal gate is the same serving, in-flight and rollback evidence requirement; waiting or merging alone is insufficient.

## Storage publication

Server-side volume preparation, archive-size reconciliation and publication own their database access in commands. Archive construction, R2 upload and verification finish before publication. The publication transaction contains only direct Storage/version/index/publication SQL; it does not pass a database or transaction to another function. Pure SQL/value builders preserve immutable version identity, existing Pi publication fences and index repair invalidation.

The transaction-bearing preparation APIs `prepareVolumeServerSideWithDb$` and `writeAgentInstructionsStorageInTransaction$` have been removed. Agent instructions PUT prepares objects first and rechecks current Agent ownership, visibility and name during publication. Standalone instructions deletion owns its local SQL transaction and deletes R2 objects after commit. A public concurrent PUT/GET test checks that the visible instructions resolve to one complete uploaded archive.

## Remaining implementation inventory

| Path                            | Remaining work                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credit settlement               | `processOrgUsageEventsInTransaction` and `processOrgUsageEventsInLockedTransaction` still forward transactions through balance, expiry-lot, credit-pack, allowance and default-plan helper calls. Stripe preparation is outside; the SQL ownership graph still needs consolidation. |
| Allowance windows               | Availability, run activation and settlement still pass transactions through window selection, issuance and allocation helpers. No network call remains in the locked entitlement refresh path.                                                                                      |
| Social settlement               | Its command still forwards its job-owned transaction into the shared managed/financial settlement graph.                                                                                                                                                                            |
| Run creation                    | The launch transaction still reaches allowance activation through the larger launch/admission helper graph and timing callbacks. Only immutable provider preparation was moved outside here.                                                                                        |
| Usage deletion                  | The account/Agent lifecycle still calls transaction-aware usage cleanup; parent ownership and raw-before-hourly deletion must stay intact during its remaining refactor.                                                                                                            |
| Other Storage publishers        | Agent instructions final publication, workflow/catalog and custom-connector publication still use the existing SQL-only `commitPreparedVolumeServerSide` and Pi helper graph. The removal of R2 preparation from that transaction does not retire those interfaces.                 |
| Other lifecycle Storage cleanup | Multi-Agent deletion still uses the transaction-aware instruction Storage lock/delete helpers. The standalone deletion wrapper has been retired.                                                                                                                                    |

No persistent fields, generic lock service, lease, saga or new coordination table were added. No full local Vitest suite or local development server was run. Targeted static checks and the combined PR pipeline are the verification boundary; API integration and exact final-head checks must complete before readiness is asserted.

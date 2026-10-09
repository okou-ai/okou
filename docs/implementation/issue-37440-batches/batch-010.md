# Batch 010: public chat queues and completed-Run deletion

Refs #37440. Selection base: `e2607e48cff94b3c08db80b6149ee97d77dce9dd`.
Opening frozen balance: **125 helpers (70 shared /53 local /2 benchmark),
44 HTTP operations /39 paths /134 nested actions**. All 26 open repository
PRs were inspected; no other active #37440 batch was present. The ten-item selection
was recorded in the phase ledger before implementation; this manifest records
the implemented dispositions. #37440 stays OPEN; #33778 is
superseded, not completed. Historical 1,125 cases are separate.

## Ten original definitions

Paths are relative to `turbo/apps/api/src/`. Original lines identify the frozen
CSV objects; they are not current line references.

| Original identity                                                                      | All consumers                                                                                | Decision and exact lost boundary                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-fixtures/chat-events.ts::insertCanonicalChatEventWritesFixture` (608)            | C1 below, sole caller                                                                        | Retire the SQL single/batch/replacement matrix and invented backing Run/session/billing attribution. Delete implementation-only physical storage coverage.                                                                                        |
| Same `readCanonicalChatEventStorageFixture` (683)                                      | C1                                                                                           | Retire raw payload/pointer/metadata readbacks. Public event reads do not prove physical storage layout.                                                                                                                                           |
| Same `isVisibleChatEventFixture` (701)                                                 | C1                                                                                           | Retire direct invocation of the SQL visibility predicate. Lose its result for the manufactured interrupt.                                                                                                                                         |
| Same `readCanonicalRunIdCollisionSafetyFixture` (746)                                  | C1                                                                                           | Retire five direct SQL predicate/join probes. Lose exact raw collision and artifact/dispatch exclusion guarantees for the fabricated interrupt.                                                                                                   |
| Same `insertOutputEventWithConflictingLegacyPayloadFixture` (398)                      | C2 in `chat-threads.bdd.test.ts`, sole caller                                                | Retire deliberately divergent event type/legacy payload and artificial post-cursor timestamp construction. Ordinary writers cannot create this shape; neighboring public unread/read-cursor cases stay unchanged.                                 |
| Same `replayPendingChatInputQueueEventFixture` (132)                                   | Q1 in `chat-events-shared-queue.test.ts`, sole caller                                        | Retire private replacement-event insertion. Retain the normal queued requests and client-owned event IDs, attachment, native claims and real/mock preview choices. Lose private replay-identity reconstruction coverage.                          |
| Same `findPendingChatEventByPromptFixture` (121)                                       | T1 in `integrations-telegram-post.test.ts`, sole caller                                      | Retire SQL discovery of the pending input. Use ordinary Telegram onboarding/linking, signed ingress, public Run logs and authenticated Runner claims.                                                                                             |
| Same `setTelegramThinkingMessageIdFixture` (84)                                        | T1                                                                                           | Retire forced thinking-message metadata. Preserve queued launch context and completion; remove the deletion-of-message701 assertion because the current ingress writer supplies null and users cannot set this internal field.                    |
| `test-fixtures/run-deletion.ts::readHistoryBlobReferenceCountFixture` (7)              | H1/H2 via `checkpointedRun` and direct assertions in `conversation-history-deletion.test.ts` | Retire private blob reference-count observations. Observe completed Run deletion and late callback rejection instead; explicitly lose exact 1→0/repeated-zero physical ledger guarantees.                                                         |
| `signals/routes/__tests__/conversation-history-deletion.test.ts::checkpointedRun` (15) | H1/H2                                                                                        | Public rewrite. Real Stripe invoice/onboarding, personal provider, Agent/chat send, Runner heartbeat/claim, returned sandbox token and checkpoint/complete protocol. Replace locally signed unclaimed-Run tokens and the private count assertion. |

Nine shared and one local definition: **nine retirements and one public rewrite**.
No HTTP operation is completed by this batch. Aliases, removed imports, actions,
and unexported support do not create extra identities.

## Per-declaration decisions

All test paths are under `signals/routes/__tests__/`.

| ID / file / exact original declaration                                                                                  | Disposition, value and public boundary                                                                                                                                                                                                                                                                                                                       | Exact loss                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 `chat-event-canonical-storage.test.ts`: `writes only canonical payloads and pointers through every persistence path` | Delete. Setup inserts a synthetic Run/session and arbitrary input/output/usage/interrupt/replacement rows by internal SQL commands; all decisive observations are SQL layout/predicate checks. The last public read does not make it a public scenario.                                                                                                      | Seven fabricated event rows across three internal persistence builders; exact payload/pointer/failure-reason storage, visibility and five collision predicates. No parameterized declaration is involved. |
| C2 `chat-threads.bdd.test.ts`: `uses event type rather than legacy lifecycle payload for read cursors`                  | Delete. A genuine completed Run is only the prelude to a deliberately conflicting leaf payload that current writers cannot produce. Neighboring ordinary unread indicators, read cursors, completion and thread isolation remain.                                                                                                                            | Semantic-discriminator precedence and unchanged cursor/unreads for that corrupt historical shape; the later public response is not an equivalent public construction.                                     |
| Q1 `chat-events-shared-queue.test.ts`: `derives real-agent preview mode when queued messages are claimed`               | Rewrite. Keep normal feature-preference PUT, an active Runner, two queued send requests, normal upload prepare/complete, original client event IDs, completion/cancellation and subsequent claims. Retain exact prompt, attachment ID, true/undefined preview assertions.                                                                                    | The private replacement event/revocation chain inserted between enqueue and claim. No ordinary queued branch or preview assertion is removed.                                                             |
| T1 `integrations-telegram-post.test.ts`: `rebuilds queued Telegram launch material from context`                        | Rewrite. Replace test seed/read/teardown with existing normal onboarding, personal subscription and signed Telegram link; send both real webhook payloads, read public Run logs and the queued input without a Run in the thread event feed, claim and complete both Runs. Retain exact prompt and integration/thread context including the earlier message. | Privately injected thinking-message ID and exact deleteMessage701 assertion. Normal ingress writes thinkingMessageId=null; a provider mock cannot manufacture application-owned metadata.                 |
| H1 `conversation-history-deletion.test.ts`: `releases history on Agent deletion and does not release twice on retry`    | Rewrite/name accurately: complete a real claimed Run with a checkpoint, observe completed status, delete its Agent, read Run404 and repeat DELETE404.                                                                                                                                                                                                        | Exact history reference count1→0 and zero after repeat; public lifecycle assertions do not establish that ledger invariant.                                                                               |
| H2 same: `releases history through a verified Clerk %s webhook` (`user`, `organization`)                                | Rewrite both rows/name accurately: genuine verified Clerk erasure after real Runner completion, then late completion with that already-issued Runner token returns404. Do not re-authenticate the deleted user/org to observe deletion.                                                                                                                      | Physical reference-count release; observation moves from a fabricated surviving Clerk session to the actual Runner protocol. Both deletion-provider branches remain.                                      |

Implemented declaration totals: **two whole cases/two executions deleted;
four declarations/five executions rewritten**. H2 is one parameterized case
with two rows, both retained. No parameter row is removed or added. No filler
test or timing/retry/assertion weakening is introduced.

## Full-chain evidence and collateral cleanup

- T1 calls `readOnboardingStatus` and `completeOnboarding` directly with normal
  Clerk authentication; the production status endpoint lazily creates the
  default Agent. It then uses the signed production Telegram link. Its personal
  model setup uses an invoice webhook and normal provider requests.
  `requestListLogs` calls the user Run-log API; `runForPrompt` still uses a
  private Run list elsewhere and is deliberately not used or credited.
- Independent review found that the initial T1 factory choice reached
  `bootstrapLimitedFreeOnboarding` → `okouAgentReadHeaders`, which signs a token
  for an invented Run. The selected case now avoids that shortcut entirely.
  The shared factory and its other consumers remain unprocessed; no blanket
  compliance claim is made for neighboring Telegram cases.
- Telegram's current ingress writer in `telegram-post.service.ts` constructs
  `thinkingMessageId: null`. Only the selected private writer supplied701.
  Real callback/runtime code remains unchanged.
- `createRunsApi.createThreadRun` sends a normal chat request and observes
  public events/Run response. `claimRunnerJob` returns the genuine sandbox
  token. Completion validates that token and returns404 when its owned Run
  no longer exists (`agent-webhook-complete.service.ts`); no Clerk session
  reconstruction is needed for the post-erasure assertion.
- History bytes are external Runner output. Existing callback helpers register
  the supplied history at the S3 mock and call normal prepare-history before
  complete; no application-owned business row is injected.
- Remove orphan canonical matrix types and private query builders, the
  conflicting-payload writer, pending Telegram SQL readers, replay writer,
  and the unused history-count module. Other `chat-events.ts` consumers, such
  as the timeout fixture, remain unprocessed.
- T1 was the last consumer of test actions `seed-post-fixture`,
  `get-post-run-state`, and `delete-post-fixture`. Remove their client wrappers,
  snapshot types, route handlers, seed/cleanup support and contract enum entries
  at **zero item quota**. Whole-repository caller search also inspected
  `helpers/telegram.ts` and `helpers/agent-run-callback.ts`: they still use the
  other four actions of `POST /api/test/telegram-state/action`. The operation
  remains unprocessed; it is not renamed or replaced. Nested action reduction
  **134→131** is supplemental, not three completed HTTP operations.
- Knip found `chatInputPromptDispatchCondition` orphaned after C1 removal.
  A repository-wide search at the selection base shows its only callers were
  the removed private collision reader; no production consumer uses it. Remove
  that unused predicate and its obsolete comment at zero quota. The other
  event-type, visibility and ownership predicates remain unchanged.
- Production-source edits are limited to the guarded test route, its test
  contract and that unused predicate. Real production workers, routing, locks,
  accounting, constraints, migrations and user API behavior remain unchanged.

## Verification and remaining scope

Formatting/diff, scoped lint, types and unused-code results are recorded in the
PR and phase ledger. The initial [Changes Requested receipt](https://github.com/okou-ai/okou/pull/38207#issuecomment-6066608899)
for `d37f52b53575c54fcea59fe12014e8590ea431f7` is preserved; later approval
must inspect the repaired complete chain on its new source HEAD.
No local Vitest/dev server. Runtime verification belongs to PR CI, genuine
independent current-HEAD review and the protected queue. Counts change only at
actual GitHub merge; record every failure and repair in the linked ledger.

Conditional post-merge balance: **115 helpers (61 shared /52 local /2 benchmark),
44 HTTP operations /39 paths /131 remaining original nested actions**. The
Telegram operation is still incomplete despite three dead actions being removed.
Phase total would be **100 original objects:98 helpers (93 retired/five public
rewrites) and two retired HTTP operations**.

The withdrawn image trio and unread quartet remain unchanged and unprocessed.
Missing default image pricing and the unread cancellation/construction/performance
gaps are not repaired by this batch. Other private Run readers, timeout/Pi paths,
Telegram's four remaining actions, generic transaction barriers, cache/storage,
usage-pack and service/import exceptions remain separate debt. No whole-suite
compliance or completion of the consolidated #33778 scope is claimed.

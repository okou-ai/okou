# Batch 009: public model selection instead of fabricated catalog state

Refs #37440. Selection base: `990c5436330954f40a27f155baed0023e43a0684`.
Opening frozen balance: **135 helpers (77 shared /56 local /2 benchmark),
44 HTTP operations /39 paths /134 actions**. All 28 open PRs were inspected;
no other active #37440 implementation batch was present. #37440 remains OPEN;
#33778 is superseded, not completed. Historical 1,125 cases remain separate.

This manifest records the decisions before implementation. Paths below are
relative to `turbo/apps/api/src/`. Original lines identify the frozen CSV object,
not a claim that current source lines still match.

## Ten original definitions

| Original identity                                                                                  | All consumers / scenario IDs below                                                                                               | Decision and exact lost boundary                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-fixtures/model-catalog.ts::insertRetiredCatalogRowsFixture` (22)                             | C5, C6 in `model-catalog.test.ts`                                                                                                | Retire. Use an existing retired model name supplied in a normal request for Fast clearing; delete the artificial two-hop catalog graph case. Lose arbitrary operator-created replacement graph coverage.                                                                                                            |
| Same `stageLegacyChatThreadSelectedModelFixture` (61)                                              | C1–C6; S1–S4 in `chat-thread-stored-selection.test.ts` (S3/S4 via the local factory); T1 in `integrations-telegram-post.test.ts` | Retire. Normal creation/selection/send APIs canonicalize retired names. Preserve those explicit requests, real disconnection and ordinary webhook execution. Delete cases that require an invalid or retired value to remain physically stored.                                                                     |
| `test-fixtures/model-route-capabilities.ts::updateModelRouteCapabilitiesFixture` (14)              | R2, R3 in `model-route-capabilities.test.ts`                                                                                     | Retire. R3 compares real connected Fable/Astra choices. Lose in-place operator changes to efforts/default effort/priority support on a fabricated route. The unrelated private primary-route reader remains unprocessed.                                                                                            |
| `test-fixtures/subscription-route-capabilities.ts::insertSubscriptionRouteCapabilitiesFixture` (7) | R2/R3 via `insertSubscriptionModel`; Q1/Q2 in `chat-thread-queue-pick.test.ts`                                                   | Retire. Remove the fabricated personal catalog entry and precise SQL deletion between enqueue/pick. Normal queued setting retention, FIFO, recalls and public capacity changes remain independently.                                                                                                                |
| `test-fixtures/retired-member-image-model.ts::seedRetiredMemberImageModelFixture` (9)              | I1 in `image-io-generate.test.ts`                                                                                                | Retire. Use the actual unset image preference and public generation lifecycle. Lose normalization of a fabricated unsupported member preference.                                                                                                                                                                    |
| `test-fixtures/run-image-model.ts::setRunImageModelFixture` (7)                                    | I1 via `seedImageRun`                                                                                                            | Retire. Obtain the image request token from a real Runner claim. Lose physical null/retired Run snapshot fallback guarantees.                                                                                                                                                                                       |
| `signals/routes/__tests__/model-route-capabilities.test.ts::connectedActor` (21)                   | R1–R3 before edits; R1/R3 retained                                                                                               | Public rewrite. Replace direct active/free entitlement insertion with normal onboarding/status APIs, then genuine Codex device-auth start/complete and user preference requests. Retain personal capabilities on the ordinary free plan.                                                                            |
| Same `insertSubscriptionModel` (35)                                                                | R2/R3                                                                                                                            | Retire the private catalog factory. R3 uses existing models; R2's arbitrary runtime catalog mutation is deleted.                                                                                                                                                                                                    |
| `signals/routes/__tests__/chat-thread-stored-selection.test.ts::stagedWebhookAutomation` (201)     | S3/S4                                                                                                                            | Public rewrite, renamed `webhookAutomationWithSelection`. Normal Stripe invoice/onboarding, personal subscription, Agent/workflow/automation create, thread model PATCH, genuine signed webhook and public Run/thread/event reads. Lose selection repair at queue pick, not normal selection and webhook execution. |
| `signals/routes/__tests__/image-io-generate.test.ts::seedImageRun` (863)                           | I1 only                                                                                                                          | Retire internal compose/Run seeding and snapshot mutation. I1 uses normal chat send and authenticated Runner claim with canonical seeded pricing, without per-case pricing overrides.                                                                                                                               |

Six shared and four local identities; no API operation credit. Implemented
disposition: eight retirements and two complete public rewrites. Returned
methods, imports, interfaces, mock helpers and declaration branches are not
additional identities. `setModelPiRouteClassFixture`, `readPrimaryBuiltInRouteFixture`
and the other image/pricing fixtures remain unprocessed.

## Per-declaration decisions

All paths in this table are under `signals/routes/__tests__/`.

| ID / file / exact original declaration                                                                                   | Decision and retained public behavior                                                                                                                                                                                                                        | Exact loss                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| C1 `model-catalog.test.ts`: `runs a thread stored with claude-fable-5 as claude-fable-5-1 and rewrites the thread`       | Rewrite: create the thread with the explicitly requested retired name through the normal API, then inspect canonical MCP projection, send, public Run source and thread metadata.                                                                            | Reading/repairing a physically stored retired thread selection at send, including its repair-only event.                                 |
| C2 same: `rejects a send whose replacement requires a subscription the member never connected`                           | Rewrite: retain the explicit `gpt-5.5` send branch, exact 400 explanation and unchanged public event feed/Auto thread.                                                                                                                                       | The implicit-send branch relying on a SQL-staged `gpt-5.6-terra` selection. This is a removed manual loop branch, not an `it.each` row.  |
| C3 same: `accepts a replacement whose subscription account is disconnected and reports the reconnect error`              | Rewrite: publicly pin the active model before disconnection; keep real active Run claim, account DELETE, accepted send, cancellation and exact public reconnect rejection/error.                                                                             | Retired-name rewrite while a disconnected account is retained.                                                                           |
| C4 same: `projects a legacy Codex selection without a Codex account as unavailable`                                      | Rewrite: publicly select an available personal model, disconnect its provider, then read its unavailable MCP projection.                                                                                                                                     | Legacy Codex-to-successor projection without ever having connected that subscription.                                                    |
| C5 same: `clears a Fast tier the replacement does not offer`                                                             | Rewrite: select real Astra/Fast, explicitly send with existing retired Fable name, retain successor Run, cleared tier and exact model/tier event assertions.                                                                                                 | Privately invented catalog row and repair of its physically stored selection.                                                            |
| C6 same: `resolves a multi-hop replacement chain to the final model`                                                     | Delete. A client cannot create this arbitrary operator catalog topology. Existing explicit retired-name request coverage remains.                                                                                                                            | Artificial two-hop lineage, MCP resolution and physical snapshot rewrite.                                                                |
| R1 `model-route-capabilities.test.ts`: `rejects max and accepts xhigh for the connected Luna subscription`               | Keep assertions; rewrite shared actor setup through public free onboarding and Codex connection.                                                                                                                                                             | Hand-set entitlement shape; ordinary free-plan behavior is retained.                                                                     |
| R2 same: `accepts only the reasoning efforts the personal catalog route lists`                                           | Delete. Its decisive transition edits operator-owned route capabilities in place. R1 still verifies concrete supported/unsupported client efforts.                                                                                                           | Arbitrarily changed effort/default-effort metadata taking effect on the same invented model.                                             |
| R3 same: `offers Fast only when the personal route lists the priority tier`                                              | Rewrite with existing Fable (400) and Astra (200/priority) under the same connected member.                                                                                                                                                                  | Same-model operator mutation of priority support.                                                                                        |
| Q1 `chat-thread-queue-pick.test.ts`: `rejects one input per thread and continues picking the organization's next thread` | Delete. It inserts and then physically deletes a catalog entry between enqueue/pick to select the internal rejection pass.                                                                                                                                   | Exact reject-one-head/skip-successor/advance-other-thread ordering after private catalog deletion.                                       |
| Q2 same: `rejects a queued retired model at its pick`                                                                    | Delete. Decisive retirement is private catalog deletion.                                                                                                                                                                                                     | Queued unknown-model rejection at the chosen pick boundary.                                                                              |
| S1 `chat-thread-stored-selection.test.ts`: `rejects a web chat send without an explicit model and creates no run`        | Delete. Current public writers reject/normalize the fabricated unknown stored selection.                                                                                                                                                                     | Implicit-send rejection and no enqueue for that corrupt stored value.                                                                    |
| S2 same: `enqueues a webhook automation input, rejects it at pick, and creates no run`                                   | Delete. Signed ingress is real, but its decisive unknown stored model is private.                                                                                                                                                                            | Enqueue-then-reject/no-Run behavior for that corrupt thread.                                                                             |
| S3 same: `rewrites the thread to the replacement and runs the automation on it`                                          | Rewrite: PATCH the retired requested name through the existing thread API before signed webhook ingress; keep successor Run and exactly one public model-selection event, then cancel the actual Run.                                                        | Repair during queue pick rather than normalization at the user write boundary.                                                           |
| S4 same: `rejects an automation input whose replacement requires a subscription the member never connected`              | Delete. Normal thread writes cannot save this unavailable legacy selection. C2 retains the normal client rejection.                                                                                                                                          | Automation pick/error text and unchanged legacy thread after private setup.                                                              |
| T1 `integrations-telegram-post.test.ts`: `rewrites a Telegram DM thread stored on a retired model to its successor`      | Delete. Adjacent real DM continuation, model commands, reply anchors and forum behavior stay unchanged.                                                                                                                                                      | Repair of a privately overwritten Telegram thread and its repair-only event.                                                             |
| I1 `image-io-generate.test.ts`: `uses the catalog default for unset, retired, and run-less requests`                     | Rewrite: ordinary paid onboarding/personal chat, unset image preference, actual Runner token and session requests to image generation/status; assert default model/provider and exact external OpenAI request bodies. Use the ordinary seeded price catalog. | Fabricated null/retired Run snapshots and retired member preference normalization. Normal unset-member Run and run-less behavior remain. |

Verified source counts: **8 whole declarations deleted /8 executions; 9 declarations
rewritten /9 executions**. None is an `it.each` declaration. I1's old manual
three-request matrix becomes two ordinary public requests; C2 loses its implicit
manual loop branch. No parameterized row or additional filler declaration is
introduced. A declaration comparison confirms the eight-name net reduction;
R1 is counted once for its changed setup, although its assertions are unchanged.
Runtime verification remains assigned to PR CI.

## Boundary evidence and support cleanup

- `PUT /api/user-model-preference` and normal thread creation/metadata selection
  resolve existing catalog names; they cannot author arbitrary catalog entries
  or preserve invalid/retired values in application rows. Public catalog reads
  are not operator configuration APIs (`docs/model-catalog.md`).
- `configureSubscriptionPiModel` invokes actual device-auth start/complete and
  preference requests; its OAuth mock supplies provider-owned responses.
  `entitledNativeChatActor` obtains entitlement through the real Stripe invoice
  webhook/onboarding, creates a personal provider and Agent through normal APIs.
- `setupWorkflowOrg` uses those same public billing/onboarding/provider paths.
  Webhook URLs/secrets come from automation creation and ingress uses its HMAC
  protocol. No operator cron or internal worker is invoked.
- I1's complete chain must use actual send/claim-issued credentials, public
  preferences/generation/status and normal cancellation. A public final image
  response alone would not justify `seedImageFixture`, `seedOrgMetadata`,
  `createScopedImagePricing`, or a manually signed token for an invented Run.
- Remove the now-unused subscription/image fixture modules, legacy catalog
  row type/writers, private local factory and dead imports. Preserve remaining
  Pi class and primary-route fixtures and all real production model selection,
  routing, accounting, workers, constraints and migrations.

## Verification and remaining scope

No local Vitest/dev server, added wait/retry/timeout, weakened assertion,
production change or rollout action is authorized. Local API type checking passed, including all three test projects and bootstrap
wiring. Scoped ordinary/type-aware lint and ESLint, formatting and unused-code
checks are recorded with the PR. Runtime verification belongs to PR CI, followed
by independent current-HEAD review and the protected queue. Counts change only
at actual merge.

Pre-commit source verification corrected the initial proposed Fast comparison:
Luna supports priority too, so R3 connects Fable normally and uses its unsupported
Fast request against Astra. This preserves 400/200 without editing catalog rows.
An initial local lint finding (`expect(await ...)`) was corrected to `resolves`;
a type-aware invocation without the repository configuration was corrected, not
used to justify unrelated source changes. The initial offline dependency install
lacked `@smithy/core`; the normal frozen online install succeeded.

Conditional post-merge balance: **125 helpers (71 shared /52 local /2 benchmark),
44 HTTP operations /39 paths /134 actions**. Phase total would be 90 original
objects: 88 helpers (84 retired/four public rewrites) and two retired operations.

The four unread identities and their failed batch008 rewrite remain restored and
unprocessed. System cache, storage-fixture, remaining index, usage-pack,
Pi/operator/firewall/connector/service exceptions, primary model-route readers,
other image private pricing/setup/teardown and unrelated forged-token branches
remain outside this batch. No whole-suite compliance or completed consolidated
#33778 scope is claimed.

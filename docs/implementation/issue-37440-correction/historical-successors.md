# Historical-name closure receipt

Baseline: `13753817e6507ac8b71315166dac807a87711c4c`; checked again on A commit `9e4cfcc770` (same retained source for these cases).

## Five image-recognition declarations

All five historical #37803 names were still present immediately before commit `f3838353ba0455ec7d57dfa2d0974e34a44796ff` / #37856:

- `recognizes one owned image and settles each real invocation` (parent line 1218)
- `rejects non-owned and invalid uploaded image metadata` (1500)
- `maps provider image errors without exposing raw provider text` (1588)
- `rejects usable text when provider usage metadata is incomplete` (1642)
- `rejects incomplete or empty provider output without charging or reporting usage` (1687)

That commit deletes the entire `turbo/apps/api/src/signals/routes/__tests__/image-recognition.test.ts` file, its API route, service, API contract, CLI command and associated contract tests. `git show --name-status` marks these as `D`, not renames. No recognition test file exists on baseline. These five were already removed by product retirement; no corrective deletion or new reduction credit is claimed here. Evidence: https://github.com/okou-ai/okou/commit/f3838353ba0455ec7d57dfa2d0974e34a44796ff .

## Chat model-selection successor

Historical `pins okou-1.0 on its Built-in route for limited-free-1 workspaces` was renamed and adjusted by `d0e0b7191fe168e8935e1abf3df1fa1806efea2a` / #37901 to `selects Auto as a null thread selection for limited-free-1 workspaces`. Exact diff changes old name and model selection from `"okou-1.0"` to `null`, preserving the fixture/lifecycle. Evidence: https://github.com/okou-ai/okou/commit/d0e0b7191fe168e8935e1abf3df1fa1806efea2a .

Decision: keep unchanged. Inspected the whole current declaration and nested setup/observation/cleanup chain:

- `createPublicFirewallFixture.fund()` defaults to `createRunsApi.grantProEntitlement`: mocked external Stripe invoice/signature enters the actual `/api/webhooks/stripe` route, followed by authenticated billing status and onboarding read/complete routes. No DB writer or worker dispatch in the chosen fund branch.
- `ensurePersonalSubscriptionModel` enters `personalModelProvidersMainContract.upsert` (external Claude token response mock), then the production user-model preference route. `selectNativeClaudeModel` is a second call to that same public preference route.
- Agent creation is the public BDD create-agent route. `customer.subscription.deleted` enters the signed Stripe webhook route; public billing status proves downgrade to `limited-free-1` with credits retained.
- `chat.createThread`, `updateThreadModelSelection`, and `readThreadMetadata` call their normal authenticated thread routes, with explicit null selection. Assertions retain title and `selectedModel: null`.
- Fixture teardown uses normal run/connector/Clerk deletion routes. Its private feature-switch cleanup is cleanup only; this declaration never sets a private feature-switch or constructs state through it.

No follow-up code commit is needed for these six historical names. The original chat declaration is preserved through its public successor and carries no new deletion credit.

## Pi stable-context retirement during protected-merge preparation

Main #37905 (`c339e73f0fb5d0ca0a8f4a4e80c67331ea9fb79d`, included in integrated main `1a4cbda1d901006994149202b74d5135d8b74f6d`) retired the unused stable-context/snapshot product path. It already removed two decisions recorded in this correction: `records ready stable-context demand in the system-skill V2 transaction` and `builds stable context when a captured gzip hint differs from the ready index`. Deduct these overlaps from this PR's current-main deletion count.

The same main PR separately removed `keeps an archive-less empty writeback empty after its index is ready` and `prepares a snapshot from a different gzip size and reuses the logical index`. These two were not part of the original 529-declaration deletion inventory; preserve their product retirement without claiming new correction credit. The remaining ready-index reuse consumer's private construction is separately documented in construction-and-documentation.md before deletion.

## Per-case isolation integration

Main #37896 (`28c0ec43505f5032b005505d92c5e7c6d74d8a03`) independently removed all five declarations in `turbo/apps/api/src/signals/services/__tests__/pi-memory-maintenance.boundary.test.ts`:

- `fails closed without a current built-in route`.
- `keeps memory binding checks for a captured route`.
- `settles changed output exactly once through $label` — seven branches.
- `settles real no-diff with $label selection and no provider charge` — two branches.
- `recovers the exact parent without publishing after %s` — four branches.

These were already in A's original 207-declaration deletion inventory. Retain their historical private construction/worker reasons, but exclude them from the current PR's 202-declaration A subtotal. The maintenance file and its old separate Vitest project remain deleted. No declaration is counted again because main removed it independently.

Two other declarations have current-main successors:

| File                                         | Historical name                                                                | Current-main name                                                                                             | Decision and coverage                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-memory-stage1-worker.test.ts`            | bills built-in extraction at the served route's catalog long-context threshold | bills built-in extraction at the served route's catalog long-context threshold with $inputTokens input tokens | Delete the same unsupported case. Main parameterizes inputs 272,000 and 272,001, but still seeds a Built-in key and chosen long-context pricing, executes scoped extraction, and privately inspects usage categories. One whole declaration, two parameter branches; no new case credit. |
| `official-workflows-schedule-claims.test.ts` | settles once when concurrent first deliveries of the same completion arrive    | advances the schedule once across repeated completion dispatches                                              | Delete the same unsupported case. Main removes the concurrent-contender count assertion, but still constructs an operator-published catalog, invokes `executeWorkflowAutomationForTest`, and forces internal callback dispatch. No independently public schedule advancement remains.    |

Main also moves five existing `official-automation-result-email.test.ts` declarations into `with a published Official catalog` and nested real-Run describe groups: `links Morning Brief management to Preferences without changing account unsubscribe`, `falls back after pathological Markdown expansion and sends one bounded multipart email`, `keeps suppression at send and leaves a successful Run unchanged`, `keeps terminal-failure Runs ineligible for result email`, and `honors account unsubscribe for successful result callbacks`. Their exact case names and private operator/selected-outbox dependencies persist. Changed describe scopes are not five new cases or five independently removed main cases; each remains counted once in the corrective inventory.

The main-relative source inventory changes from the first integration's 528 deletions to 523 solely by excluding the five maintenance declarations. Renaming/parameterizing the two successors and regrouping the five email declarations does not change whole-case counts. The seven unsupported branches removed from retained public declarations are unchanged.

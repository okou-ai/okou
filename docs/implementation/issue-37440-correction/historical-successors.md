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

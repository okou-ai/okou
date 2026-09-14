# Personal subscription run identity

This preparatory slice implements #34012 for #34010. It does not change provider precedence, organization model policies, subscription protocols, model catalogs, pricing, or UI availability.

## Binding and credential ownership

Every newly admitted personal Claude/Codex subscription run captures a concrete `model_provider_accounts.id`, independently of `_multipleSubscriptions`. Capture precedes session/executor preparation. The final admission transaction takes the existing organization admission lock and then the provider auth-state lock, revalidates the captured connected account, and writes the same ID to run metadata/model pin and execution-context model-provider `sourceId`. Removal winning that race produces an explicit subscription admission failure; it never selects a sibling account, organization API key, or other model.

Account rows own encrypted credentials. Refresh and verified same-upstream-identity reconnection update those shared credentials under the existing auth-state lock; rotating refresh tokens are never copied per run. Codex uses its upstream account ID. Claude uses account/organization UUIDs when provided by the existing profile endpoint, with the existing stored email/workspace identity for older OAuth connections. A legacy Claude token without recorded identity is checked using that token before a replacement; an unavailable identity is left unchanged rather than inferred from the new active account.

With `PersonalSubscriptionPriority` enabled, a different upstream identity selects/creates a different account row. Duplicate reconnection reuses the matching identity while preserving any other identity referenced by an admitted run. Ordinary disconnect hides the account from listing, selection, activation, reset/usage and reconnect by the old ID. A fresh authenticated connection to the same upstream identity can restore that row and its shared refresh state.

Disconnected rows and their encrypted secrets survive only while an exact `(runId, orgId, userId, accountId)` reference is `queued`, `pending` or `running`. Runtime firewall and supported Pi credential reads/refreshes must prove that reference. The logical parent survives only to own retained rows; the last connected account removes the singleton mirror after detaching its cascading foreign key. Retained-only parents are hidden and never lazily reseeded.

The shared terminal transition cleans the final disconnected reference after completion, failure, cancellation, runtime timeout or queue expiry. It rechecks under the auth-state lock, including when disconnect was still committing at the first read. Cleanup is transactional and idempotent. There is no elapsed-time retention period or background retention workflow. User/org deletion and user ban keep their existing hard authority termination and cleanup paths. Membership cleanup now explicitly cancels the removed member's nonterminal runs, removes queue entries, and hard-deletes personal providers, mirrors and pending provider auth sessions in that organization. A regression test exposed that the previous membership cleanup only removed membership resources/cache and still allowed runtime subscription auth. In-flight refresh does not recreate deleted accounts.

## Preparation, activation and rollback gates

`PersonalSubscriptionPriority` is organization consistent, defaults to false for everyone (including staff), and has no automatic allowlist. This PR writes new exact bindings with the flag off. Ordinary disconnect and identity retirement retain the deployed destructive/mutable behavior until the controller explicitly enables the switch. `_multipleSubscriptions` continues to control only its existing UI surface.

The migration adds only nullable `disconnected_at`. Apply the additive migration before the new API serves traffic. The previous API can read the expanded schema; existing logical rows, mirrors, encrypted secret format and auth-state locks remain compatible. During mixed versions the old singleton writer and sourceId-less reader still exist. The current sourceId-less refresh writer synchronizes active concrete token and expiry/reconnect state under the same lock. Preparation is not the activation gate: old API writers can still perform the previous mutable/destructive operations.

Before enabling the new behavior, the controller must verify both:

1. Every pre-preparation personal subscription execution context without a concrete sourceId has drained, including queued, pending and running contexts and contexts eligible for replay/continuation. Use persisted execution contexts and nonterminal ownership, not account counts or an assumed two-hour delay. Any surviving older exact-source context must also agree with its run metadata account ID; drain unknown or mismatched bindings instead of repairing them from the active account. Do not backfill historical runs with today's active account.
2. All serving API writers are at or beyond this preparation and the rollback target understands retained accounts. No old API writer may delete a retained parent or overwrite account identity after activation.

Keep the sourceId-less compatibility reader and singleton mirror until all actual old producers, persisted contexts, queue/replay horizons and the supported rollback window have drained. The controller records that evidence in #34010 before a later child removes the branch. It is deliberately retained in this PR.

Before activation, code rollback is compatible with the additive column and the previous settings behavior. After activation, do not roll back to a writer that hard-deletes retained rows or disable retention while retained nonterminal references exist. Stop new admission/mutation as needed, drain the exact retained references, verify cleanup, and only then return to the old writer/feature-off behavior. No production override, release or production migration is executed by this implementation owner.

## Scale and validation

The controller's production inventory at **2026-09-14 08:38:07 UTC** found **64 logical subscriptions**. Only **31 concrete accounts**, belonging to **16 logical providers in 2 organizations**, existed. Singleton paths are therefore part of the primary preparation and validation surface.

The API tests exercise real chat admission and runner/firewall authorization for both subscription types with the multi-account UI off/on, feature-off preparation, pending/queued/running replacement, same-identity recovery, retained refresh serialization, final-reference terminal cleanup, and global hard revocation. They assert emitted source IDs and actual authorization headers, not only account-helper return values. Existing supported Pi, account-switch, subscription failure and settings tests remain part of targeted regression validation and the PR pipeline.

# onboarding

## onboarding-001

- Vitest: "Onboarding draft > restores one member's draft and refuses stale edits or another member's reads"
- Mode: run
- Given: A signed-in workspace member has no onboarding draft, and another member of the same workspace exists.
- When: The member saves a draft via `PUT /api/onboarding/draft` with revision `null`, saves an update with step `capabilities` using the returned revision, retries a save with the stale first revision, and reads `GET /api/onboarding/draft`; the other member reads their own draft.
- Then: Both saves return HTTP 200 and the stale save returns HTTP 409. The read restores the draft with step `capabilities` and the latest revision. The other member's draft is `null`.

## onboarding-002

- Vitest: "Onboarding draft > expires abandoned drafts and blocks restoration or late saves after completion"
- Mode: run
- Given: At 2026-11-18T00:00Z a signed-in workspace member saves an onboarding draft.
- When: Seven days later the member reads `GET /api/onboarding/draft`, saves a new draft, completes onboarding via `POST /api/onboarding/complete`, then reads the draft and saves with the latest revision.
- Then: After seven days the read returns draft `null` and the new save succeeds. After completion both the draft read and the late save return HTTP 404.

## onboarding-003

- Vitest: "GET /api/onboarding/status > returns 401 when the request is unauthenticated"
- Mode: run
- Given: An unauthenticated caller.
- When: The caller requests `GET /api/onboarding/status` without credentials.
- Then: The response is HTTP 401 with `{ error: { message: "Not authenticated", code: "UNAUTHORIZED" } }`.

## onboarding-004

- Vitest: "member source-first onboarding > starts onboarding for a new member"
- Mode: run
- Given: A new member of a workspace whose admin has not completed onboarding.
- When: The member requests `GET /api/onboarding/status`.
- Then: The response is exactly `needsOnboarding: true`, `onboardingComplete: false`, `isAdmin: false`, `hasOrg: true`.

## onboarding-005

- Vitest: "member source-first onboarding > keeps the organization's completion as the org-wide answer for a member"
- Mode: run
- Given: A workspace admin has completed onboarding via `POST /api/onboarding/complete`, and a new member joins.
- When: The member requests `GET /api/onboarding/status`.
- Then: The member still has `needsOnboarding: true`, while `onboardingComplete` is `true` and `isAdmin` is `false`.

## onboarding-006

- Vitest: "member source-first onboarding > records a member's completion without changing the organization's onboarding"
- Mode: run
- Given: A workspace admin has not completed onboarding and a member belongs to the same workspace.
- When: The member completes `POST /api/onboarding/complete` with time zone `Asia/Shanghai` and industry `marketing`; both read `GET /api/onboarding/status`, and the admin lists `GET /api/run-models`.
- Then: The admin's initial status needs onboarding and is incomplete. The member's completion returns exactly `{ onboardingComplete: true, needsOnboarding: false }`; the member's status shows `needsOnboarding: false` with organization `onboardingComplete: false`. The admin still shows `needsOnboarding: true`, `onboardingComplete: false`, `isAdmin: true`, and the run models list only `auto`.

## onboarding-007

- Vitest: "member source-first onboarding > does not pull a member with an existing thread in the workspace into onboarding"
- Mode: run
- Given: A member already has a chat thread in the workspace.
- When: The member requests `GET /api/onboarding/status`.
- Then: The status shows `needsOnboarding: false` and `isAdmin: false`.

## onboarding-008

- Vitest: "member source-first onboarding > only counts the member's own threads in the current workspace"
- Mode: run
- Given: A member has no threads of their own; a peer has a thread in the same workspace and the same user has a thread in another workspace.
- When: The member requests `GET /api/onboarding/status`, creates a thread in this workspace, and requests the status again.
- Then: The first status shows `needsOnboarding: true`; after the member's own thread the status shows `needsOnboarding: false`; both show `isAdmin: false`.

## onboarding-009

- Vitest: "POST /api/onboarding/complete > starts Suggestions for each new account when that person finishes onboarding"
- Mode: run
- Given: The official workflow catalog has been synced via `GET /api/cron/sync-official-workflow-catalog`, and a newly created admin and member account belong to the same workspace.
- When: Each person reads `GET /api/preferences/proactive-suggestions`, completes onboarding with time zone `Asia/Shanghai`, and reads it again; the member then turns Suggestions off via `PUT /api/preferences/proactive-suggestions/with-feed` and completes onboarding again.
- Then: Each person's Suggestions are disabled before completion and `enabled: true`, `status: "enabled"` after. After the member's opt-out and repeated completion, the member's Suggestions remain disabled.

## onboarding-010

- Vitest: "POST /api/onboarding/complete > keeps a pre-rollout account paused when it joins a new workspace"
- Mode: run
- Given: A member whose account was created on 2020-01-01, before the Suggestions rollout, joins a new workspace.
- When: The member completes `POST /api/onboarding/complete` and reads `GET /api/preferences/proactive-suggestions`.
- Then: Suggestions are `enabled: false` with `status: "paused"`.

## onboarding-011

- Vitest: "POST /api/onboarding/complete > preserves a new account's opt-out made before onboarding"
- Mode: run
- Given: A newly created account has turned Suggestions off via `PUT /api/preferences/proactive-suggestions/with-feed` before onboarding.
- When: The account completes `POST /api/onboarding/complete` and reads `GET /api/preferences/proactive-suggestions`.
- Then: Suggestions remain disabled.

## onboarding-012

- Vitest: "POST /api/onboarding/complete > can retry onboarding after Clerk temporarily fails to return the account"
- Mode: run
- Given: A workspace admin is signed in, and Clerk fails the first account lookup.
- When: The admin calls `POST /api/onboarding/complete`, reads the onboarding status, then completes again once Clerk returns the newly created account, and reads Suggestions.
- Then: The first completion fails with "Clerk is unavailable" and the status still needs onboarding. The retry succeeds and Suggestions are enabled.

## onboarding-013

- Vitest: "POST /api/onboarding/complete > publishes the free Plan on completion and keeps it on replay"
- Mode: run
- Given: A signed-in workspace admin who has not completed onboarding.
- When: The admin completes `POST /api/onboarding/complete` with industry `marketing`, reads `GET /api/billing/status`, replays completion with industry `design` and with an empty body, and reads billing and onboarding status again.
- Then: Completion returns exactly `{ onboardingComplete: true, needsOnboarding: false }`. Billing shows tier `limited-free-1`, `active`, concurrency limit 2, no concurrency purchase, credit purchase allowed, no usage pack, no auto-recharge, restricted built-in models, no webhook automations, 0 credits and no subscription. Both replays return the same completion body, billing is unchanged, and the status shows complete, not needing onboarding, admin, with an organization.

## onboarding-014

- Vitest: "POST /api/onboarding/complete > completes simultaneous public requests without an industry and preserves completion on replay"
- Mode: run
- Given: A signed-in workspace admin who has not completed onboarding.
- When: The admin sends two simultaneous `POST /api/onboarding/complete` requests with empty bodies, reads billing status, replays completion, and reads onboarding status.
- Then: Both requests return exactly `{ onboardingComplete: true, needsOnboarding: false }`. Billing shows tier `limited-free-1`, `active`, concurrency limit 2, restricted built-in models, credit purchase allowed and 0 credits. The replay returns the same body and the status shows complete, not needing onboarding, admin.

## onboarding-015

- Vitest: "POST /api/onboarding/complete > lets a member complete onboarding instead of refusing them"
- Mode: run
- Given: A signed-in workspace member (not an admin).
- When: The member calls `POST /api/onboarding/complete`.
- Then: The response is HTTP 200 with exactly `{ onboardingComplete: true, needsOnboarding: false }`.

## onboarding-016

- Vitest: "POST /api/onboarding/complete > persists an admin's completed onboarding state"
- Mode: run
- Given: A signed-in workspace admin who has not completed onboarding.
- When: The admin reads `GET /api/onboarding/status`, completes `POST /api/onboarding/complete` with an empty body, reads the status again, and lists `GET /api/run-models`.
- Then: Before completion the status needs onboarding, is incomplete, admin, with an organization. Completion returns exactly `{ onboardingComplete: true, needsOnboarding: false }`, the later status is complete and no longer needs onboarding, and the run models list only `auto`.

## onboarding-017

- Vitest: "POST /api/onboarding/complete > completes an admin's onboarding with the field the source-first flow answered"
- Mode: run
- Given: A signed-in workspace admin who has not completed onboarding.
- When: The admin calls `POST /api/onboarding/complete` with industry `marketing` and reads `GET /api/onboarding/status`.
- Then: Completion returns exactly `{ onboardingComplete: true, needsOnboarding: false }`, and the status shows `needsOnboarding: false`, `onboardingComplete: true` and `isAdmin: true`.

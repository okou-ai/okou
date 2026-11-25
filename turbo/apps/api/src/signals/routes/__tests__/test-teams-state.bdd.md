# test-teams-state

## test-teams-state-001

- Vitest: "Teams message launch context > dispatches a Teams message with its public launch context"
- Mode: run
- Given: An onboarded workspace member with a Pro entitlement and a native subscription model has installed the Teams app and connected their Teams account; the Teams status reports installed and connected for the tenant. Microsoft Graph lists no personal app installations.
- When: Teams posts a personal message `hello from teams diagnostics` (activity `activity-e2e` in `19:e2e-dm@thread.v2`) to `POST /api/webhooks/teams/bot`, and the member reads the Run list, the Run detail, the Runner execution input and the chat thread events.
- Then: The Run list and detail show a `running` Run with trigger source `teams` and that prompt. The system prompt contains the tenant ID, conversation ID `19:e2e-dm@thread.v2`, conversation type `personal`, thread ID and activity ID `activity-e2e`. The Run's `input.prompt` event displays the message text and includes a Teams `source` link to the message with a chat context.

## test-teams-state-002

- Vitest: "Teams webhook dispatch > drains a persisted Teams message when realtime publishing fails"
- Mode: run
- Given: An onboarded workspace admin with a Pro entitlement and native subscription model has installed Teams and connected their Teams account. Realtime publishing fails with "Ably channel rate limit exceeded".
- When: Teams posts a personal message `dispatch despite realtime failure` to `POST /api/webhooks/teams/bot`.
- Then: The webhook returns HTTP 200 with `ok: true`, the Run list contains a `running` Run with trigger source `teams` and that prompt, and a `threadListChanged` realtime publication was attempted.

## test-teams-state-003

- Vitest: "Teams webhook dispatch > rejects unlinked users and dispatches for a connected member"
- Mode: run
- Given: An onboarded member installed Teams and then disconnected their Teams account, so status shows installed but not connected. A second member is installed and connected but not onboarded (no default Agent profile).
- When: Each member's Teams user posts a personal message to `POST /api/webhooks/teams/bot`, and each reads their Runs or chat thread events.
- Then: The unlinked user receives the notice "Please connect your account to use Okou in this Teams workspace." and has no Runs. The connected member's Teams status shows installed and connected, and after the message their chat thread events include a `created` thread event.

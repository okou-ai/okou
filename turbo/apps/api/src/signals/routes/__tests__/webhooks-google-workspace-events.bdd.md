# webhooks-google-workspace-events

## webhooks-google-workspace-events-001

- Vitest: "Google Workspace Events subscription lifecycle > dispatches a visible Google Meet transcript message"
- Mode: run
- Given: A workspace member with a workflow and a supported model has connected Google Meet and created a `google-meet-transcript-generated` automation, which creates a Workspace Events subscription for the member's transcript events.
- When: Pub/Sub pushes a signed `google.workspace.meet.transcript.v2.fileGenerated` CloudEvent for that subscription to `POST /api/webhooks/google-workspace-events`.
- Then: The webhook responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`. The automation thread shows `A Google Meet transcript is ready.` and has no connector selections. Deleting the automation returns HTTP 204.

## webhooks-google-workspace-events-002

- Vitest: "Google Workspace Events subscription lifecycle > does not create provider state for a disabled automation"
- Mode: run
- Given: A workspace member with a workflow has connected Google Meet.
- When: The member creates a `google-meet-transcript-generated` automation with `enabled: false` via `POST /api/workflows/:workflowId/automations`, then deletes it via `DELETE /api/workflow-automations/:id`.
- Then: The automation is created disabled and the delete returns HTTP 204. Google Workspace Events receives no create, renew or delete requests at any point.

## webhooks-google-workspace-events-003

- Vitest: "Google Workspace Events subscription lifecycle > rolls back active create and enable when provider setup fails"
- Mode: run
- Given: A workspace member with a workflow has connected Google Meet and has a disabled `google-meet-transcript-generated` automation. Google Workspace Events rejects subscription creation with HTTP 503.
- When: The member enables the disabled automation via `POST /api/workflow-automations/:id/enable`, then creates a new enabled Meet automation, then lists the workflow's automations.
- Then: Both the enable and the create respond HTTP 400 with an error message containing `Failed to ensure Google Meet Workspace Events subscription`. The list contains only the original automation, still disabled. Google received two subscription create attempts and no delete requests.

## webhooks-google-workspace-events-004

- Vitest: "Google Workspace Events subscription lifecycle > keeps a shared subscription until the last enabled consumer"
- Mode: run
- Given: A workspace member with a workflow has connected Google Meet and created two enabled `google-meet-transcript-generated` automations, which share one Workspace Events subscription.
- When: The member disables the first automation, deletes the second, and then deletes the first.
- Then: Only one subscription was created. Disabling the first deletes nothing; deleting the second (HTTP 204) deletes the shared subscription once with `allowMissing=true`; deleting the first (HTTP 204) issues no further provider delete.

## webhooks-google-workspace-events-005

- Vitest: "Google Workspace Events subscription lifecycle > isolates simultaneous subscriptions and dispatch by selected account"
- Mode: run
- Given: A workspace member has a Meet automation on the primary Google Meet account, adds a secondary account, and creates a second Meet automation in another workflow whose thread selects the secondary account via `PUT /api/chat-threads/:id/connector-selections`. Each account has exactly one subscription, and a Runner is online.
- When: Pub/Sub pushes transcript events for the primary subscription and then the secondary subscription to `POST /api/webhooks/google-workspace-events`, and the member then creates a third Meet automation on the primary workflow.
- Then: Each push responds HTTP 200 with `watchStates: 1, dispatched: 1`. The new run from the secondary push has connector secrets sourced from the secondary account. Creating the third automation creates no new subscriptions (one per account), and the two automations use different chat threads.

## webhooks-google-workspace-events-006

- Vitest: "Google Workspace Events subscription lifecycle > does not restore a denied Meet default after deleting the last allowed account"
- Mode: run
- Given: A workspace member has connected the primary Google Meet account, created a Meet automation (primary subscription), and added a secondary account.
- When: The member denies the primary account for the automation thread via `PUT /api/chat-threads/:threadId/connector-access/:connectionId` (`enabled: false`), deletes the secondary account, reads `GET /api/chat-threads/:threadId/connector-access`, Pub/Sub pushes for the primary subscription, and the member disables then re-enables the automation.
- Then: The override responds HTTP 200 with the secondary account as current. After deletion the thread reports `currentConnectionId: null` and `available: false`. The push responds HTTP 200 with `watchStates: 0, dispatched: 0`. Disabling returns HTTP 200 and re-enabling returns HTTP 400.

## webhooks-google-workspace-events-007

- Vitest: "Google Workspace Events subscription lifecycle > reprojects a copied automation to the destination default account"
- Mode: run
- Given: A workspace member's Meet automation thread selects a secondary Google Meet account (with its own subscription), while the primary account remains the default.
- When: The member copies the workflow via `POST /api/workflows/:workflowId/copy` and lists the copy's automations.
- Then: The copy returns HTTP 201 and contains an enabled `google-meet-transcript-generated` event automation, a second subscription is created for the default primary account, and the secondary account's subscription is not deleted.

## webhooks-google-workspace-events-008

- Vitest: "Google Workspace Events subscription lifecycle > dispatches source and copied Google Meet automations independently"
- Mode: run
- Given: A workspace member's source Meet automation uses a secondary Google Meet account subscription, and a copy of its workflow (via `POST /api/workflows/:workflowId/copy`) has an automation subscribed through the default primary account.
- When: Pub/Sub pushes a transcript event for the source subscription and then for the copied subscription to `POST /api/webhooks/google-workspace-events`.
- Then: Each push responds HTTP 200 with `watchStates: 1, dispatched: 1`.

## webhooks-google-workspace-events-009

- Vitest: "Google Workspace Events subscription lifecycle > retains the exact subscription after reconnecting the same account"
- Mode: run
- Given: A workspace member has connected Google Meet and created a Meet automation with one subscription.
- When: The member reconnects the same Google Meet account through OAuth with `intent: "reconnect"`, then Pub/Sub pushes a transcript event for the original subscription.
- Then: The reconnected account keeps the same connection ID and no new subscription is created. The push responds HTTP 200 with `watchStates: 1, dispatched: 1`.

## webhooks-google-workspace-events-010

- Vitest: "Google Workspace Events subscription lifecycle > fails closed and does not retry after provider delete failure"
- Mode: run
- Given: A workspace member has connected Google Meet and created a Meet automation with one subscription. Google Workspace Events fails subscription deletes with HTTP 503.
- When: The member disables the automation (HTTP 200), and a delayed transcript event for the subscription is pushed to `POST /api/webhooks/google-workspace-events`.
- Then: One provider delete was attempted. The push responds HTTP 200 with exactly `{ success: true, watchStates: 0, dispatched: 0, duplicates: 0 }`, no new subscription is created, and no renewal is attempted.

## webhooks-google-workspace-events-011

- Vitest: "Google Workspace Events subscription lifecycle > commits connector deletion before one best-effort provider delete"
- Mode: run
- Given: A workspace member has connected Google Meet (short-lived access tokens) and created a Meet automation with one subscription. The Pub/Sub topic configuration has since changed, and Google's subscription delete stalls and then fails with HTTP 503.
- When: The member deletes the Google Meet account via `DELETE /api/connector-accounts/:connectionId` and lists accounts while the provider delete is still pending.
- Then: While the provider delete is pending, no Google Meet accounts are listed. The deletion responds HTTP 200 with exactly `{ deletedConnectionId: <account>, resolvedSelectionCount: 0, promotedDefaultConnectionId: null }`, exactly one provider delete was sent for the subscription with `allowMissing=true`, and the automation can still be deleted with HTTP 204.

## webhooks-google-workspace-events-012

- Vitest: "Google Workspace Events subscription lifecycle > promotes a sibling account and repairs after deleting and re-adding accounts"
- Mode: run
- Given: A workspace member has a Meet automation subscribed through the primary Google Meet account and has added a secondary account.
- When: The member deletes the primary account, Pub/Sub pushes for the old primary and new secondary subscriptions, the member deletes the secondary account, re-adds the primary Google identity, and Pub/Sub pushes for its new subscription.
- Then: The first delete responds HTTP 200 with `promotedDefaultConnectionId` set to the secondary account and `resolvedSelectionCount: 0`, creating a secondary subscription and deleting the primary one. The old push responds HTTP 200 with `watchStates: 0, dispatched: 0` and the promoted push with `watchStates: 1, dispatched: 1`. The second delete responds with `promotedDefaultConnectionId: null` and deletes the secondary subscription. The re-added account gets a new connection ID and a second primary subscription, whose push responds HTTP 200 with `watchStates: 1, dispatched: 1`.

## webhooks-google-workspace-events-013

- Vitest: "Google Workspace Events subscription lifecycle > keeps a consumer enabled during last-consumer cleanup subscribed"
- Mode: run
- Given: A workspace member has connected Google Meet and has one enabled and one disabled Meet automation. Google's subscription delete stalls until released.
- When: The member disables the enabled automation; while its provider delete is pending, the member enables the other automation; then the delete completes, and later the member disables the second automation.
- Then: The enable and the first disable both respond HTTP 200. Two subscriptions have been created and the first delete targets the first subscription with `allowMissing=true`; the second automation is listed as enabled. Disabling it deletes the second subscription, for two deletes in total.

# webhooks-google-calendar

## webhooks-google-calendar-001

- Vitest: "POST /api/webhooks/google-calendar > rejects notifications with missing required headers"
- Mode: run
- Given: No Google Calendar channel headers are supplied.
- When: An unauthenticated caller posts an empty body to `POST /api/webhooks/google-calendar` with no headers.
- Then: The API responds HTTP 400 with `{ error: "Missing Google Calendar webhook headers" }`.

## webhooks-google-calendar-002

- Vitest: "POST /api/webhooks/google-calendar > rejects numeric channel IDs with a bad request"
- Mode: run
- Given: A caller presents a numeric channel ID `123456` with an untrusted channel token and resource ID.
- When: The caller posts a Calendar notification with those `x-goog-*` headers and resource state `exists` to `POST /api/webhooks/google-calendar`.
- Then: The API responds HTTP 400 with `{ error: "Invalid Google Calendar webhook channel ID" }`.

## webhooks-google-calendar-003

- Vitest: "POST /api/webhooks/google-calendar > rejects oversized channel IDs with a bad request"
- Mode: run
- Given: A caller presents a 1024-character channel ID with an untrusted channel token and resource ID.
- When: The caller posts a Calendar notification with those `x-goog-*` headers and resource state `exists` to `POST /api/webhooks/google-calendar`.
- Then: The API responds HTTP 400 with `{ error: "Invalid Google Calendar webhook channel ID" }`.

## webhooks-google-calendar-004

- Vitest: "POST /api/webhooks/google-calendar > rejects malformed UUID-like channel IDs with a bad request"
- Mode: run
- Given: A caller presents the UUID-like channel ID `11111111-1111-4111-8111-11111111111g` (invalid final character) with an untrusted channel token and resource ID.
- When: The caller posts a Calendar notification with those `x-goog-*` headers and resource state `exists` to `POST /api/webhooks/google-calendar`.
- Then: The API responds HTTP 400 with `{ error: "Invalid Google Calendar webhook channel ID" }`.

## webhooks-google-calendar-005

- Vitest: "POST /api/webhooks/google-calendar > short-circuits before Calendar event reads when no consumer remains"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-created` automation, which registers a watch channel on the primary calendar after one baseline event read. Google's channel stop endpoint fails with HTTP 500, and the member disables the automation via `POST /api/workflow-automations/:id/disable` (HTTP 200).
- When: Google posts a notification for the original channel (matching channel ID, token and resource ID) to `POST /api/webhooks/google-calendar`.
- Then: The webhook responds HTTP 401. Calendar events were read only for the baseline and never incrementally. Once channel stop succeeds, deleting the automation returns HTTP 204.

## webhooks-google-calendar-006

- Vitest: "POST /api/webhooks/google-calendar > acknowledges events without dispatching after Calendar access becomes unavailable"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-created` automation with a registered watch channel. Two hours later the access token has expired and Google's token endpoint rejects refresh with HTTP 400 `invalid_grant`.
- When: Google posts two valid notifications for the channel with message numbers 2 and 3 to `POST /api/webhooks/google-calendar`.
- Then: Each responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`, and the token refresh is attempted once. The default Calendar account reads as `reconnect-required` with reason `authorization_expired_or_revoked`. Disabling the automation returns HTTP 200, and after reconnecting Calendar, deleting it returns HTTP 204.

## webhooks-google-calendar-007

- Vitest: "POST /api/webhooks/google-calendar > with a watched Calendar workflow > dispatches newly created calendar events and de-duplicates retries"
- Mode: run
- Given: A workspace member with a workflow and a supported model has connected Google Calendar and created a `google-calendar-event-created` automation with a registered watch. Google's incremental sync returns a newly created confirmed event `Planning`.
- When: Google posts a valid notification for the channel to `POST /api/webhooks/google-calendar`, and then posts the same notification again.
- Then: The first responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`; the thread shows `Google Calendar event "Planning" was created.`, the thread has no connector selections, and one run is dispatched to the Runner. The redelivery responds HTTP 200 with `dispatched: 0, duplicates: 0` and still only one run was dispatched.

## webhooks-google-calendar-008

- Vitest: "POST /api/webhooks/google-calendar > after switching Calendar accounts > does not restore a denied Calendar default after deleting the last allowed account"
- Mode: run
- Given: A workspace member with a workflow has two Google Calendar accounts, created a `google-calendar-event-created` automation, and selected the second account for its thread, so both accounts have watch channels. Google's channel stop fails with HTTP 500.
- When: The member denies the first account for the thread via `PUT /api/chat-threads/:threadId/connector-access/:connectionId` (`enabled: false`), deletes the second account, reads `GET /api/chat-threads/:threadId/connector-access`, Google posts notifications for both channels, and the member disables then re-enables the automation.
- Then: The thread reports `currentConnectionId: null` and `available: false`. Both webhook notifications respond HTTP 401. Disabling returns HTTP 200 and re-enabling returns HTTP 400.

## webhooks-google-calendar-009

- Vitest: "POST /api/webhooks/google-calendar > after switching Calendar accounts > rejects the retired source and dispatches from the selected account even when remote stop fails"
- Mode: run
- Given: A workspace member with a workflow and a supported model has two Google Calendar accounts, created a `google-calendar-event-created` automation, and selected the second account for its thread via `PUT /api/chat-threads/:id/connector-selections`. Google's channel stop fails with HTTP 500, and the second account's incremental sync returns a new confirmed event.
- When: Google posts a notification for the first account's channel, then one for the second account's channel, to `POST /api/webhooks/google-calendar`.
- Then: The old channel responds HTTP 401 with `{ error: "Unauthorized" }` and no run is dispatched. The selected channel responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`, and the dispatched run's connector secrets come from the second account.

## webhooks-google-calendar-010

- Vitest: "POST /api/webhooks/google-calendar > recovers when account selection changes during old-source event retrieval"
- Mode: run
- Given: A workspace member with a workflow and a supported model has two Google Calendar accounts and created a `google-calendar-event-created` automation watched by the first account. Google's channel stop fails with HTTP 500. While Google returns the first account's incremental events, the member switches the thread selection to the second account (HTTP 200).
- When: Google posts a notification for the first account's channel to `POST /api/webhooks/google-calendar`, and after it finishes posts it again.
- Then: A watch channel now exists for the second account. The repeated old-channel notification responds HTTP 401 with `{ error: "Unauthorized" }`, and no run is dispatched. The first response is not asserted.

## webhooks-google-calendar-011

- Vitest: "POST /api/webhooks/google-calendar > reconciles Calendar watches across default deletion and first-account re-add"
- Mode: run
- Given: A workspace member with a workflow has two Google Calendar accounts and created a `google-calendar-event-created` automation, watched by the first account.
- When: The member makes the second account default, deletes it, deletes the first account, and then connects a third Calendar account; Google then posts a notification for the original first channel to `POST /api/webhooks/google-calendar`.
- Then: After deleting the default, only the first account remains, as default. Watch channels and baseline syncs happened with the first, second, first and third account tokens in order, and channels were stopped with the first, second and first tokens. The original channel's notification responds HTTP 401.

## webhooks-google-calendar-012

- Vitest: "POST /api/webhooks/google-calendar > switches Calendar principal accounts and stops the captured old channel"
- Mode: run
- Given: A workspace member with a workflow has connected one Google Calendar account and created a `google-calendar-event-created` automation with one watch channel.
- When: The member reconnects the same Google principal under a renamed email with a refreshed token, then connects a different replacement principal and deletes the original account; Google then posts a notification for the original channel to `POST /api/webhooks/google-calendar`.
- Then: The reconnect keeps one channel and stops nothing. The replacement becomes the default account. Watches exist for the original and replacement tokens only, the old channel was stopped once using the refreshed token, and the original channel's notification responds HTTP 401.

## webhooks-google-calendar-013

- Vitest: "POST /api/webhooks/google-calendar > finishes captured Calendar channel cleanup after request cancellation"
- Mode: run
- Given: A workspace member with a workflow has one Google Calendar account and created two automations: `google-calendar-event-created` on the primary calendar and `google-calendar-event-updated` on `team-calendar@example.com`, giving two watch channels. The client cancels the request as soon as Google receives the first channel stop.
- When: The member deletes the Calendar account via `DELETE /api/connector-accounts/:connectionId`.
- Then: The delete request fails with HTTP 500, yet both watch channels are stopped at Google and the member has no Calendar accounts left.

## webhooks-google-calendar-014

- Vitest: "POST /api/webhooks/google-calendar > repairs denied bindings and only retires unconsumed Calendar watches during renewal"
- Mode: run
- Given: A workspace member has two Google Calendar accounts (first default) and three workflows with `google-calendar-event-created` automations: the original on `primary`, a shared one on `primary` and `team-calendar@example.com`, and a blocked one on `blocked-calendar@example.com`. The original thread denies the second account and the blocked thread denies both. A run is active, and the member's `POST /api/connector-accounts/:connectionId/default` to the second account is cancelled during its post-commit notification.
- When: After the run completes, the renewal cron `GET /api/cron/renew-google-calendar-watches` runs with the cron secret, and Google posts notifications for the first account's `primary` and team-calendar channels and the second account's team-calendar channel.
- Then: The default change responds HTTP 500 but the second account is default. Renewal responds HTTP 200 with `success: true, failed: 0`, stops exactly one channel with the first token, and the second account watches `primary` and the team calendar. The first `primary` channel responds HTTP 200 with a first-token read, the first team-calendar channel HTTP 401, and the second team-calendar channel HTTP 200 with a second-token read. The original thread's selection is the first account.

## webhooks-google-calendar-015

- Vitest: "POST /api/webhooks/google-calendar > moves expired Calendar watches with staff default"
- Mode: run
- Given: A member of the staff organization `org_3ANttyrbWYJk6JKRSTRLEsbsDLe` (member account access on by default) has two Google Calendar accounts, created a `google-calendar-event-created` automation, and selected the first account for its thread. One hour earlier the member set the first account's policy to `allow-1h`.
- When: The renewal cron `GET /api/cron/renew-google-calendar-watches` runs one millisecond before expiry and again at expiry, then Google posts a notification for the first account's channel.
- Then: The early run responds HTTP 200 and keeps a single channel. The run at expiry responds HTTP 200 with `failed: 0`, registers a second watch with the second account's token on `primary`, and stops the first channel. The first channel's notification responds HTTP 401, and the thread's selection still names the first account.

## webhooks-google-calendar-016

- Vitest: "POST /api/webhooks/google-calendar > moves expired Calendar watches with member override"
- Mode: run
- Given: A workspace member with the member connector account access feature enabled for them has two Google Calendar accounts, created a `google-calendar-event-created` automation, and selected the first account for its thread. One hour earlier the member set the first account's policy to `allow-1h`.
- When: The renewal cron `GET /api/cron/renew-google-calendar-watches` runs one millisecond before expiry and again at expiry, then Google posts a notification for the first account's channel.
- Then: The early run responds HTTP 200 and keeps a single channel. The run at expiry responds HTTP 200 with `failed: 0`, registers a second watch with the second account's token on `primary`, and stops the first channel. The first channel's notification responds HTTP 401, and the thread's selection still names the first account.

## webhooks-google-calendar-017

- Vitest: "POST /api/webhooks/google-calendar > ignores updated and cancelled calendar events"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-created` automation. The baseline contains event `Existing`; incremental sync returns that event updated with a new etag and a separate cancelled event.
- When: Google posts a valid notification for the channel to `POST /api/webhooks/google-calendar`.
- Then: The webhook responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`, and no run is dispatched.

## webhooks-google-calendar-018

- Vitest: "POST /api/webhooks/google-calendar > dispatches updated calendar events once per event revision"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-updated` automation. The baseline contains event `Existing` (etag 1). Successive incremental syncs return it as `Existing updated` with etag 2, again with etag 2, and then as `Existing updated again` with etag 3.
- When: Google posts three valid notifications for the channel to `POST /api/webhooks/google-calendar`; the first run is completed through the sandbox before the third.
- Then: The first responds HTTP 200 with `dispatched: 1` and the thread shows `Google Calendar event "Existing updated" was updated.`. The second responds HTTP 200 with `dispatched: 0, duplicates: 0` and only one run is dispatched. The third responds HTTP 200 with `dispatched: 1` and dispatches a second, different run (two in total).

## webhooks-google-calendar-019

- Vitest: "POST /api/webhooks/google-calendar > dispatches cancelled calendar events and de-duplicates minimal deleted payloads"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created both a `google-calendar-event-cancelled` and a `google-calendar-event-updated` automation. The baseline contains event `Existing`; two successive incremental syncs return a minimal cancelled payload for it.
- When: Google posts two valid notifications for the channel to `POST /api/webhooks/google-calendar`.
- Then: The first responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`, the cancelled automation's thread shows `A Google Calendar event was cancelled.`, and exactly one run is dispatched. The second responds HTTP 200 with `dispatched: 0, duplicates: 0` and still only one run exists.

## webhooks-google-calendar-020

- Vitest: "POST /api/webhooks/google-calendar > rejects webhook notifications with an unknown channel ID"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-created` automation with a registered watch channel.
- When: A notification is posted to `POST /api/webhooks/google-calendar` with the channel's token and resource ID but an unknown `x-goog-channel-id` of `11111111-1111-4111-8111-111111111111`.
- Then: The webhook responds HTTP 401 with `{ error: "Unauthorized" }`.

## webhooks-google-calendar-021

- Vitest: "POST /api/webhooks/google-calendar > rejects webhook notifications with the wrong channel token"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-created` automation with a registered watch channel.
- When: A notification is posted to `POST /api/webhooks/google-calendar` with the channel's ID and resource ID but `x-goog-channel-token: wrong-token`.
- Then: The webhook responds HTTP 401 with `{ error: "Unauthorized" }`.

## webhooks-google-calendar-022

- Vitest: "POST /api/webhooks/google-calendar > rejects webhook notifications with the wrong resource ID"
- Mode: run
- Given: A workspace member with a workflow has connected Google Calendar and created a `google-calendar-event-created` automation with a registered watch channel.
- When: A notification is posted to `POST /api/webhooks/google-calendar` with the channel's ID and token but `x-goog-resource-id: wrong-resource`.
- Then: The webhook responds HTTP 401 with `{ error: "Unauthorized" }`.

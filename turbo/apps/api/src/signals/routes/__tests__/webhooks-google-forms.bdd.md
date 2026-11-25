# webhooks-google-forms

## webhooks-google-forms-001

- Vitest: "Google Forms Pub/Sub webhook > rejects re-enable preparation that outlives the owner's membership: later timestamp"
- Mode: run
- Given: A workspace member owns a disabled Google Forms `response_submitted` automation for a form, and a workspace admin exists. When the member re-enables it, Google Forms' baseline response read is slow; during it the clock moves 1 second later, the admin removes the member via `DELETE /api/org/members` (the automation then reads as disabled), and the clock moves to 2 seconds. Forms later reports a new response.
- When: The member calls `POST /api/workflow-automations/:id/enable`, and 11 seconds after preparation Pub/Sub pushes a signed notification for the prepared watch to `POST /api/webhooks/google-forms`.
- Then: The enable responds HTTP 409, the automation stays disabled, and the push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`.

## webhooks-google-forms-002

- Vitest: "Google Forms Pub/Sub webhook > rejects re-enable preparation that outlives the owner's membership: same timestamp"
- Mode: run
- Given: A workspace member owns a disabled Google Forms `response_submitted` automation for a form, and a workspace admin exists. When the member re-enables it, Google Forms' baseline response read is slow; during it, at the same timestamp as preparation, the admin removes the member via `DELETE /api/org/members` (the automation then reads as disabled). Forms later reports a new response.
- When: The member calls `POST /api/workflow-automations/:id/enable`, and 11 seconds after preparation Pub/Sub pushes a signed notification for the prepared watch to `POST /api/webhooks/google-forms`.
- Then: The enable responds HTTP 409, the automation stays disabled, and the push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`.

## webhooks-google-forms-003

- Vitest: "Google Forms Pub/Sub webhook > rejects re-enable preparation that outlives the owner's membership: rejoin at the same timestamp"
- Mode: run
- Given: A workspace member with a CLI token owns a disabled Google Forms `response_submitted` automation, and a workspace admin exists. When the member re-enables it, Google Forms' baseline response read is slow; during it, at the same timestamp, the admin removes the member via `DELETE /api/org/members`, then Clerk grants the member a rejoin and the member's CLI token reads `GET /api/workflow-automations/:id` (HTTP 200, `enabled: false`). Forms later reports a new response.
- When: The member's original enable request `POST /api/workflow-automations/:id/enable` finishes, and 11 seconds after preparation Pub/Sub pushes a signed notification for the prepared watch to `POST /api/webhooks/google-forms`.
- Then: The enable responds HTTP 409, the automation stays disabled, and the push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`.

## webhooks-google-forms-004

- Vitest: "Google Forms Pub/Sub webhook > rejects re-enable preparation that outlives the owner's membership: signed repeated Clerk departure at the same timestamp"
- Mode: run
- Given: A workspace member owns a disabled Google Forms `response_submitted` automation, and a workspace admin exists. When the member re-enables it, Google Forms' baseline response read is slow; during it, at the same timestamp, Clerk drops the member and delivers the same signed `organizationMembership.deleted` event twice to `POST /api/webhooks/clerk` (each HTTP 200), after which the automation reads as disabled. Forms later reports a new response.
- When: The member's enable request `POST /api/workflow-automations/:id/enable` finishes, and 11 seconds after preparation Pub/Sub pushes a signed notification for the prepared watch to `POST /api/webhooks/google-forms`.
- Then: The enable responds HTTP 409, the automation stays disabled, and the push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`.

## webhooks-google-forms-005

- Vitest: "Google Forms Pub/Sub webhook > starts a fresh custom Forms delivery interval after departure and rejoin"
- Mode: run
- Given: A workspace member with a CLI token owns an enabled Google Forms automation (disabled and re-enabled, HTTP 200). A workspace admin removes the member via `DELETE /api/org/members`, which disables the automation with its event config unchanged; the member then rejoins and reads it with the CLI token as disabled. Forms' baseline holds a response submitted while the member was away (T+1s) and then a new response from `fresh@example.test` (T+2s).
- When: At T+1s the member enables the automation with the CLI token, and at T+3s Pub/Sub pushes a signed notification for the new watch to `POST /api/webhooks/google-forms`.
- Then: The enable responds HTTP 200 with `enabled: true` and the original event config. Forms is queried with `timestamp > <T+1s>`. The push responds HTTP 200 with `dispatched: 1`, and the thread's only automation input reads `A new response from fresh@example.test was submitted to Google Form "Customer survey".`.

## webhooks-google-forms-006

- Vitest: "Google Forms Pub/Sub webhook > keeps pending responses when an already enabled automation refreshes its watch binding"
- Mode: run
- Given: A workspace member owns an enabled Google Forms automation with a watch and a baseline cursor at `2026-08-05T09:30:00.123456Z`. Forms has a pending response from `pending@example.test` after that cursor.
- When: The member calls `POST /api/workflow-automations/:id/enable` on the already enabled automation (HTTP 200), then Pub/Sub pushes a signed notification for the original watch to `POST /api/webhooks/google-forms`.
- Then: Forms is queried with `timestamp > 2026-08-05T09:30:00.123456Z`. The push responds HTTP 200 with `watchStates: 1, dispatched: 1`, and the thread's only automation input reads `A new response from pending@example.test was submitted to Google Form "Customer survey".`.

## webhooks-google-forms-007

- Vitest: "Google Forms Pub/Sub webhook > does not replay disabled-period responses after explicit disable and re-enable"
- Mode: run
- Given: A workspace member owns an enabled Google Forms automation with a watch. The member disables it via `POST /api/workflow-automations/:id/disable`, which stops the watch at Google. While disabled, a response arrives at `2026-08-05T10:15:00.123456Z`; after resuming, a response from `after-resume@example.test` arrives.
- When: The member re-enables the automation (HTTP 200), and Pub/Sub pushes a signed notification for the new watch to `POST /api/webhooks/google-forms`.
- Then: A new watch ID is created. The push responds HTTP 200 with `watchStates: 1, dispatched: 1`, and Forms is queried exactly once with `timestamp > 2026-08-05T10:15:00.123456Z`. The automation's thread has exactly one automation input: `A new response from after-resume@example.test was submitted to Google Form "Customer survey".`.

## webhooks-google-forms-008

- Vitest: "Google Forms Pub/Sub webhook > does not replay disabled-period responses after chat thread deletion and re-enable"
- Mode: run
- Given: A workspace member owns an enabled Google Forms automation with a watch. The member deletes the automation's chat thread, which stops the watch at Google. While stopped, a response arrives at `2026-08-05T10:15:00.123456Z`; after resuming, a response from `after-resume@example.test` arrives.
- When: The member re-enables the automation via `POST /api/workflow-automations/:id/enable` (HTTP 200), and Pub/Sub pushes a signed notification for the new watch to `POST /api/webhooks/google-forms`.
- Then: A new watch ID is created. The push responds HTTP 200 with `watchStates: 1, dispatched: 1`, and Forms is queried exactly once with `timestamp > 2026-08-05T10:15:00.123456Z`. The automation's current thread has exactly one automation input: `A new response from after-resume@example.test was submitted to Google Form "Customer survey".`.

## webhooks-google-forms-009

- Vitest: "Google Forms Pub/Sub webhook > does not enqueue a response after the automation is disabled during retrieval"
- Mode: run
- Given: A workspace member owns an enabled Google Forms automation with a watch. While Forms returns a new response, the member disables the automation (HTTP 200).
- When: Pub/Sub pushes a signed notification for the watch to `POST /api/webhooks/google-forms`.
- Then: The push responds HTTP 200 with `dispatched: 0`, the thread has no automation inputs, and the watch is stopped at Google.

## webhooks-google-forms-010

- Vitest: "Google Forms Pub/Sub webhook > delivers metadata without response data and de-duplicates a retry"
- Mode: run
- Given: A workspace member with a supported model owns a Google Forms automation for form `Customer survey`, whose baseline cursor is the newest seed response at `2026-08-05T09:30:00.123456Z`. Forms returns a new response `response-1` from `respondent@example.test`.
- When: Pub/Sub pushes a signed notification for the watch to `POST /api/webhooks/google-forms`, then retries the same message.
- Then: The first push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`; Forms was queried with `timestamp > 2026-08-05T09:30:00.123456Z` and fields `responses(responseId,createTime,lastSubmittedTime,respondentEmail),nextPageToken`. The thread shows `A new response from respondent@example.test was submitted to Google Form "Customer survey".`, and the run's event data is exactly automation ID, form ID, title, URL, `response-1`, `changeType: "created"`, create/submit times, respondent email and `previouslyDelivered: false`, with `# Identity` in the system prompt. The retry responds with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 1 }` and the thread keeps one automation input.

## webhooks-google-forms-011

- Vitest: "Google Forms Pub/Sub webhook > keeps a successful refresh after a concurrent firewall provider outage"
- Mode: run
- Given: A workspace member's Google Forms automation has already dispatched a running workflow. Two hours later the Forms access token has expired; Google's token endpoint grants the first refresh (`forms-refresh-success`) only after a concurrent forced refresh from the run's firewall hits an outage (HTTP 503).
- When: Pub/Sub re-pushes for the watch to `POST /api/webhooks/google-forms`, during which the run calls `POST /api/webhooks/run/firewall/auth` with `forceRefresh`; afterwards the run calls the firewall auth again without forcing.
- Then: The concurrent firewall call responds HTTP 502 with `failureReason: "upstream_provider"`. The push responds HTTP 200 with `duplicates: 1`, and Forms received `Bearer forms-refresh-success`. The later firewall call responds HTTP 200 with `Authorization: Bearer forms-refresh-success`, and the account stays `connected`.

## webhooks-google-forms-012

- Vitest: "Google Forms Pub/Sub webhook > keeps a successful refresh after a concurrent Forms provider outage"
- Mode: run
- Given: A workspace member's Google Forms automation has already dispatched a running workflow. Two hours later the Forms access token has expired; Google's token endpoint grants the first refresh (`forms-refresh-success`) only after a concurrent refresh from a Forms webhook hits an outage (HTTP 503).
- When: The run calls `POST /api/webhooks/run/firewall/auth` with `forceRefresh`, during which Pub/Sub pushes for the watch to `POST /api/webhooks/google-forms`; then Pub/Sub pushes again and the run calls firewall auth without forcing.
- Then: The concurrent push responds HTTP 200 with `dispatched: 0` and the account stays `connected`. The forced firewall call responds HTTP 200 with `Authorization: Bearer forms-refresh-success`. The later push responds HTTP 200 with `duplicates: 1` and Forms received the new token. The final firewall call returns the same header and the account is `connected`.

## webhooks-google-forms-013

- Vitest: "Google Forms Pub/Sub webhook > acknowledges events without dispatching after Forms access becomes unavailable"
- Mode: run
- Given: A workspace member owns a Google Forms automation with a watch. Two hours later the access token has expired and Google's token endpoint rejects refresh with HTTP 400 `invalid_grant`.
- When: Pub/Sub delivers two signed pushes with different message IDs for the watch to `POST /api/webhooks/google-forms`.
- Then: Each responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`, and the refresh is attempted once. The default Forms account reads as `reconnect-required` with reason `authorization_expired_or_revoked`. After reconnecting Forms, deleting the automation returns HTTP 204.

## webhooks-google-forms-014

- Vitest: "Google Forms Pub/Sub webhook > routes a shared-form notification by watch id without fanout"
- Mode: run
- Given: Two members of the same workspace each connected Google Forms and created a `response_submitted` automation for the same form, giving two watches.
- When: Pub/Sub pushes a signed notification carrying the first member's watch ID to `POST /api/webhooks/google-forms`.
- Then: The push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`. The first member's thread has a prompt with a run, and the second member's thread has no prompt.

## webhooks-google-forms-015

- Vitest: "Google Forms Pub/Sub webhook > rejects the previous account watch after a switch"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form, both first bound to the first (default) account. The member selected the second account for the second automation's thread, so that automation uses the second account and there are two watches.
- When: Pub/Sub pushes a signed notification for the first account's watch to `POST /api/webhooks/google-forms`.
- Then: The push responds HTTP 200 with `watchStates: 1, dispatched: 1`. The first automation's thread has one prompt and the switched second thread has none.

## webhooks-google-forms-016

- Vitest: "Google Forms Pub/Sub webhook > rebinds Forms to an allowed surviving account after deleting the selected account"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form; the second automation's thread uses the second account and denies the first account via `PUT /api/chat-threads/:threadId/connector-access/:connectionId`. The member adds a third account and makes it current for that thread via `PUT /api/chat-threads/:threadId/connector-current`.
- When: The member deletes the third account, reads `GET /api/chat-threads/:threadId/connector-access` and the automation, and Pub/Sub pushes for the latest watch to `POST /api/webhooks/google-forms`.
- Then: The thread's current account is the second account and the automation's `connectorId` is the second account. The push responds HTTP 200 with `watchStates: 1, dispatched: 1`, and the second thread has one prompt.

## webhooks-google-forms-017

- Vitest: "Google Forms Pub/Sub webhook > does not restore a denied Forms default after deletion or change another Chat's listener"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form; the second automation's thread uses the second account and denies the first account.
- When: The member deletes the second account, reads both threads' connector access, Pub/Sub pushes for the first account's watch to `POST /api/webhooks/google-forms`, and the member disables then re-enables the second automation.
- Then: The second thread reports `currentConnectionId: null` and `available: false`, while the first thread's current account is still the first account. The push responds HTTP 200 with `watchStates: 1, dispatched: 1`, and the second thread has no prompt. Disabling returns HTTP 200 and re-enabling returns HTTP 400.

## webhooks-google-forms-018

- Vitest: "Google Forms Pub/Sub webhook > keeps the current selected account usable after a provider failure"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form; the second automation already uses the second account. When the member selects the second account for the first thread, Google Forms' baseline read for the new binding fails with HTTP 503, and a push for the first account's watch during that preparation responds HTTP 200 with `dispatched: 0`.
- When: The member repeats the same selection via `PUT /api/chat-threads/:id/connector-selections`, reads the first automation, and Pub/Sub pushes for the second account's watch to `POST /api/webhooks/google-forms`.
- Then: Both selections respond HTTP 200. The first automation is enabled with the second account as `connectorId`. The push responds HTTP 200 with `dispatched: 2`, and the first thread's only automation input reads `A new response from selected-account@example.test was submitted to Google Form "Customer survey".`.

## webhooks-google-forms-019

- Vitest: "Google Forms Pub/Sub webhook > routes the selected account with exact credentials"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form; the second automation's thread is switched to the second account.
- When: Pub/Sub pushes a signed notification for the second account's watch to `POST /api/webhooks/google-forms`.
- Then: The push responds HTTP 200 with `watchStates: 1, dispatched: 1`, and Google Forms has received requests with both the first and the second account's access tokens. The first thread has no prompt, the second thread has one, and its run's connector secrets come from the second account.

## webhooks-google-forms-020

- Vitest: "Google Forms Pub/Sub webhook > rebinds watches after switching the Chat account and changing the default account"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form; the second automation's thread is switched to the second account.
- When: The member disables the second account for the second thread via a thread connector-access override, then makes the second account the default via `POST /api/connector-accounts/:connectionId/default`.
- Then: After the override the second automation uses the first account and only the second account's watch is stopped. After the default change (HTTP 200) the first automation uses the second account and the second automation uses the first account; three watches exist in total and still only the original second watch has been stopped.

## webhooks-google-forms-021

- Vitest: "Google Forms Pub/Sub webhook > preserves watches when reconnecting the same Google Forms account"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form, with two watches.
- When: The member reconnects the second account through OAuth for the same Google identity under the renamed email `renamed-google-forms-second@example.test`.
- Then: The account list shows the second account's ID with the renamed email, and no new watch is created (still two).

## webhooks-google-forms-022

- Vitest: "Google Forms Pub/Sub webhook > watch recovery across Google Forms account replacement > repairs watches after Google Forms account deletion, replacement, and re-add"
- Mode: run
- Given: A workspace member has two Google Forms accounts and two automations on the same form; the second automation's thread is switched to the second account, giving two watches.
- When: The member deletes the second account, adds a replacement, deletes the first account, deletes the replacement, and re-adds a new account, with Pub/Sub pushes to `POST /api/webhooks/google-forms` for the retired first and replacement watches and finally for the re-added account's watch.
- Then: The deletes return `{ deletedConnectionId, resolvedSelectionCount: 1 }` with promoted defaults null, the replacement, and null; watches are stopped in order second, first, replacement, and pushes for retired watches respond HTTP 200 with `watchStates: 0, dispatched: 0`. The re-added account is default with a fourth watch, both automations bind to it, and its push responds HTTP 200 with `watchStates: 1, dispatched: 2, duplicates: 0` using its token. Both threads get runs whose connector secrets come from the re-added account.

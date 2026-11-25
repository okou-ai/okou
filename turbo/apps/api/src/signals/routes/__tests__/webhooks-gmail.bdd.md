# webhooks-gmail

## webhooks-gmail-001

- Vitest: "POST /api/webhooks/gmail > skips a listener event when member access expires before queue admission"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected a Gmail account, and the member connector account access feature is enabled. One hour earlier the admin set the account policy to `allow-1h` via `PUT /api/connector-account-access/:connectionId/policy`, and created a `gmail-new-message` automation. Gmail returns one new inbox message, and the access window expires while the message is being read.
- When: One millisecond before expiry, Google Pub/Sub delivers a validly signed push for the account at history ID 101 to `POST /api/webhooks/gmail`.
- Then: The webhook responds HTTP 200 with `dispatched: 0` after reading the message, and `GET /api/workflow-automations/:id` shows `lastRunAt: null`.

## webhooks-gmail-002

- Vitest: "POST /api/webhooks/gmail > invalidates Gmail label ids when the selected account is replaced"
- Mode: run
- Given: A workspace admin with a workflow has connected a Gmail account whose labels include `Support` with ID `Label_old_account`. The admin created a `gmail-label-applied` automation for label name `Support`, which responds HTTP 201 with `resolvedLabelId: "Label_old_account"`.
- When: The admin connects a second Gmail account and deletes the initial account, then reads `GET /api/workflow-automations/:id`.
- Then: The automation's event config no longer has a `resolvedLabelId`.

## webhooks-gmail-003

- Vitest: "POST /api/webhooks/gmail > rejects an in-flight Gmail event after the selected account is removed"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail account A and created a `gmail-label-applied` automation for label `Support` (resolved to `Label_old_account`). Gmail history reports label `Label_new_account` applied to a message, and the next label lookup stalls until released.
- When: Pub/Sub delivers a signed push for account A at history ID 102 to `POST /api/webhooks/gmail`; while the label lookup is pending, the admin connects account B and deletes account A, then the lookup returns `Support` as `Label_new_account`.
- Then: The webhook responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`. The automation's event config has no `resolvedLabelId`, and the automation thread has no automation runs.

## webhooks-gmail-004

- Vitest: "POST /api/webhooks/gmail > keeps same-account watch state and drops it when the account switches"
- Mode: run
- Given: A workspace admin with a workflow has connected a Gmail account and created a `gmail-new-message` automation, which registers one Gmail watch. Gmail history returns no changes.
- When: The admin reconnects the same Gmail identity under a renamed email, Pub/Sub pushes for the renamed address to `POST /api/webhooks/gmail`; then the admin connects a different Gmail identity, deletes the original account, and Pub/Sub pushes again for the renamed address.
- Then: The reconnect keeps the same connection ID with the new email and does not register another watch. The first push responds HTTP 200 with `watchStates: 1`; after the account switch the push responds HTTP 200 with `watchStates: 0`. Deleting the automation afterwards returns HTTP 204.

## webhooks-gmail-005

- Vitest: "POST /api/webhooks/gmail > short-circuits before Gmail history reads when no consumer remains"
- Mode: run
- Given: A workspace admin with a workflow has connected Gmail and created a `gmail-new-message` automation. Gmail's watch stop endpoint fails with HTTP 500. Two hours later (when the access token would need a refresh) the admin disables the automation via `POST /api/workflow-automations/:id/disable` (HTTP 200) without any token refresh, and the clock returns to the connection time.
- When: Pub/Sub delivers a signed push for the account at history ID 101 to `POST /api/webhooks/gmail`.
- Then: The webhook responds HTTP 200 with exactly `{ success: true, watchStates: 0, dispatched: 0, duplicates: 0 }`. Gmail history is never read and Google's token endpoint is never called. Once Gmail's stop endpoint succeeds, deleting the automation returns HTTP 204.

## webhooks-gmail-006

- Vitest: "POST /api/webhooks/gmail > acknowledges events without dispatching after Gmail access becomes unavailable"
- Mode: run
- Given: A workspace admin with a workflow has connected Gmail and created a `gmail-new-message` automation. Two hours later the access token has expired and Google's token endpoint rejects refresh with HTTP 400 `invalid_grant`.
- When: Pub/Sub delivers two signed pushes with different message IDs for the account at history ID 101 to `POST /api/webhooks/gmail`.
- Then: Each push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`, and the token refresh is attempted only once. The Gmail account is listed as `reconnect-required` with reason `authorization_expired_or_revoked`. Disabling the automation returns HTTP 200, and after reconnecting Gmail, deleting it returns HTTP 204.

## webhooks-gmail-007

- Vitest: "POST /api/webhooks/gmail > keeps another Gmail identity consuming when one identity disables"
- Mode: run
- Given: Admins of two separate workspaces each connected the same Gmail mailbox and created a `gmail-new-message` automation, registering two watches with history IDs 100 and 200. Gmail history returns no changes with history ID 201.
- When: Pub/Sub pushes for the mailbox at history 201 to `POST /api/webhooks/gmail`; the first admin disables their automation and Pub/Sub pushes at 202; the first admin re-enables the automation (a third watch returns history 300) and Pub/Sub pushes at 301.
- Then: The first push responds HTTP 200 with exactly `{ success: true, watchStates: 2, dispatched: 0, duplicates: 0 }` and reads history from cursors 100 and 200. After disabling, the push reports `watchStates: 1`, `dispatched: 0` and reads only from cursor 201. After re-enabling, the push reports `watchStates: 2`, `dispatched: 0` and reads from cursors 202 and 300.

## webhooks-gmail-008

- Vitest: "POST /api/webhooks/gmail > retries history pagination after transport failure without losing or duplicating events"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail and created a `gmail-new-message` automation (watch history ID 100). Gmail history returns a first page with a new inbox message and a next page token, but the next page fails with a network transport error until it becomes available.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`; the same notification is retried after the history page becomes available, and delivered once more.
- Then: The first attempt responds HTTP 503 with error `Gmail history is temporarily unavailable; retry this notification` and the automation's `lastRunAt` stays null. The retry responds HTTP 200 with `dispatched: 1, duplicates: 0` and the thread has one automation run. The third delivery responds HTTP 200 with `dispatched: 0, duplicates: 1` and the thread still has one run.

## webhooks-gmail-009

- Vitest: "POST /api/webhooks/gmail > retries history pagination after rate limiting without losing or duplicating events"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail and created a `gmail-new-message` automation (watch history ID 100). Gmail history returns a first page with a new inbox message and a next page token, but the next page returns HTTP 429 until it becomes available.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`; the same notification is retried after the history page becomes available, and delivered once more.
- Then: The first attempt responds HTTP 503 with error `Gmail history is temporarily unavailable; retry this notification` and the automation's `lastRunAt` stays null. The retry responds HTTP 200 with `dispatched: 1, duplicates: 0` and the thread has one automation run. The third delivery responds HTTP 200 with `dispatched: 0, duplicates: 1` and the thread still has one run.

## webhooks-gmail-010

- Vitest: "POST /api/webhooks/gmail > retries history pagination after server failure without losing or duplicating events"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail and created a `gmail-new-message` automation (watch history ID 100). Gmail history returns a first page with a new inbox message and a next page token, but the next page returns HTTP 503 until it becomes available.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`; the same notification is retried after the history page becomes available, and delivered once more.
- Then: The first attempt responds HTTP 503 with error `Gmail history is temporarily unavailable; retry this notification` and the automation's `lastRunAt` stays null. The retry responds HTTP 200 with `dispatched: 1, duplicates: 0` and the thread has one automation run. The third delivery responds HTTP 200 with `dispatched: 0, duplicates: 1` and the thread still has one run.

## webhooks-gmail-011

- Vitest: "POST /api/webhooks/gmail > retries history pagination after Gmail's HTTP 403 user rate limit without losing or duplicating events"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail and created a `gmail-new-message` automation (watch history ID 100). Gmail history returns a first page with a new inbox message and a next page token, but the next page returns HTTP 403 with reason `userRateLimitExceeded` until it becomes available.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`; the same notification is retried after the history page becomes available, and delivered once more.
- Then: The first attempt responds HTTP 503 with error `Gmail history is temporarily unavailable; retry this notification` and the automation's `lastRunAt` stays null. The retry responds HTTP 200 with `dispatched: 1, duplicates: 0` and the thread has one automation run. The third delivery responds HTTP 200 with `dispatched: 0, duplicates: 1` and the thread still has one run.

## webhooks-gmail-012

- Vitest: "POST /api/webhooks/gmail > acknowledges permanent Gmail HTTP 401 authorization failures"
- Mode: run
- Given: A workspace admin with a workflow has connected Gmail and created a `gmail-new-message` automation. Gmail history reads fail with HTTP 401 and reason `authError`.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`.
- Then: The webhook responds HTTP 200 with `dispatched: 0, duplicates: 0`, and the automation's `lastRunAt` is null.

## webhooks-gmail-013

- Vitest: "POST /api/webhooks/gmail > acknowledges permanent Gmail HTTP 403 authorization failures"
- Mode: run
- Given: A workspace admin with a workflow has connected Gmail and created a `gmail-new-message` automation. Gmail history reads fail with HTTP 403 and reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`.
- Then: The webhook responds HTTP 200 with `dispatched: 0, duplicates: 0`, and the automation's `lastRunAt` is null.

## webhooks-gmail-014

- Vitest: "POST /api/webhooks/gmail > dispatches matching new inbound messages and de-duplicates retries"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has two Gmail accounts connected. The admin created a `gmail-new-message` automation for Gmail thread `gmail-thread-1` with subject containing `invoice`, and another for `gmail-thread-2`, and selected the second account for the first automation's chat thread via `PUT /api/chat-threads/:id/connector-selections`. Gmail returns a new inbox message in `gmail-thread-1` from `Customer Example <customer@example.com>` with subject `Invoice needs a reply` and body `Please draft a helpful reply.`.
- When: Pub/Sub pushes for the first account's address, then delivers two concurrent identical pushes for the second account's address at history 101, then the same push again after the run starts.
- Then: The first-account push responds HTTP 200 with `dispatched: 0`. The concurrent pushes respond HTTP 200, one with `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }` and the other with `dispatched: 0, duplicates: 1`. The thread shows `A new email arrived from Customer Example <customer@example.com> with subject "Invoice needs a reply".`, the selection still points to the second account, the matching automation has a `lastRunAt` and the `gmail-thread-2` automation does not. The run prompt states the email body is not included, omits the body text, contains the event context (automation ID, `new_message`, second address, `msg-1`, `gmail-thread-1`, sender, recipients, empty cc, subject), the system prompt has `# Identity`, and the run's connector secrets come from the second account. The final retry responds with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 1 }` and the message appears only once.

## webhooks-gmail-015

- Vitest: "POST /api/webhooks/gmail > reprojects Gmail labels when the workflow thread account changes"
- Mode: run
- Given: A workspace admin with a workflow has two Gmail accounts connected. In the first account `Label_collision` is named `Account scoped`; in the second it is named `Different label`. Gmail's watch stop endpoint fails with HTTP 500.
- When: The admin creates a `gmail-label-applied` automation for `Account scoped`, selects the second account for its chat thread via `PUT /api/chat-threads/:id/connector-selections`, reads the automation, and then creates another label automation for `Selected account`.
- Then: Creation returns the event config `{ provider: "gmail", event: "label_applied", labelName: "Account scoped", resolvedLabelId: "Label_collision" }` and watches only the first account. After switching, Gmail is watched with the second account's token, stop is never called, and the automation keeps `labelName: "Account scoped"` without a `resolvedLabelId`. The second automation's label lookup uses only the second account's token.

## webhooks-gmail-016

- Vitest: "POST /api/webhooks/gmail > does not restore a denied Gmail default after deleting the last allowed account"
- Mode: run
- Given: A workspace admin with a workflow has two Gmail accounts connected and created a `gmail-new-message` automation.
- When: The admin denies the first account for the automation thread via `PUT /api/chat-threads/:threadId/connector-access/:connectionId` with `enabled: false`, deletes the second account, reads `GET /api/chat-threads/:threadId/connector-access`, Pub/Sub pushes for the first account's address to `POST /api/webhooks/gmail`, and the admin disables then re-enables the automation.
- Then: The override responds HTTP 200 with the second account as current. After deletion the thread reports `currentConnectionId: null` and `available: false`. The push responds HTTP 200 with `dispatched: 0`. Disabling returns HTTP 200 and re-enabling returns HTTP 400.

## webhooks-gmail-017

- Vitest: "POST /api/webhooks/gmail > deletes a Gmail default account without an account-wide remote stop"
- Mode: run
- Given: A workspace admin with a workflow has two Gmail accounts connected, created a `gmail-new-message` automation, and made the second account the default via `POST /api/connector-accounts/:connectionId/default`. Gmail's watch stop endpoint fails with HTTP 500.
- When: The admin deletes the default second account via `DELETE /api/connector-accounts/:connectionId`.
- Then: The delete responds HTTP 200 with exactly `{ deletedConnectionId: <second>, resolvedSelectionCount: 0, promotedDefaultConnectionId: <first> }`, and only the first account remains, as default. Gmail watches were registered with the first, second, then first account tokens, and stop is never called.

## webhooks-gmail-018

- Vitest: "POST /api/webhooks/gmail > restores a Gmail watch after the last account is replaced"
- Mode: run
- Given: A workspace admin with a workflow has one Gmail account connected and created a `gmail-new-message` automation. Gmail's watch stop endpoint fails with HTTP 500.
- When: The admin deletes the only account via `DELETE /api/connector-accounts/:connectionId` and then adds a replacement Gmail account through OAuth.
- Then: The delete responds HTTP 200 with exactly `{ deletedConnectionId: <first>, resolvedSelectionCount: 0, promotedDefaultConnectionId: null }`. Gmail watches were registered with the original and then the replacement account tokens, stop is never called, and the replacement is the only listed account and the default.

## webhooks-gmail-019

- Vitest: "POST /api/webhooks/gmail > binds an unbound Gmail automation when the member's first account connects"
- Mode: run
- Given: A workspace admin with a workflow and a supported model created a `gmail-new-message` automation and then deleted the only Gmail account, leaving no accounts and the automation enabled with `lastRunAt: null`. Gmail returns a new inbox message `msg-1` in `gmail-thread-1` from `Customer Example <customer@example.com>` with subject `Invoice needs a reply`.
- When: The admin adds a first Gmail account through OAuth, and Pub/Sub pushes for that address at history 101 to `POST /api/webhooks/gmail`.
- Then: The new account is the only one and default, and the latest Gmail watch uses its token. The push responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 1, duplicates: 0 }`. The automation stays enabled with a `lastRunAt`, a run starts in its thread whose prompt contains the event context for the new address, and the run's connector secrets come from the new account.

## webhooks-gmail-020

- Vitest: "POST /api/webhooks/gmail > acknowledges events after a configured Gmail label disappears"
- Mode: run
- Given: A workspace admin with a workflow has connected Gmail and created a `gmail-label-applied` automation for `Support` (resolved to `Label_support`). Afterwards Gmail lists no labels, and history reports label `Label_other` applied to a message.
- When: Pub/Sub pushes a signed notification at history 102 to `POST /api/webhooks/gmail`.
- Then: The webhook responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 0, duplicates: 0 }`. The automation stays enabled with `labelName: "Support"`, `resolvedLabelId: "Label_support"` and `lastRunAt: null`.

## webhooks-gmail-021

- Vitest: "POST /api/webhooks/gmail > dispatches label applied events after refreshing a recreated label id"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail and created a `gmail-label-applied` automation for `Support`, which responds with `resolvedLabelId: "Label_support_old"`. The label was then recreated as `Label_support_new`, and Gmail history reports it applied to four messages from `Support Team <support@example.com>`.
- When: Pub/Sub pushes a signed notification at history 102 to `POST /api/webhooks/gmail`, and each resulting run is completed by the sandbox in turn.
- Then: The webhook responds HTTP 200 with exactly `{ success: true, watchStates: 1, dispatched: 4, duplicates: 0 }`. Runs start one at a time until there are four, and the thread inputs are, in order, `Gmail label "Support" was added to an email from Support Team <support@example.com> with subject "Support request <messageId>".` for each message. The automation now has `resolvedLabelId: "Label_support_new"` and a `lastRunAt`.

## webhooks-gmail-022

- Vitest: "POST /api/webhooks/gmail > with a metadata-only Gmail workflow > preserves metadata-only context through the workflow queue"
- Mode: run
- Given: A workspace admin with a workflow and a supported model has connected Gmail and created a `gmail-new-message` automation matching body text `helpful reply`. Gmail returns a new inbox message whose body is `Please draft a helpful reply.`. The admin started a manual run via `POST /api/workflow-automations/:id/run`, which is still active.
- When: Pub/Sub pushes a signed notification at history 101 to `POST /api/webhooks/gmail`, and then the active run completes through the sandbox.
- Then: The webhook responds HTTP 200 with `dispatched: 1, duplicates: 0` while the thread still has only the manual run. After completion a second run starts; its prompt states the email body is not included, does not contain the body text, and contains the Gmail event context (automation ID, `new_message`, address, `msg-1`, `gmail-thread-1`, sender, recipients, empty cc, subject). Its system prompt contains `# Identity`.

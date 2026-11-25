# webhooks-notion

## webhooks-notion-001

- Vitest: "POST /api/webhooks/notion > publishes the first verification token and preserves its signing authority"
- Mode: run
- Given: The Notion webhook endpoint has not yet received a verification token, and Notion holds a `page.created` event signed with the token it will later publish.
- When: The signed event is posted to `POST /api/webhooks/notion` before verification, then Notion posts its verification token, then a different replacement verification token, then the event signed with the replacement token, and finally the original signed event again.
- Then: The pre-verification event returns HTTP 503 with error "Notion webhook verification token is not configured". The first verification returns HTTP 200 with `kind: "verification"` and zero pending, refreshed and duplicates. The replacement token and the event signed with it both return HTTP 401 `Unauthorized`, while the originally signed event returns HTTP 200 with `kind: "event"` and zero counts.

## webhooks-notion-002

- Vitest: "POST /api/webhooks/notion > acknowledges unsupported signed events"
- Mode: run
- Given: The Notion webhook has been verified with its verification token.
- When: Notion posts a correctly signed `page.moved` event to `POST /api/webhooks/notion`.
- Then: The response is HTTP 200 with `success: true`, `kind: "event"` and `pending`, `refreshed` and `duplicates` all 0.

## webhooks-notion-003

- Vitest: "POST /api/webhooks/notion > rejects invalid signatures"
- Mode: run
- Given: The Notion webhook has been verified with its verification token.
- When: A `page.created` event is posted to `POST /api/webhooks/notion` with header `X-Notion-Signature: sha256=invalid`.
- Then: The response is HTTP 401 with error `Unauthorized`.

## webhooks-notion-004

- Vitest: "POST /api/webhooks/notion > enqueues and debounces page content updated events for a page scope"
- Mode: run
- Given: The Notion webhook is verified. A signed-in org member has a workflow, has connected Notion, and created a `notion-page-content-updated` automation scoped to a child page URL (HTTP 201); Notion reports the child page with a data-source parent.
- When: Notion posts a signed `page.content_updated` event for the child page, then a `page.properties_updated` event five minutes later, then another `page.content_updated` event ten minutes after the first, each to `POST /api/webhooks/notion`.
- Then: The first content update returns HTTP 200 with `pending: 1`. The properties update returns HTTP 200 with pending, refreshed and duplicates all 0. The second content update returns HTTP 200 with `pending: 0` and `refreshed: 1`.

## webhooks-notion-005

- Vitest: "POST /api/webhooks/notion > enqueues page content updated events for a database scope"
- Mode: run
- Given: The Notion webhook is verified. A signed-in org member has a workflow, has connected Notion, and created a `notion-page-content-updated` automation scoped to a database URL (HTTP 201); Notion resolves the database to its data source.
- When: Notion posts a signed `page.content_updated` event for a page whose parent is that data source to `POST /api/webhooks/notion`.
- Then: The response is HTTP 200 with `kind: "event"`, `pending: 1`, `refreshed: 0` and `duplicates: 0`.

## webhooks-notion-006

- Vitest: "POST /api/webhooks/notion > deduplicates concurrent delivery of the same signed content event"
- Mode: run
- Given: The Notion webhook is verified. A signed-in org member has connected Notion and created a `notion-page-content-updated` automation for a child page that Notion reports under a data source.
- When: The same signed `page.content_updated` delivery is posted twice concurrently to `POST /api/webhooks/notion`.
- Then: Both responses are HTTP 200; one reports `pending: 1, duplicates: 0` and the other reports `pending: 0, duplicates: 1`.

## webhooks-notion-007

- Vitest: "POST /api/webhooks/notion > refreshes pending child page creation after a content update"
- Mode: run
- Given: The Notion webhook is verified. A signed-in org member has connected Notion and created a `notion-child-page-created` automation for a parent page; Notion reports the child page under that parent.
- When: Notion posts a signed `page.created` event for the child page, then a `page.content_updated` event for it five minutes later, to `POST /api/webhooks/notion`.
- Then: The creation event returns HTTP 200 with `pending: 1`. The content update returns HTTP 200 with `pending: 0` and `refreshed: 1`.

## webhooks-notion-008

- Vitest: "POST /api/webhooks/notion > refreshes pending database item creation after a content update"
- Mode: run
- Given: The Notion webhook is verified. A signed-in org member has connected Notion and created a `notion-database-item-created` automation for a database URL that Notion resolves to its data source.
- When: Notion posts a signed `page.created` event whose parent carries the database ID and data-source ID, then a `page.content_updated` event with the data source as parent five minutes later, to `POST /api/webhooks/notion`.
- Then: The creation event returns HTTP 200 with `pending: 1`. The content update returns HTTP 200 with `pending: 0` and `refreshed: 1`.

## webhooks-notion-009

- Vitest: "POST /api/webhooks/notion > follows changes to the default Notion account"
- Mode: run
- Given: A signed-in org member has two connected Notion accounts (the first is the default) and a workflow with a Chat-bound `notion-child-page-created` automation that listens on the first account.
- When: The member makes the second account the default Notion account, reads the automation via `GET /api/workflow-automations/:id`, then makes the first account the default again and reads it again.
- Then: The automation's `eventConfig.connectorId` is the second account after the first change and the first account after switching back.

## webhooks-notion-010

- Vitest: "POST /api/webhooks/notion > keeps Notion listening on an eligible account when an ineligible account becomes the default"
- Mode: run
- Given: A signed-in org member has two connected Notion accounts (the first is the default), a Chat-bound Notion child-page automation on the first account, and member connector account access enabled. The member sets the second account's policy to `deny` via `PUT /api/connector-account-access/:connectionId/policy`.
- When: The member makes the denied second account the default, reads the automation, then changes the second account's policy to `allow-always` and reads the automation again.
- Then: After the default change the automation still listens on the first account. After the policy becomes `allow-always` the automation's `eventConfig.connectorId` is the second account.

## webhooks-notion-011

- Vitest: "POST /api/webhooks/notion > repairs Notion selection after account deletion and re-add"
- Mode: run
- Given: A signed-in org member has two connected Notion accounts and a Chat-bound Notion child-page automation, and selects the second account in that Chat via `PUT /api/chat-threads/:id/connector-selections`.
- When: The member deletes the second account, re-adds the same Notion user through the OAuth add flow, and selects the re-added account in the Chat.
- Then: After deletion the automation falls back to the first account. The re-added account has a new connection ID, and after it is selected (HTTP 200) the automation listens on the re-added account.

## webhooks-notion-012

- Vitest: "POST /api/webhooks/notion > inherits explicit Notion account selection in new automations"
- Mode: run
- Given: A signed-in org member has two connected Notion accounts and a Chat-bound Notion child-page automation, and selects the second account in that Chat. Notion accepts the second account's token for another parent page.
- When: The member creates another disabled `notion-child-page-created` automation for that parent page via `POST /api/workflows/:workflowId/automations`.
- Then: The existing automation listens on the second account after the selection. The new automation is created with HTTP 201 and its `eventConfig.connectorId` is the second account.

## webhooks-notion-013

- Vitest: "POST /api/webhooks/notion > follows an allowance replacement before the Chat's first explicit account selection"
- Mode: run
- Given: A signed-in org member has two connected Notion accounts (the first is the default) and a Chat-bound Notion child-page automation, with no explicit account selection in the Chat yet.
- When: The member disables the first account in that Chat via `PUT /api/chat-threads/:threadId/connector-access/:connectionId` with `enabled: false`.
- Then: The response is HTTP 200 with `currentConnectionId` equal to the second account, and the automation's `eventConfig.connectorId` becomes the second account.

## webhooks-notion-014

- Vitest: "POST /api/webhooks/notion > repairs the Notion binding when the selected account's timed access expires"
- Mode: run
- Given: The Notion webhook is verified. A signed-in org member with member connector account access enabled has two Notion accounts and a Chat-bound Notion child-page automation, selects the second account in the Chat, and one hour before expiry grants that account an `allow-1h` policy.
- When: One millisecond before expiry Notion posts a signed `page.created` event accessible by the second account's owner; at expiry it posts another `page.created` for a different page accessible by the second owner, then one accessible by the first account's owner.
- Then: The pre-expiry event returns HTTP 200 with `pending: 1` and the automation stays on the second account. At expiry the second-owner event returns HTTP 200 with `pending: 0` and the automation is repaired to the first account. The first-owner event then returns HTTP 200 with `pending: 1`.

## webhooks-notion-015

- Vitest: "POST /api/webhooks/notion > accepts a redelivered page.created after a temporary Notion repair failure"
- Mode: run
- Given: Row `page.created`. The Notion webhook is verified and a signed-in member with member connector account access has two Notion accounts and a Chat-bound child-page automation whose first (current) account has an `allow-1h` policy that expires at event time. Notion first answers the parent page lookup with HTTP 429.
- When: Notion posts a signed `page.created` event for the child page, accessible by the second account's owner, to `POST /api/webhooks/notion`; after Notion starts answering the parent page with the second account's token, the same delivery is posted twice more.
- Then: The first delivery returns HTTP 503. The first redelivery returns HTTP 200 with `pending: 1` and `duplicates: 0`, and the next returns HTTP 200 with `pending: 0` and `duplicates: 1`.

## webhooks-notion-016

- Vitest: "POST /api/webhooks/notion > accepts a redelivered page.content_updated after a temporary Notion repair failure"
- Mode: run
- Given: Row `page.content_updated`. The Notion webhook is verified and a signed-in member with member connector account access has two Notion accounts, a Chat-bound child-page automation, a content-updated automation for the parent page and one for an unrelated database whose data source Notion answers with HTTP 429. The first (current) account has an `allow-1h` policy that expires at event time and Notion first answers the parent page lookup with HTTP 429.
- When: Notion posts a signed `page.content_updated` event for the parent page, accessible by the second account's owner, to `POST /api/webhooks/notion`; after Notion starts answering the parent page with the second account's token, the same delivery is posted twice more.
- Then: The first delivery returns HTTP 503. The first redelivery returns HTTP 200 with `pending: 1` and `duplicates: 0`, and the next returns HTTP 200 with `pending: 0` and `duplicates: 1`.

## webhooks-notion-017

- Vitest: "POST /api/webhooks/notion > uses the verified page parent when dispatching a repaired data-source listener"
- Mode: run
- Given: The Notion webhook is verified. A signed-in member with member connector account access has two Notion accounts and a Chat-bound `notion-page-content-updated` automation for a database; the first account's `allow-1h` policy expires at event time. With the second account's token Notion resolves the database and reports the child page under the database's data source, after one rate-limited child page lookup.
- When: At expiry Notion posts a signed `page.content_updated` event for the child page, accessible by the second account's owner, whose payload names the parent page as parent.
- Then: The response is HTTP 200 with `pending: 1`.

## webhooks-notion-018

- Vitest: "POST /api/webhooks/notion > repairs a denied Notion binding only when the replacement can access the resource"
- Mode: run
- Given: The Notion webhook is verified and the cron secret is configured. A signed-in member has two Notion accounts and a Chat-bound child-page automation; both accounts are disabled in the Workflow Chat and the second account is the member default. Later the member adds a replacement Notion account whose token Notion first rejects for the parent page with HTTP 404, then accepts.
- When: Notion posts signed `page.created` events for the child page accessible by the second owner, then (with the replacement rejected) by the second and replacement owners, then (with the replacement accepted) by no owner, the second owner and the replacement owner, followed by `page.properties_updated` events for both owners; finally `GET /api/cron/execute-workflow-automations` runs with the cron secret.
- Then: Every creation delivery returns HTTP 200 with `pending: 0` except the replacement owner's after access is granted, which returns `pending: 1`; the ownerless delivery repairs the automation to the replacement account. The properties updates refresh 0 for the second owner and 1 for the replacement owner. The cron returns `{success: true, executed: 1, skipped: 0}` and the Chat contains exactly one input: 'Notion page "Launch notes" was created under the configured parent page.'

## webhooks-notion-019

- Vitest: "POST /api/webhooks/notion > keeps an allowed Notion listener after deleting the selected account"
- Mode: run
- Given: Row `selected`. A signed-in member has three Notion accounts and a Chat-bound child-page automation; the first account is disabled in the Chat and the third account is set as the Chat's current account via `PUT /api/chat-threads/:threadId/connector-current`.
- When: The member deletes the third (selected) account and reads `GET /api/chat-threads/:threadId/connector-access` for the Notion target.
- Then: Before deletion the automation listens on the third account. After deletion `currentConnectionId` is the second account and the automation's `eventConfig.connectorId` is the second account.

## webhooks-notion-020

- Vitest: "POST /api/webhooks/notion > keeps an allowed Notion listener after deleting the default account"
- Mode: run
- Given: Row `default`. A signed-in member has three Notion accounts and a Chat-bound child-page automation; the second account is disabled in the Chat and the first (default) account is set as the Chat's current account via `PUT /api/chat-threads/:threadId/connector-current`.
- When: The member deletes the first (default) account and reads `GET /api/chat-threads/:threadId/connector-access` for the Notion target.
- Then: Before deletion the automation listens on the first account. After deletion `currentConnectionId` is the third account and the automation's `eventConfig.connectorId` is the third account.

## webhooks-notion-021

- Vitest: "POST /api/webhooks/notion > does not reactivate a denied Notion default when deletion leaves no allowed account"
- Mode: run
- Given: A signed-in member has two Notion accounts (the first is the default) and a Chat-bound child-page automation, and disables the first account in that Chat via `PUT /api/chat-threads/:threadId/connector-access/:connectionId`.
- When: The member deletes the second account, reads `GET /api/chat-threads/:threadId/connector-access`, and tries to enable the automation via `POST /api/workflow-automations/:id/enable`.
- Then: The override response has `currentConnectionId` equal to the second account. After deletion the Chat access shows `currentConnectionId: null` and `available: false`, and enabling the automation returns HTTP 400.

## webhooks-notion-022

- Vitest: "POST /api/webhooks/notion > synchronizes Notion listeners after Chat, Run, approval and account allowance changes"
- Mode: run
- Given: A signed-in member has two Notion accounts (the first is the default), a Runner group, and a Chat-bound Notion child-page automation.
- When: The member sets the second account current via `PUT /api/chat-threads/:threadId/connector-current`; a Run in the Chat selects the first account with its Okou token via `PUT /api/run/connector-accounts/current`; the member disables the second account in the Chat, tries to set it current again, approves it via `POST /api/chat-threads/:threadId/connector-account-approval`, disables it again, resets it to inherit, and disables the first account's default via `PUT /api/connector-account-access/:connectionId/default-enabled`.
- Then: The automation follows the second account after the Chat switch and the first after the Run selection. Setting the denied second account current returns HTTP 400 and the automation stays on the first account; the approval (HTTP 200) moves it to the second, disabling the second moves it back to the first, and after inheriting the second and disabling the first account's default it listens on the second account.

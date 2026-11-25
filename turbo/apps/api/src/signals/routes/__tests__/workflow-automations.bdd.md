# workflow-automations

## workflow-automations-001

- Vitest: "okou workflow automations > creates, disables, and re-enables a cron automation without binding a chat thread"
- Mode: run
- Given: A signed-in member of a Pro org owns a workflow, and the clock is 2026-06-26T08:00Z.
- When: The member creates a cron automation `0 9 * * 1-5` in UTC via `POST /api/workflows/:workflowId/automations`, disables it via `POST /api/workflow-automations/:id/disable`, and re-enables it at 2026-06-26T10:00Z via `POST /api/workflow-automations/:id/enable`.
- Then: Creation returns HTTP 201 with `kind: "schedule"`, enabled, no Chat thread, `nextRunAt` 2026-06-26T09:00Z and summary "0 9 * * 1-5 (UTC)". Disabling returns HTTP 200 with enabled false and `nextRunAt` null. Re-enabling returns HTTP 200, enabled, `nextRunAt` 2026-06-29T09:00Z and still no Chat thread.

## workflow-automations-002

- Vitest: "okou workflow automations > lists thread-bound workflow automations"
- Mode: run
- Given: A signed-in member of a Team org owns a workflow; a webhook automation was created (binding a Chat thread) and then deleted.
- When: The member creates a 60-second loop schedule and a daily `0 9 * * *` UTC cron schedule, then lists `GET /api/chat-threads/:threadId/workflow-automations` for that thread.
- Then: Both new automations bind to the existing thread. The list has exactly two schedule automations in creation order with summaries "Every 60s" and "0 9 * * * (UTC)", the thread ID, and the workflow's ID and name.

## workflow-automations-003

- Vitest: "okou workflow automations > shares a destination across concurrent creates and rebinds after deletion"
- Mode: run
- Given: A signed-in member of a Team org owns a workflow.
- When: The member creates two webhook automations concurrently, lists the thread's automations, deletes the thread via `DELETE /api/chat-threads/:id`, reads both automations, creates another webhook automation, and reads both threads' metadata.
- Then: Both concurrent automations share one thread and the list holds exactly their IDs. After the thread deletion (HTTP 204) both automations are disabled with no thread. The new automation binds to a different thread; the old thread's metadata returns HTTP 404 and the new one HTTP 200.

## workflow-automations-004

- Vitest: "okou workflow automations > validates, creates, updates and lists a one-time schedule in its time zone"
- Mode: run
- Given: A signed-in member of a Pro org owns a workflow, and the clock is 2026-06-22T07:50Z.
- When: The member creates a one-time schedule at 07:49Z UTC, creates one at local `2026-06-22T15:55:00` in Asia/Shanghai, updates it to local `16:05:00`, then reads `GET /api/workflows/:workflowId/automations` and `GET /api/workflows/:workflowId`.
- Then: The past time returns HTTP 400 `BAD_REQUEST` "Schedule atTime must be in the future". The created schedule stores `atTime` 07:55Z with `nextRunAt` 07:55Z, and the update returns HTTP 200 with `atTime` and `nextRunAt` 08:05Z in Asia/Shanghai. Both the automation list and the workflow detail show this schedule automation with the updated schedule.

## workflow-automations-005

- Vitest: "okou workflow automations > rejects creation on a workflow the caller cannot see"
- Mode: run
- Given: A signed-in member of a Pro org cannot see another member's private workflow.
- When: The member creates an hourly loop automation on that workflow via `POST /api/workflows/:workflowId/automations`.
- Then: The response is HTTP 404 with code `NOT_FOUND` and message "Workflow not found: <workflowId>".

## workflow-automations-006

- Vitest: "okou workflow automations > requires Team for webhook automation creation"
- Mode: run
- Given: A signed-in member of a Pro org owns a workflow.
- When: The member creates a `webhook-received` automation, then the org is upgraded to Team and the member creates it again.
- Then: The Pro attempt returns HTTP 402 with error `TEAM_REQUIRED` "Webhook automations require a Team workspace". After the upgrade the creation returns HTTP 201 with `kind: "event"` and `eventType: "webhook-received"`.

## workflow-automations-007

- Vitest: "okou workflow automations > serializes webhook creation with an effective downgrade"
- Mode: run
- Given: A signed-in member of a Team org owns a workflow.
- When: The member creates a `webhook-received` automation while Stripe concurrently delivers `customer.subscription.deleted` for the org's subscription.
- Then: The outcome is either HTTP 201 with the automation reading back as disabled with `disabledReason: "paid_plan_required"`, or HTTP 402 with error code `TEAM_REQUIRED`.

## workflow-automations-008

- Vitest: "okou workflow automations > lists owned workflow automations across visible workflows"
- Mode: run
- Given: A signed-in member of a Pro org owns two workflows.
- When: The member creates a 60-second loop on the first and a daily `0 10 * * *` UTC cron on the second, then reads `GET /api/workflow-automations`.
- Then: The workspace list includes both automations with their workflow IDs and names, and the workflow summaries carry no `files` or `fileContents`.

## workflow-automations-009

- Vitest: "okou workflow automations > discloses webhook credentials only on create and reveal and keeps the thread after deletion"
- Mode: run
- Given: A signed-in member of a Team org owns a workflow.
- When: The member creates a `webhook-received` automation, lists the workflow's and the thread's automations, reveals credentials via `POST /api/workflow-automations/:id/webhook-secret`, deletes the automation, and lists the thread again.
- Then: Creation returns the HMAC-SHA256 webhook config, a `/api/webhooks/workflow-automations/whk_` URL, a secret and its last four characters. Workflow and thread lists show `secretLastFour` but neither the URL nor the secret. The reveal returns exactly the original URL and secret. Deletion (HTTP 204) publishes `chatThreadAutomationsChanged:<threadId>`, the thread keeps model `claude-fable-5-1`, and its automation list becomes empty.

## workflow-automations-010

- Vitest: "okou workflow automations > uses configured webhook URLs for agent run tokens"
- Mode: run
- Given: `OKOU_WEB_URL` is `https://api.okou.ai` and a Team-org member using Fable owns a workflow.
- When: The member creates a `webhook-received` automation with origin `https://app.okou.ai`, starts a Chat Run, and the Run's Okou token reveals the credentials via `POST /api/workflow-automations/:id/webhook-secret`.
- Then: The created URL's host is `api.okou.ai`. The reveal returns HTTP 200 with host `api.okou.ai`, the same path, and the same secret.

## workflow-automations-011

- Vitest: "okou workflow automations > rejects webhook re-enable for Pro"
- Mode: run
- Given: A signed-in member of a Team org has a disabled `webhook-received` automation; then Stripe deletes the subscription and the org is re-entitled only at Pro.
- When: The member re-enables the automation via `POST /api/workflow-automations/:id/enable`.
- Then: The response is HTTP 402 with error code `TEAM_REQUIRED`.

## workflow-automations-012

- Vitest: "okou workflow automations > serializes webhook re-enable with an effective downgrade"
- Mode: run
- Given: A signed-in member of a Team org has a disabled `webhook-received` automation.
- When: The member re-enables it via `POST /api/workflow-automations/:id/enable` while Stripe concurrently delivers `customer.subscription.deleted`.
- Then: The automation ends up disabled, and the outcome is either HTTP 200 with `disabledReason: "paid_plan_required"` on read-back, or HTTP 402 with error code `TEAM_REQUIRED`.

## workflow-automations-013

- Vitest: "okou workflow automations > clears the plan-disabled reason without rotating webhook credentials"
- Mode: run
- Given: A signed-in member of a Team org has a `webhook-received` automation that Stripe's `customer.subscription.deleted` disabled with `disabledReason: "paid_plan_required"`; the org then regains Team.
- When: The member re-enables the automation via `POST /api/workflow-automations/:id/enable` and reveals its credentials via `POST /api/workflow-automations/:id/webhook-secret`.
- Then: The automation reads back as disabled with reason `paid_plan_required` after the downgrade. Re-enabling returns HTTP 200 with enabled true and `disabledReason` null, and the reveal returns the original webhook URL and secret.

## workflow-automations-014

- Vitest: "okou workflow automations > requires a connected account for provider event automations"
- Mode: run
- Given: A signed-in member of a Pro org owns a workflow, the Gmail Pub/Sub topic is configured, and no Gmail, Google Calendar or Notion account is connected.
- When: The member creates a `gmail-new-message`, a `google-calendar-event-created` and a `notion-child-page-created` automation via `POST /api/workflows/:workflowId/automations`.
- Then: Each returns HTTP 400 with "Connect Gmail before adding a Gmail event automation", "Connect Google Calendar before adding a Google Calendar event automation" and "Connect Notion before adding a Notion event automation" respectively.

## workflow-automations-015

- Vitest: "okou workflow automations > rejects Google Forms creation when Pub/Sub push is not configured"
- Mode: run
- Given: A signed-in member has connected Google Forms, but Google Forms Pub/Sub push is not configured.
- When: The member creates a `google-forms-response-submitted` automation for a form edit URL.
- Then: The response is HTTP 400 with message "Google Forms Pub/Sub push is not configured".

## workflow-automations-016

- Vitest: "okou workflow automations > rejects Google Forms respondent links with edit-page guidance"
- Mode: run
- Given: A signed-in member has connected Google Forms.
- When: The member creates a `google-forms-response-submitted` automation with a respondent link `https://docs.google.com/forms/d/e/.../viewform`.
- Then: The response is HTTP 400 with message "Please open the form's edit page and copy the link from the address bar".

## workflow-automations-017

- Vitest: "okou workflow automations > explains inaccessible or missing Google Forms"
- Mode: run
- Given: A signed-in member has connected Google Forms with Pub/Sub push configured, and the Google Forms API answers the form lookup with 403 `PERMISSION_DENIED`.
- When: The member creates a `google-forms-response-submitted` automation for the form edit URL.
- Then: The response is HTTP 400 with message "You do not have access to this form, or it does not exist".

## workflow-automations-018

- Vitest: "okou workflow automations > validates Google Forms, seeds the raw cursor, creates a watch, and warns for unpublished forms"
- Mode: run
- Given: A signed-in member has connected Google Forms with Pub/Sub push configured, and Google reports the form "Customer survey" as not yet accepting responses.
- When: The member creates a `google-forms-response-submitted` automation for the form edit URL.
- Then: The response is HTTP 201, enabled, with the connector ID and form ID, title "Customer survey" and URL, plus the warning "This Google Form is not accepting responses yet. Publish it before expecting response events."

## workflow-automations-019

- Vitest: "okou workflow automations > shares one Google Forms watch until the last same-user consumer is disabled"
- Mode: run
- Given: A signed-in member has connected Google Forms with Pub/Sub push configured and owns two workflows.
- When: The member creates a `google-forms-response-submitted` automation for the same form in each workflow, then disables the first and then the second via `POST /api/workflow-automations/:id/disable`.
- Then: Google receives exactly one watch creation. Disabling the first automation deletes no watch; disabling the second deletes the watch exactly once.

## workflow-automations-020

- Vitest: "okou workflow automations > adopts the matching Google Forms watch after a create conflict"
- Mode: run
- Given: A signed-in member has connected Google Forms; Google rejects watch creation with 400 `FAILED_PRECONDITION` (watch already exists) and lists one matching `RESPONSES` watch on the configured topic.
- When: The member creates a `google-forms-response-submitted` automation for the form.
- Then: The response is HTTP 201 with the automation enabled, and Google's watch list is queried exactly once.

## workflow-automations-021

- Vitest: "okou workflow automations > keeps a Google Forms automation disabled when remote cleanup fails"
- Mode: run
- Given: A signed-in member has an enabled Google Forms automation, and Google answers watch deletion with HTTP 500.
- When: The member disables the automation via `POST /api/workflow-automations/:id/disable`.
- Then: The response is HTTP 200, the automation reads back as disabled, and Google receives exactly one watch deletion attempt.

## workflow-automations-022

- Vitest: "okou workflow automations > attempts to stop every Google Forms watch on disconnect"
- Mode: run
- Given: A signed-in member has Google Forms automations on two different forms in two workflows; Google fails the first watch deletion with HTTP 500 and accepts the next.
- When: The member deletes the default Google Forms connector account.
- Then: Google receives exactly two watch deletion attempts.

## workflow-automations-023

- Vitest: "okou workflow automations > treats the Google Forms missing-watch 403 as successful teardown"
- Mode: run
- Given: A signed-in member has an enabled Google Forms automation, and Google answers watch deletion with 403 `PERMISSION_DENIED` "Watch not found or permission denied.".
- When: The member disables the automation and then re-enables it via `POST /api/workflow-automations/:id/enable`.
- Then: Both calls return HTTP 200 and the re-enabled automation is enabled. Google receives one watch deletion and two watch creations in total.

## workflow-automations-024

- Vitest: "okou workflow automations > rejects updates to a Google Forms trigger with explicit guidance"
- Mode: run
- Given: A signed-in member has a Google Forms automation.
- When: The member updates it via `PATCH /api/workflow-automations/:id` with a Gmail `new_message` event config.
- Then: The response is HTTP 400 with message "this trigger has no updatable fields; delete it and create a new one".

## workflow-automations-025

- Vitest: "okou workflow automations > requires standard notion.so page and database URLs for Notion automations"
- Mode: run
- Given: A signed-in member has connected Notion.
- When: The member creates a `notion-child-page-created` automation with parent page URL `https://example.com/notion-page`, then a `notion-database-item-created` automation with database URL `https://example.com/notion-database`.
- Then: Both return HTTP 400, with "Enter a standard notion.so page URL" and "Enter a standard notion.so database URL" respectively.

## workflow-automations-026

- Vitest: "okou workflow automations > reports inaccessible Notion pages and databases"
- Mode: run
- Given: A signed-in member has connected Notion, and the Notion API answers page, database and data-source lookups with HTTP 404.
- When: The member creates a `notion-child-page-created` automation for a notion.so page URL and a `notion-database-item-created` automation for a notion.so database URL.
- Then: Both return HTTP 400, with "Okou cannot access this Notion page" and "Okou cannot access this Notion database" respectively.

## workflow-automations-027

- Vitest: "okou workflow automations > creates Notion child page automations by validating and storing the parent page"
- Mode: run
- Given: A signed-in member has connected Notion, and Notion returns the parent page titled "Roadmap".
- When: The member creates a `notion-child-page-created` automation for that page URL via `POST /api/workflows/:workflowId/automations`.
- Then: The response is HTTP 201, enabled with no schedule or `nextRunAt`, a bound Chat thread, and an event config holding the connector ID and parent page ID, URL, title "Roadmap" and raw URL.

## workflow-automations-028

- Vitest: "okou workflow automations > creates Notion database item automations by validating and storing the data source"
- Mode: run
- Given: A signed-in member has connected Notion, and Notion resolves the database URL to the data source "Bug Bash".
- When: The member creates a `notion-database-item-created` automation for that database URL.
- Then: The response is HTTP 201, enabled with no schedule or `nextRunAt`, a bound Chat thread, and an event config holding the connector ID and data source ID, URL, title "Bug Bash", and the database URL as raw URL.

## workflow-automations-029

- Vitest: "okou workflow automations > creates Notion page content updated automations for a page scope"
- Mode: run
- Given: A signed-in member has connected Notion, and Notion returns the page titled "Roadmap".
- When: The member creates a `notion-page-content-updated` automation with that page URL.
- Then: The response is HTTP 201, enabled with no schedule or `nextRunAt`, a bound Chat thread, and an event config with the connector ID and a `page` scope holding the page ID, URL, title "Roadmap" and raw URL.

## workflow-automations-030

- Vitest: "okou workflow automations > creates Notion page content updated automations for a database scope"
- Mode: run
- Given: A signed-in member has connected Notion, and Notion resolves the database URL to the data source "Bug Bash".
- When: The member creates a `notion-page-content-updated` automation with that database URL.
- Then: The response is HTTP 201, enabled with no schedule or `nextRunAt`, a bound Chat thread, and an event config with the connector ID and a `data_source` scope holding the data source ID, URL, title "Bug Bash" and the database URL as raw URL.

## workflow-automations-031

- Vitest: "okou workflow automations > creates a Gmail event automation with a watch and updates its match criteria"
- Mode: run
- Given: A signed-in member has connected Gmail and the Gmail watch API accepts registration on the configured Pub/Sub topic.
- When: The member creates a `gmail-new-message` automation matching subjects containing "invoice", then updates it via `PATCH /api/workflow-automations/:id` to match senders containing "billing@example.com".
- Then: Creation returns HTTP 201, enabled with no schedule, a bound Chat thread and the subject match, and Gmail receives exactly one watch registration. The update returns HTTP 200 with match exactly `{from: {contains: "billing@example.com"}}`.

## workflow-automations-032

- Vitest: "okou workflow automations > finishes admitted thread deletion and notifies its Runner when the API instance lifetime ends during Calendar teardown"
- Mode: run
- Given: A signed-in member with a Runner group has connected Google Calendar and created a `google-calendar-event-created` automation on `primary`; a manual `POST /api/workflow-automations/:id/run` has started a Run in the automation's Chat. Google accepts the channel stop with the Calendar token, but the API instance's lifetime ends during that call.
- When: The member deletes the automation's Chat via `DELETE /api/chat-threads/:id`.
- Then: The deletion request does not complete because the instance lifetime aborted, yet Google receives exactly one channel stop with channel and resource IDs. Afterwards the automation is disabled with no Chat, the Run is `cancelled`, the Chat metadata returns HTTP 404, and a hard `cancel` realtime message is published for the Run.

## workflow-automations-033

- Vitest: "okou workflow automations > creates Google Calendar event-created automations with a watch and baseline"
- Mode: run
- Given: A signed-in member has connected Google Calendar for `calendar-user@example.com`, which already contains one confirmed event.
- When: The member creates a `google-calendar-event-created` automation with that address as `calendarId`.
- Then: The response is HTTP 201, enabled, with `calendarId: "primary"`, no schedule and a bound Chat thread. Google receives one watch registration and one baseline event listing requested without a sync token.

## workflow-automations-034

- Vitest: "okou workflow automations > dispatches from a published Calendar channel after registration"
- Mode: run
- Given: A signed-in member with a Runner group has connected Google Calendar with an empty baseline; after registration Google reports one new confirmed event.
- When: The member creates a `google-calendar-event-created` automation, then Google posts a notification to `POST /api/webhooks/google-calendar` with the registered channel ID, token and resource ID and state `exists`.
- Then: The notification returns HTTP 200 with `success: true`, `dispatched: 1`, `duplicates: 0`. Exactly one Run is dispatched to the Runner, and `GET /api/workflows/:workflowId/run-history` shows one event-triggered run for `google-calendar-event-created` with a Chat thread.

## workflow-automations-035

- Vitest: "okou workflow automations > does not create provider watches for disabled Gmail or Calendar automations"
- Mode: run
- Given: A signed-in member has connected Gmail and Google Calendar.
- When: The member creates a Gmail `new_message` automation and a `google-calendar-event-created` automation, each with `enabled: false`.
- Then: Both are created disabled, and Gmail and Google Calendar receive no watch registrations or baseline listings.

## workflow-automations-036

- Vitest: "okou workflow automations > reconfigures every enabled Calendar event type without replacing automation state"
- Mode: run
- Given: A signed-in member has connected Google Calendar and creates enabled `google-calendar-event-created`, `-updated` and `-cancelled` automations, each on its own calendar; the first one has been run manually via `POST /api/workflow-automations/:id/run`.
- When: The member updates each automation's `eventConfig` to a new calendar ID via `PATCH /api/workflow-automations/:id`.
- Then: Each update returns HTTP 200 with the same ID, event type, enabled state, Chat thread, `lastRunAt` and `official` flag as before and the new event config. Google receives six watch registrations, six baseline listings and three channel stops in total.

## workflow-automations-037

- Vitest: "okou workflow automations > rejects mismatched Calendar config and keeps disabled reconfiguration watch-free"
- Mode: run
- Given: A signed-in member has connected Google Calendar and has a disabled `google-calendar-event-created` automation on `disabled-old@example.com`.
- When: The member updates it with an `event_updated` config, then with an `event_created` config on `calendar-user@example.com`.
- Then: The mismatched update returns HTTP 400 "eventConfig must match the Google Calendar automation type" and the automation keeps its old calendar. The matching update returns HTTP 200, still disabled, with `calendarId: "primary"`. Google receives no watch registration, baseline listing or channel stop.

## workflow-automations-038

- Vitest: "okou workflow automations > preserves consumers shared across both Calendar reconfiguration targets"
- Mode: run
- Given: A signed-in member has connected Google Calendar with enabled automations: an event-created and an event-updated one on an old calendar, and an event-cancelled one on a new calendar.
- When: The member moves the event-created automation to the new calendar via `PATCH /api/workflow-automations/:id`.
- Then: The event-updated automation stays enabled on the old calendar and the event-cancelled one stays enabled on the new calendar. Google receives two watch registrations, two baseline listings, and no channel stop.

## workflow-automations-039

- Vitest: "okou workflow automations > keeps matching-resource alias consumers independent during public reconfiguration"
- Mode: run
- Given: A signed-in member has connected Google Calendar where an alias address and `primary` resolve to the same provider resource. There is an enabled event-created automation on the alias, a disabled event-updated automation on the alias, and an enabled event-cancelled automation on `primary`.
- When: The member moves the event-created automation to `primary` via `PATCH /api/workflow-automations/:id`.
- Then: The moved automation is enabled on `primary`, the disabled alias automation stays disabled on the alias, and the `primary` automation stays enabled. Google receives two watch registrations, two baseline listings, and exactly one channel stop for the first channel and the shared resource ID.

## workflow-automations-040

- Vitest: "okou workflow automations > rolls back Calendar config when replacement watch registration fails"
- Mode: run
- Given: A signed-in member has connected Google Calendar and has an enabled `google-calendar-event-updated` automation on an old calendar; Google rejects watch registration for the new calendar with HTTP 503.
- When: The member updates the automation to the new calendar via `PATCH /api/workflow-automations/:id`.
- Then: The update returns HTTP 400 whose body does not mention the new calendar ID. The automation reads back with its original ID, enabled state, Chat thread, `lastRunAt` and old calendar. Google receives two baseline listings, one successful watch registration, and no channel stop.

## workflow-automations-041

- Vitest: "okou workflow automations > keeps a shared Gmail watch until the last consumer and refreshes it for label re-enable"
- Mode: run
- Given: A signed-in member has connected Gmail with a "Support" label.
- When: The member creates a `gmail-new-message` automation and a `gmail-label-applied` automation for "Support", disables the label automation, deletes the message automation via `DELETE /api/workflow-automations/:id`, and re-enables the label automation.
- Then: Gmail receives one watch registration for both creations. Neither the disable nor the delete stops the mailbox. Re-enabling returns HTTP 200 enabled and triggers a second watch registration.

## workflow-automations-042

- Vitest: "okou workflow automations > does not stop a Gmail mailbox while another connected identity consumes it"
- Mode: run
- Given: Two members in different orgs have each connected Gmail for the same mailbox address.
- When: Each member creates a `gmail-new-message` automation, then the first and then the second member disable theirs.
- Then: Gmail receives two watch registrations, and neither disable stops the mailbox.

## workflow-automations-043

- Vitest: "okou workflow automations > stops Calendar with the persisted channel pair after the last consumer"
- Mode: run
- Given: A signed-in member has connected Google Calendar.
- When: The member creates `google-calendar-event-created` and `google-calendar-event-updated` automations on the primary calendar, disables the first, deletes the second, then re-enables the first.
- Then: Google receives one watch registration for both. Disabling the first stops nothing; deleting the second sends exactly one channel stop with the persisted channel ID and resource `calendar-resource-1`. Re-enabling registers a second watch and a second baseline listing.

## workflow-automations-044

- Vitest: "okou workflow automations > leaves a Calendar automation recoverable after a disable during registration"
- Mode: run
- Given: A signed-in member has connected Google Calendar and has a disabled `google-calendar-event-created` automation; Google's first watch registration is held open.
- When: The member starts enabling the automation, disables it while registration is in progress, lets registration finish, and then enables it again.
- Then: The disable returns HTTP 200 with enabled false while the first enable resolves with HTTP 200 or 400. The final enable returns HTTP 200 enabled, and Google receives two watch registrations.

## workflow-automations-045

- Vitest: "okou workflow automations > recovers after Calendar registration outlives its connector state"
- Mode: run
- Given: A signed-in member has connected Google Calendar and has a disabled `google-calendar-event-created` automation; the Calendar connector account is deleted while Google registers the first watch.
- When: The member enables the automation via `POST /api/workflow-automations/:id/enable`, reconnects Google Calendar, and enables it again.
- Then: The first enable fails, Google receives one channel stop for the registered channel and resource `calendar-resource-1`, and the automation stays disabled. After reconnecting the enable returns HTTP 200 enabled and Google receives a second watch registration.

## workflow-automations-046

- Vitest: "okou workflow automations > does not create a Calendar channel when baseline setup fails"
- Mode: run
- Given: A signed-in member has connected Google Calendar, and Google answers the baseline event listing with HTTP 500.
- When: The member creates a `google-calendar-event-created` automation, then lists `GET /api/workflows/:workflowId/automations`.
- Then: Creation returns HTTP 400, Google receives no watch registration or channel stop, and the workflow has no automations.

## workflow-automations-047

- Vitest: "okou workflow automations > keeps Calendar disabled when remote cleanup fails and permits re-enable"
- Mode: run
- Given: A signed-in member has an enabled `google-calendar-event-created` automation, and Google answers channel stops with HTTP 500.
- When: The member disables the automation and then re-enables it.
- Then: The disable returns HTTP 200 and the automation reads back disabled. The re-enable returns HTTP 200 with the automation enabled.

## workflow-automations-048

- Vitest: "okou workflow automations > leaves a Gmail automation disabled when watch setup fails"
- Mode: run
- Given: A signed-in member has connected Gmail with the Pub/Sub topic configured, and Gmail rejects watch registration with HTTP 500.
- When: The member creates a disabled `gmail-new-message` automation, enables it, then creates an enabled one, and lists the workflow's automations.
- Then: The disabled creation returns HTTP 201, the enable returns HTTP 400 and the automation stays disabled, and the enabled creation returns HTTP 400. The list contains only the first automation, disabled.

## workflow-automations-049

- Vitest: "okou workflow automations > disables and re-enables Gmail locally without stopping the mailbox"
- Mode: run
- Given: A signed-in member has connected Gmail and has an enabled `gmail-new-message` automation.
- When: The member disables and then re-enables the automation.
- Then: The automation reads back disabled after the disable, and the re-enable returns HTTP 200 with it enabled. Gmail receives no mailbox stop.

## workflow-automations-050

- Vitest: "okou workflow automations > preserves the Gmail watch after deleting a workflow"
- Mode: run
- Given: A signed-in member has connected Gmail and has an enabled `gmail-new-message` automation.
- When: The member deletes the workflow via `DELETE /api/workflows/:workflowId`.
- Then: The deletion returns HTTP 204. Gmail received exactly one watch registration and no mailbox stop.

## workflow-automations-051

- Vitest: "okou workflow automations > removes connector credentials without stopping the Gmail mailbox"
- Mode: run
- Given: A signed-in member has connected Gmail and has an enabled `gmail-new-message` automation.
- When: The member deletes the default Gmail connector account.
- Then: Gmail receives no mailbox stop.

## workflow-automations-052

- Vitest: "okou workflow automations > recovers from missing Gmail labels when creating and updating automations"
- Mode: run
- Given: A signed-in member has connected Gmail whose only label is "Support" (`Label_support`).
- When: The member creates a `gmail-label-applied` automation for "support", then for "Support"; updates it to "Escalated" while that label is missing, reads it back, and updates it again after Gmail adds "Escalated" (`Label_escalated`).
- Then: The lowercase name returns HTTP 400 `GMAIL_LABEL_NOT_FOUND` ("Label not found in the connected Gmail account. Check the label name and connected account.") and nothing is created. "Support" creates an enabled automation with `resolvedLabelId: "Label_support"`. The first update returns HTTP 400 `GMAIL_LABEL_NOT_FOUND` and the automation is unchanged; the second returns HTTP 200 with label "Escalated" and `resolvedLabelId: "Label_escalated"`.

## workflow-automations-053

- Vitest: "okou workflow automations > keeps Gmail provider failures distinct from missing labels"
- Mode: run
- Given: A signed-in member has connected Gmail, and Gmail answers the labels listing with HTTP 503.
- When: The member creates a `gmail-label-applied` automation for "Support" and lists the workflow's automations.
- Then: Creation returns HTTP 400 `{code: "BAD_REQUEST", message: "Failed to read Gmail labels"}` and the workflow has no automations.

## workflow-automations-054

- Vitest: "okou workflow automations > creates and updates GitHub pull request automations"
- Mode: run
- Given: A signed-in member's org has the GitHub App installed.
- When: The member creates a `github-pull-request` automation for `okou-ai/okou` with action `closed`, `merged: true` and base-branch, author and PR-number filters; updates it to action `labeled` with label `ready-to-merge`; then updates it to action `opened` with `merged: true`.
- Then: Creation returns HTTP 201, enabled with no schedule, echoing the config. The first update returns HTTP 200 with exactly the `labeled` config and label filter. The `opened` + `merged` update returns HTTP 400.

## workflow-automations-055

- Vitest: "okou workflow automations > creates and updates GitHub workflow run completed automations"
- Mode: run
- Given: A signed-in member's org has the GitHub App installed.
- When: The member creates a `github-workflow-run-completed` automation filtered by repository, workflows, conclusions `failure`/`startup_failure`, branch `main`, events and actor `dependabot[bot]`, then updates the filters to conclusion `success` and branch `release`.
- Then: Creation returns HTTP 201, enabled with no `nextRunAt`, echoing all filters. The update returns HTTP 200 with filters repository `okou-ai/okou`, conclusion `success` and branch `release`.

## workflow-automations-056

- Vitest: "okou workflow automations > rejects GitHub pull request automations when the GitHub App is not installed"
- Mode: run
- Given: A signed-in member's org does not have the GitHub App installed.
- When: The member creates a `github-pull-request` automation for `okou-ai/okou`.
- Then: The response is HTTP 400 `{code: "BAD_REQUEST", message: "Install GitHub before creating GitHub webhook automations"}`.

## workflow-automations-057

- Vitest: "okou workflow automations > schedules a loop from its last run after updates and re-enabling, then converts it to cron"
- Mode: run
- Given: A signed-in member of a Pro org owns a workflow, and the clock is 2026-06-28T06:00Z.
- When: The member creates a 600-second loop, runs it manually at 06:05Z via `POST /api/workflow-automations/:id/run`, changes the interval to 3600 s at 06:10Z, disables it, re-enables it at 06:12Z, and converts it to cron `*/15 * * * *` UTC.
- Then: Creation returns `nextRunAt` 06:00Z. After the interval change `nextRunAt` is 07:05Z; disabling clears it and re-enabling returns enabled with 07:05Z. The cron conversion returns the cron schedule with `nextRunAt` 06:15Z.

## workflow-automations-058

- Vitest: "okou workflow automations > treats a deleted workflow's automation as not found on enable"
- Mode: run
- Given: A signed-in member has a disabled hourly loop automation, and the workflow is then deleted via `DELETE /api/workflows/:workflowId` (HTTP 204).
- When: The member enables the automation via `POST /api/workflow-automations/:id/enable`.
- Then: The response is HTTP 404 with code `NOT_FOUND` and message "Workflow automation not found".

## workflow-automations-059

- Vitest: "okou workflow automations > allows another org member to manage only their own automations"
- Mode: run
- Given: A workflow owner has an hourly loop automation on a workflow, and another member of the same org is signed in.
- When: The other member creates a two-hour loop automation on the same workflow, then deletes the owner's automation via `DELETE /api/workflow-automations/:id`.
- Then: The other member's automation is created with `ownerUserId` set to them. The delete returns HTTP 403 with code `FORBIDDEN` and message "Only the automation owner can manage this automation".

## workflow-automations-060

- Vitest: "okou workflow automations > lazily binds a chat thread when a one-time automation runs now"
- Mode: run
- Given: A signed-in member of a Pro org with a Runner group owns a workflow and creates an enabled one-time Asia/Shanghai schedule one day ahead, which has no Chat thread; the workflow's run history is empty.
- When: The member runs it now via `POST /api/workflow-automations/:id/run`, then reads `GET /api/workflows/:workflowId/run-history`, the automation and the bound Chat's events.
- Then: The run request returns HTTP 201 with no Run ID and starts one Run in a newly bound Chat. Run history lists exactly that Run with the request time, its status, `trigger: "manual"`, no event type and the Chat ID. The prompt contains the workflow slash command, a manual "Automation event" summary and the JSON payload with automation ID, trigger and requested time; the system prompt contains "Your name is Okou.". The automation is now bound to the Chat, disabled, with unchanged `nextRunAt` and a `lastRunAt`, and the Chat's workflow input is linked to the Run and reads "A manual run of this workflow was requested.".

## workflow-automations-061

- Vitest: "okou workflow automations > continues workflow run history across a timestamp shared by two runs"
- Mode: run
- Given: A Pro member with a Runner group owns a workflow with an hourly and a two-hourly loop automation; the Runner accepts each dispatched Run.
- When: The member triggers 31 manual runs via `POST /api/workflow-automations/:id/run`, the first two at the same instant, each Run failing via `POST /api/webhooks/run/complete`; then the member reads `GET /api/workflows/:workflowId/run-history` and follows its cursor.
- Then: The first page lists the 30 newest Runs newest first, with the two same-timestamp Runs ordered by descending ID and only the higher one on this page. The next page holds the remaining same-timestamp Run, starts at the same `createdAt` as the first page's last entry, and has no further cursor.

## workflow-automations-062

- Vitest: "okou workflow automations > shares one lazy destination across concurrent and repeated Run now requests"
- Mode: run
- Given: A Pro member with a Runner group owns a workflow with display name "Lazy workflow destination" and a one-time UTC schedule one day ahead that has no Chat thread; the clock is fixed at 2026-08-01T12:34:56.123Z.
- When: The member sends two concurrent `POST /api/workflow-automations/:id/run` requests and then a third one.
- Then: No thread exists before the runs. Both concurrent responses are identical with no Run ID, and exactly one `created` thread event appears titled "Lazy workflow destination" with model `claude-fable-5-1`, empty model settings, no service tier, cloud browser enabled and the fixed creation time. The repeated request returns the same body and adds no lifecycle event; the automation keeps the thread and `nextRunAt`. The Chat holds exactly one `input.prompt`, whose Run executes with the workflow slash command and "Your name is Okou.".

## workflow-automations-063

- Vitest: "okou workflow automations > repairs a lazy destination after public thread deletion without reusing its identity"
- Mode: run
- Given: A Pro member with a Runner group owns a workflow with a one-time UTC schedule one day ahead. A manual run created a Chat and Run; the Run was cancelled and completed, and the member deleted the Chat via `DELETE /api/chat-threads/:id`.
- When: One second later the member runs the automation now again via `POST /api/workflow-automations/:id/run`, then reads run history, the automation, both Chats' metadata and the thread lifecycle events.
- Then: After deletion the automation has no Chat and is disabled. The repaired run uses a new Chat; run history lists the new Run in that Chat, then the first Run as `cancelled` with no Chat and no trigger. The automation is bound to the new Chat; the old Chat returns HTTP 404 and the new one HTTP 200. The lifecycle events keep the earlier history and add exactly one `created` event for the new Chat with the next sequence ID.

## workflow-automations-064

- Vitest: "okou workflow automations > keeps lazy destinations distinct for workflows and owners of one public workflow"
- Mode: run
- Given: A Team-org owner has two workflows and, for each, a one-time schedule run now via `POST /api/workflow-automations/:id/run`; a second org member who completed onboarding has their own subscription model.
- When: The member creates and runs their own one-time automation on the owner's first workflow, reads run history, thread events and the owner's first Chat; the owner then demotes the workflow, and the member reads `GET /api/workflows/:workflowId/run-history` and runs their automation again.
- Then: The owner's two runs use two distinct Chats, each with one `created` event. The member's run uses a separate Chat; the member's run history shows only their Run and their lifecycle events show one `created` event with sequence 1, while the owner's Chat returns HTTP 404. After the demotion the member's run history and Run now both return HTTP 404, and the owner's lifecycle events are unchanged.

## workflow-automations-065

- Vitest: "okou workflow automations > spends one delegation hop per derived Automation and stops the chain at zero"
- Mode: run
- Given: A Pro member with a Runner group has a maximum autonomy budget of 2 and owns a workflow. The member creates a root hourly loop; its Run's Okou token creates a first derived loop, whose Run creates a second derived loop, each previous Run being cancelled.
- When: The second derived Run's Okou token creates another loop, re-enables the disabled first derived automation, copies the workflow via `POST /api/workflows/:workflowId/copy`, and (after that Run is cancelled) runs the root automation now.
- Then: The create, enable and copy each return HTTP 409 with code `AUTONOMY_BUDGET_EXHAUSTED`; the workflow keeps three automations, the first derived one stays disabled, and the workspace workflow list is unchanged. The run-now request is accepted but the shared Chat records an `input.rejected` event with error `autonomy_budget_exhausted`, and only the root, first and second derived Runs are linked to inputs.

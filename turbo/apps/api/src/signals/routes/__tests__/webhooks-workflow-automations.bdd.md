# webhooks-workflow-automations

## webhooks-workflow-automations-001

- Vitest: "POST /api/webhooks/workflow-automations/:token > dispatches signed webhook deliveries and de-duplicates retries"
- Mode: run
- Given: A signed-in member of a Team-tier org (personal Fable subscription model) has a workflow and a configured Runner group, and creates a `webhook-received` automation that returns a webhook URL and one-time secret.
- When: A caller posts an HMAC-signed JSON body with `X-Okou-Timestamp` and `X-Okou-Signature` to `POST /api/webhooks/workflow-automations/:token`, retries the identical delivery, and then posts another identical delivery twice concurrently.
- Then: The webhook URL path is `/api/webhooks/workflow-automations/<token>`. The first delivery returns HTTP 200 `{success: true, duplicate: false}` and dispatches one Run whose appended system prompt contains `okou slack message send --help` and not "Never use SLACK_TOKEN directly". The retry returns HTTP 200 `{success: true, duplicate: true}` and no second dispatch occurs. Of the concurrent pair, one returns `duplicate: false` and the other `duplicate: true`, and the Chat holds exactly one unrevoked `input.automation` event.

## webhooks-workflow-automations-002

- Vitest: "POST /api/webhooks/workflow-automations/:token > accepts a delivery whose launch is rejected and de-duplicates its retry"
- Mode: run
- Given: A signed-in member of a Team-tier org has a workflow, a configured Runner group, and a `webhook-received` automation; a first signed delivery has started a Run that occupies the automation's Chat.
- When: A second signed delivery is posted to `POST /api/webhooks/workflow-automations/:token`; then an admin deletes the `claude-code-oauth-token` model provider via `DELETE /api/me/model-providers/:type`, the first Run is cancelled and completes with exit code 1, and the second delivery is retried.
- Then: Both deliveries return HTTP 200 `{success: true, duplicate: false}` and the second remains queued as an `input.automation` event. After the first Run ends, the Chat contains an `input.rejected` event revoking the queued input with the same user message. The retry returns HTTP 200 `{success: true, duplicate: true}` and the Chat events are unchanged.

## webhooks-workflow-automations-003

- Vitest: "POST /api/webhooks/workflow-automations/:token > auto-disables only enabled webhooks after an effective Stripe downgrade"
- Mode: run
- Given: A signed-in member of a Team-tier org has a workflow with an enabled `webhook-received` automation and a second webhook automation disabled manually via `POST /api/workflow-automations/:id/disable`.
- When: Stripe sends a signed `customer.subscription.deleted` event for the org's subscription, and then a caller posts a signed delivery to the enabled automation's webhook URL.
- Then: The previously enabled automation reads back as `enabled: false` with `disabledReason: "paid_plan_required"`. The manually disabled automation stays disabled with `disabledReason` null. The webhook delivery returns HTTP 404.

## webhooks-workflow-automations-004

- Vitest: "POST /api/webhooks/workflow-automations/:token > keeps webhooks enabled through a scheduled cancellation period"
- Mode: run
- Given: A signed-in member of a Team-tier org has a workflow with an enabled `webhook-received` automation.
- When: Stripe sends a signed `customer.subscription.updated` event for the org's active subscription with `cancel_at_period_end: true` (previously false) and a period ending in one day.
- Then: The automation reads back via `GET /api/workflow-automations/:id` as enabled with `disabledReason` null.

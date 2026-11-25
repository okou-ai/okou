# org-member-cleanup-automations.bdd

## org-member-cleanup-automations.bdd-001

- Vitest: "Org member cleanup disarms the departing member's automations > removes a member with no automations while preserving another owner's automations"
- Mode: run
- Given: A Team workspace has a departing member with no automations and an admin who owns an enabled hourly loop schedule and an enabled `webhook-received` event automation.
- When: The admin removes the departing member via `DELETE /api/org/members` by email, then reads both of their own automations via `GET /api/workflow-automations/:id`.
- Then: The removal returns exactly `{ message: "Removed <email> from org" }`. The admin's schedule is still enabled with its original next run and hourly loop schedule, and the event automation is still enabled.

## org-member-cleanup-automations.bdd-002

- Vitest: "Org member cleanup disarms the departing member's automations > disables automations and stops event dispatch for the departing owner alone"
- Mode: run
- Given: A Team workspace's departing owner and a peer admin each own an hourly loop schedule and a `webhook-received` event automation; the departing person also owns the same pair in a second workspace. A signed delivery to the departing owner's automation webhook has been accepted (HTTP 200).
- When: The peer admin removes the departing owner via `DELETE /api/org/members`; then signed deliveries are posted to `POST /api/webhooks/workflow-automations/:token` for the departing owner's automation and for their second-workspace automation, and admins read the automations.
- Then: The removal returns `{ message: "Removed <email> from org" }`. The departing owner's webhook delivery now returns HTTP 404 while the second-workspace delivery returns HTTP 200. The departing owner's schedule reads `kind: schedule`, `enabled: false`, with its original next run and hourly loop config, and their event automation reads `kind: event`, `webhook-received`, `enabled: false`. The peer admin's two automations and the second-workspace event automation remain enabled.

## org-member-cleanup-automations.bdd-003

- Vitest: "Org member cleanup disarms the departing member's automations > disarms the same automations when Clerk reports the membership deleted"
- Mode: run
- Given: A Team workspace's departing owner has an hourly loop schedule and a `webhook-received` event automation, a signed delivery to it has been accepted (HTTP 200), and an auditor admin belongs to the workspace.
- When: Clerk delivers a signed `organizationMembership.deleted` webhook for the owner to `POST /api/webhooks/clerk`; after background cleanup a signed delivery is posted to the automation's webhook URL and the auditor reads both automations.
- Then: The schedule reads disabled, the webhook delivery returns HTTP 404, and the event automation reads `kind: event`, `webhook-received`, `enabled: false`.

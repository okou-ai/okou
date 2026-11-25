# workflow-webhook-lock

## workflow-webhook-lock-001

- Vitest: "webhook credential preparation lock isolation > publishes concurrent webhook credentials through one shared conversation"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and has one unrelated chat Thread.
- When: The member sends two concurrent `POST /api/workflows/:workflowId/automations` requests with `kind: "event"` and `eventType: "webhook-received"`, reveals each secret via `POST /api/workflow-automations/:id/webhook-secret`, reads the Thread feed `GET /api/chat-threads/events`, and lists `GET /api/workflows/:workflowId/automations`.
- Then: Both creations return HTTP 201 with the same `chatThreadId`, distinct Automation IDs and distinct webhook URLs. Each reveal returns HTTP 200 with fields matching its creation response. The feed shows exactly 2 Threads including the shared one, and the list contains exactly the two Automations.

## workflow-webhook-lock-002

- Vitest: "webhook credential preparation lock isolation > rebuilds the shared conversation without re-enabling a deleted conversation's webhook"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and has created a webhook Automation, whose Thread the member then deletes via `DELETE /api/chat-threads/:id`.
- When: The member creates another webhook Automation via `POST /api/workflows/:workflowId/automations`, lists `GET /api/workflows/:workflowId/automations`, and reveals the new secret via `POST /api/workflow-automations/:id/webhook-secret`.
- Then: Creation returns HTTP 201 with a new Thread different from the deleted one. The list shows the first Automation with `enabled: false` and the new one with `enabled: true`, both bound to the new Thread. The reveal matches the creation response, and the Thread feed shows 2 Threads.

## workflow-webhook-lock-003

- Vitest: "webhook credential preparation lock isolation > allows unrelated chat writes while KMS call 1 is stalled"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and an unrelated chat Thread. Secret encryption stalls on its first KMS call while a webhook Automation is being created via `POST /api/workflows/:workflowId/automations`.
- When: While KMS is stalled the member renames the unrelated Thread via `POST /api/chat-threads/:id/rename`, reads the Thread feed and lists the Workflow's Automations; then KMS resumes.
- Then: The rename appears in the feed with the new title, the Automation list is empty and the feed has 1 Thread. After KMS resumes, creation returns HTTP 201 with a Thread, the feed has 2 Threads, and the revealed secret matches the creation response.

## workflow-webhook-lock-004

- Vitest: "webhook credential preparation lock isolation > allows unrelated chat writes while KMS call 2 is stalled"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and an unrelated chat Thread. Secret encryption stalls on its second KMS call while a webhook Automation is being created via `POST /api/workflows/:workflowId/automations`.
- When: While KMS is stalled the member renames the unrelated Thread via `POST /api/chat-threads/:id/rename`, reads the Thread feed and lists the Workflow's Automations; then KMS resumes.
- Then: The rename appears in the feed with the new title, the Automation list is empty and the feed has 1 Thread. After KMS resumes, creation returns HTTP 201 with a Thread, the feed has 2 Threads, and the revealed secret matches the creation response.

## workflow-webhook-lock-005

- Vitest: "webhook credential preparation lock isolation > rejects creation when the public workflow becomes private during KMS preparation"
- Mode: run
- Given: A Team-tier workspace admin owns public Workflow `revocable-webhook`. A workspace member starts creating a webhook Automation on it via `POST /api/workflows/:workflowId/automations`, and the first KMS call stalls.
- When: The admin demotes the Workflow via `POST /api/workflows/:workflowId/demote`, KMS resumes, and the admin then republishes it via `POST /api/workflows/:workflowId/publish`.
- Then: The demotion returns HTTP 200 and the creation returns HTTP 404. After republishing (HTTP 200), the member's Automation list for the Workflow is empty and the member's Thread feed is empty.

## workflow-webhook-lock-006

- Vitest: "webhook credential preparation lock isolation > rejects creation after a downgrade commits while KMS is stalled"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and an unrelated chat Thread. The first KMS call stalls while a webhook Automation is being created.
- When: Stripe delivers `customer.subscription.deleted` for the workspace subscription to `POST /api/webhooks/stripe`, then KMS resumes.
- Then: The Stripe webhook returns HTTP 200 and the creation returns HTTP 402 with error code `TEAM_REQUIRED`. The Automation list is empty and the Thread feed has only the 1 unrelated Thread.

## workflow-webhook-lock-007

- Vitest: "webhook credential preparation lock isolation > creates no automation or thread when KMS call 1 fails"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and an unrelated chat Thread. KMS fails its first call with "KMS unavailable".
- When: The member sends `POST /api/workflows/:workflowId/automations` with `kind: "event"` and `eventType: "webhook-received"`.
- Then: The request returns HTTP 500, the Workflow's Automation list is empty, and the Thread feed still has only 1 Thread.

## workflow-webhook-lock-008

- Vitest: "webhook credential preparation lock isolation > creates no automation or thread when KMS call 2 fails"
- Mode: run
- Given: A signed-in member of a Team-tier workspace owns Workflow `webhook-lock-test` and an unrelated chat Thread. KMS fails its second call with "KMS unavailable".
- When: The member sends `POST /api/workflows/:workflowId/automations` with `kind: "event"` and `eventType: "webhook-received"`.
- Then: The request returns HTTP 500, the Workflow's Automation list is empty, and the Thread feed still has only 1 Thread.

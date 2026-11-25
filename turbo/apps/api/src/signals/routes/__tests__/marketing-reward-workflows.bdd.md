# marketing-reward-workflows

## marketing-reward-workflows-001

- Vitest: "retains the creator separately from the executor and the complete lineage after Workflow deletion"
- Mode: run
- Given: Marketing reward event delivery is configured. In a team-tier workspace an admin creates a Workflow with a private instruction, and an onboarded member with a personal model subscription executes it on an available Runner.
- When: The member runs the Workflow with `POST /api/workflows/:workflowId/run`, the sandbox reports completion twice to `POST /api/webhooks/run/complete`, and the admin deletes the Workflow.
- Then: The run reads back as `completed`. Exactly three version-4 events are delivered: `workflow.input-queued`, `workflow.run-created` and `workflow.run-completed`, each with the org, the member as `userId`, the Workflow ID, the admin as `creatorUserId` and a `sourceEventId`. The created and completed events carry the run ID and the queued event's `sourceEventId`, and all three event IDs are distinct.

## marketing-reward-workflows-002

- Vitest: "records event automation provenance but never certifies a failed Run or an ordinary Run that mounts a Workflow"
- Mode: run
- Given: Marketing reward event delivery is configured, and a team-tier workspace admin has an event-triggered Workflow automation and a Runner.
- When: The automation is triggered and its run completes with exit code 1, and the admin starts an ordinary chat run, which completes successfully.
- Then: Exactly two version-4 events are delivered, `workflow.input-queued` then `workflow.run-created`, the latter carrying the automation run ID and the admin as creator. No `workflow.run-completed` event is published for either run.

## marketing-reward-workflows-003

- Vitest: "continues publishing source facts after the creator has already earned the lifetime workflow reward"
- Mode: run
- Given: Marketing reward event delivery and settlement are configured, and a workspace admin owns a Workflow and a Runner.
- When: The admin runs the Workflow twice with `POST /api/workflows/:workflowId/run`; after each completion Marketing settles a 1000-credit workflow reward for the creator via `POST /api/internal/marketing/get-started/settlements`.
- Then: The first settlement receipt is `granted` and the second is `ineligible`. Six version-4 source events are delivered in total, including two `workflow.run-completed` events.

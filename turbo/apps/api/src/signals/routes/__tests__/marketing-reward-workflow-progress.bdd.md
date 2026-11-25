# marketing-reward-workflow-progress

## marketing-reward-workflow-progress-001

- Vitest: "refreshes the original Workflow creator from retained proof after failure and deletion without awarding credits"
- Mode: run
- Given: A Team workspace Workflow creator and a different member are present. The member launches the Workflow, its run-created event is retained by the rewards consumer, and the Run fails before the creator deletes the Workflow.
- When: The authorized marketing rewards consumer posts a version-1 development progress event referring to the retained proof.
- Then: The notification returns HTTP 200 and exactly one `getStartedRewardsChanged` publication goes to the original creator channel. The source observes that publication and does not inspect a credit balance.

# project-run-context

## project-run-context-001

- Vitest: "prepares queued inputs from current membership while preserving an already started Run and captured mentions"
- Mode: run
- Given: An entitled workspace member has a started Run in an unassigned thread. The member moves its thread into Launch and creates a second project named Original research.
- When: The member queues chat input referencing the second project, moves the thread to Latest launch and renames the referenced project Current research before the queued input launches. The member also tests an unavailable project reference and deletes Latest launch after the queued Run starts.
- Then: The unavailable reference returns HTTP 404. The valid input is accepted with HTTP 201 and chat history associates it with the subsequent Run. The first Run prompt remains unchanged. The new prompt contains the latest project ID, current and captured mention names and the all-results JSON instruction, and does not report Launch as current. Deletion returns HTTP 204 and the new Run prompt remains unchanged.

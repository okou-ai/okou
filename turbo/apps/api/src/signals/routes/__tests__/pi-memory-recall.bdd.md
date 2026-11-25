# pi-memory-recall

## pi-memory-recall-001

- Vitest: "ordinary Pi published personal Memory > reads the selected published version across Runs, independently of Suggestions and daily profile updates"
- Mode: run
- Given: A signed-in member uses a subscription Pi model and has native Memory initialized. A writer Run publishes a personal Memory version whose summary, index and detail file mention a harbor fact; another member of the same organization has their own empty Memory.
- When: The member turns proactive Suggestions off with `PUT /api/preferences/proactive-suggestions` (`enabled: false`), starts a recall Run with `gpt-6-luna`, queues another Run, publishes a newer version from a later writer while the recall Run's Pi session reads Memory, cancels the queued Run and starts a new Run; the other member starts their own Run and requests the first member's recall Run with `GET /api/runs/:id/context`.
- Then: Turning Suggestions off returns HTTP 200 with `enabled` false, and each writer Run completes. The recall Run mounts the selected version at `/home/user/.pi/agent/memory`; its first model request contains the selected summary and the `Personal Memory recall` section but not the detail fact, later requests read the index and the selected detail via 4 tool executions, and nothing from the newer version appears. The queued Run keeps the same Memory selection, and the next new Run selects the newer version. The other member gets HTTP 404 for the foreign Run context, receives a different, empty Memory root, sees none of the first member's facts, and at least one of their Memory tool reads reports an error.

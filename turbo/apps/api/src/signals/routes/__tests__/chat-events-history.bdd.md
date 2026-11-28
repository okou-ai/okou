# chat-events-history

## chat-events-history-001

- Vitest: "CHAT-02: incomplete-round context > injects incomplete rounds and truncates old content chronologically"
- Mode: run
- Given: An entitled workspace member has an initial completed native turn on a thread and can start further Runs.
- When: Two subsequent turns fail before completion, one with a long prompt, and the member retries in the same thread.
- Then: The first incomplete turn's dispatch has no prior incomplete-round section. The retry dispatch includes both failed turns in chronological order, marks their status as failed, truncates their long content, and keeps its own prompt intact. It has no native session or generation to resume and includes Chat recovery instructions. Completing the retry records its new session ID.

## chat-events-history-002

- Vitest: "CHAT-02: prior rounds and thread titles > leaves prior completed rounds to the session, generates the thread title, and accepts immutable follow-up revokes"
- Mode: run
- Given: An entitled workspace member starts a thread and the external text provider can generate a title and recommended follow-up for its first Run.
- When: The member sends and completes the first turn, continues it, manually renames the thread, and sends again. They then submit a recommended follow-up using an unrelated input ID and race two new client event IDs twice each against the same recommendation.
- Then: The provider receives bearer authorization and the configured title and follow-up model requests. The generated title strips markup, is generated once, and is superseded by the manual title. The continuation dispatch references the thread ID. The recommendation is persisted as a readable output event. The unrelated client ID returns HTTP 409. In the race both submissions using one ID return identical HTTP 201 responses, both competing submissions return HTTP 409, and replay preserves each outcome. Public history has exactly one event revoking the recommendation and a launched input event referencing that queued input.

## chat-events-history-003

- Vitest: "CHAT-02: prior rounds and thread titles > steers an active-run recommended follow-up"
- Mode: run
- Given: An entitled workspace member has a completed answer with a recommended follow-up and a further Run active on the same thread.
- When: The member sends the recommendation as a prompt with its output event ID and a new client event ID. The Sandbox polls for steering and acknowledges that input.
- Then: The request returns HTTP 201, polling returns the exact new event ID and prompt, and acknowledgement returns `steered`. Thread history contains the queued prompt revoking the recommendation and a separate steered prompt referencing that queued event and the active Run.

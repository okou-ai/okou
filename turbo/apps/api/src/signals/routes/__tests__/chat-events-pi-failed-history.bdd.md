# chat-events-pi-failed-history

## chat-events-pi-failed-history-001

- Vitest: "Pi failed native continuation > retains the actual native identity after a failed empty answer"
- Mode: run
- Given: A workspace owner has a personal `gpt-6-luna` Pi route and an existing thread whose first Run completed with its native Pi session.
- When: The owner sends another turn. The Sandbox posts initialization only, then reports a nonzero exit with that same native session and retries the completion callback. The owner sends a further turn.
- Then: Completion returns HTTP 200 with success true and status failed. The Run readback reports a failed Run with unknown failure reason and retains the Pi framework and thread session ID. Replaying completion leaves the result unchanged. The next dispatch resumes that session from the failed Run's native generation.

## chat-events-pi-failed-history-002

- Vitest: "Pi failed native continuation > retains the actual native identity after a failed partial answer"
- Mode: run
- Given: A workspace owner has a personal `gpt-6-luna` Pi route and an existing thread whose first Run completed with its native Pi session.
- When: The owner sends another turn. The Sandbox posts initialization and a partial answer, then reports a nonzero exit with the same native session and replays that completion. The owner sends a further turn.
- Then: Completion returns HTTP 200 with success true and status failed. Readback reports a failed Run with unknown failure reason and retains the Pi framework and thread session ID. The replay preserves the result, and the next dispatch resumes that session from the failed Run's native generation.

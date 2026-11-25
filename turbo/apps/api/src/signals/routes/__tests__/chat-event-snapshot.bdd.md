# chat-event-snapshot

## chat-event-snapshot-001

- Vitest: "chat event snapshot read endpoints > serves current Raw Event rows from cold-start and paired cursors"
- Mode: run
- Given: A signed-in workspace member owns a thread with two accepted Auto prompts, including a feedback part on the first input with a source event ID and range. The same user also has access to a different workspace.
- When: The owner requests raw chat event rows from sequence zero and then from the first row's paired sequence and event ID. The owner also submits mismatched cursor pairs. The user requests the rows and snapshot while signed into the other workspace.
- Then: The owner receives HTTP 200. Cold-start rows include the canonical feedback source and range. Paired pagination returns exactly the subsequent schema-valid rows for that thread, including the second prompt, and its cursor matches the final row. A mismatched first-row pair or an unknown higher sequence and ID returns HTTP 410 with `CHAT_EVENTS_EXPIRED` and "Chat events cursor has expired". Both other-workspace reads return HTTP 404 with `NOT_FOUND`.

# chat-events-message-queue

## chat-events-message-queue-001

- Vitest: "CHAT-02: queueing and recalling messages > steers rich inputs one at a time and settles concurrent declarations once"
- Mode: run
- Given: A workspace member has an active Run and submits one text input and one rich input containing a video request, file attachment and text.
- When: The Sandbox polls concurrently and retries, acknowledges the first input concurrently and repeats the acknowledgement, then polls and acknowledges the second.
- Then: All initial polls return the first event and prompt. Every acknowledgement returns `steered`, and the realtime provider receives an active-input hint. The next poll returns the second event with the video duration, file reference and text in order. The final poll returns null. Thread history has exactly one replacement for each input, both attached to the same active Run.

## chat-events-message-queue-002

- Vitest: "CHAT-02: queueing and recalling messages > steers a message into the running sandbox run by its source event id"
- Mode: run
- Given: An authenticated member has an active Sandbox Run and an input queued against its thread.
- When: The Sandbox polls and declares the queued event steered, completes the Run and redeclares it after completion.
- Then: Polling returns that event ID and prompt. Both declarations return `steered`. The completed thread contains exactly one replacement associated with the original Run, and no prompt launches a different Run.

## chat-events-message-queue-003

- Vitest: "CHAT-02: queueing and recalling messages > releases unconfirmed prompts before draining in FIFO order"
- Mode: run
- Given: A workspace member has an active Run and two queued inputs, one submitted before the other.
- When: The Sandbox reads the queue head without acknowledging it and completes. The member then recalls the later input.
- Then: Polling exposes the head. Completion allows that unconfirmed head to launch as a new Run before the later input. The later input has no replacement event yet and remains recallable with HTTP 201.

## chat-events-message-queue-004

- Vitest: "CHAT-02: queueing and recalling messages > applies the control payload limit without consuming an oversized prompt"
- Mode: run
- Given: An authenticated workspace member has an active Run and queues UTF-8 prompts sized to make the serialized Sandbox control message exactly the byte limit or exceed it.
- When: The Sandbox polls for and acknowledges the exact-limit message, then polls with the oversized message pending and the member recalls it.
- Then: The exact-limit poll returns that message with the expected serialized byte count. The oversized poll returns null and the oversized input has no consuming replacement event. Its recall succeeds with HTTP 201.

## chat-events-message-queue-005

- Vitest: "CHAT-02: queueing and recalling messages > queues, retries, and recalls messages behind an active run"
- Mode: run
- Given: An authenticated member has a Run active on a thread and a second member owns a different thread.
- When: The first member queues a message, changes their model preference and retries with the same client ID. The second member uses the same ID for a send on their thread. The owner recalls the queued message twice and then tries recalling a prompt already associated with a Run.
- Then: The queued sends return HTTP 201, leave one original queued input and do not change the thread model. The other user receives HTTP 201 for the duplicate and appends no events to their own thread. Both queued recalls are accepted. The Run-associated recall returns HTTP 400 with "Only queued user messages can be recalled". The active Run can still be cancelled and reads back cancelled.

## chat-events-message-queue-006

- Vitest: "CHAT-02: queueing and recalling messages > keeps a queued message when recall targets another owned thread"
- Mode: run
- Given: A workspace member owns a busy thread with a queued message and a separate thread.
- When: The member sends a recall for the queued message ID against the separate thread, then cancels the busy Run.
- Then: The test allows HTTP 201 or 400 for the cross-thread request. The original queued input still promotes to a new Run and its structured prompt renders as the original text, with null legacy content.

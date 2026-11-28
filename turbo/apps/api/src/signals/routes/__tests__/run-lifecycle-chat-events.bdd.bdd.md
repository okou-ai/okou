# run-lifecycle-chat-events.bdd

## run-lifecycle-chat-events.bdd-001

- Vitest: "HOOK-02: event-consumer dispatch failures > keeps Axiom trace failures outside the required event ACK"
- Mode: run
- Given: An entitled member with the Okou debug feature switch on has a running Run. The Axiom event ingest endpoint fails twice with 503 and then recovers.
- When: The sandbox posts one event batch via `POST /api/webhooks/run/events`, then a second batch.
- Then: Both event posts return HTTP 200. The first batch causes 2 failed ingest attempts without failing the acknowledgement, and the second batch makes the third, successful ingest request.

## run-lifecycle-chat-events.bdd-002

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > publishes authenticated assistant output to its chat thread"
- Mode: run
- Given: An entitled member on the native Runner route has a running chat Run.
- When: The sandbox posts an assistant text event via `POST /api/webhooks/run/events`, and the member lists the conversation events and searches chat for the text.
- Then: The conversation contains an event for the Run with content `authenticated assistant output`, and chat search returns the conversation with a matched `assistant` message for that Run with the same content.

## run-lifecycle-chat-events.bdd-003

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > uses DB output acknowledged before completion and ignores a late duplicate"
- Mode: run
- Given: An entitled member on the native Runner route has a running chat Run.
- When: The sandbox posts an assistant text event and completes the Run via `POST /api/webhooks/run/complete`, then posts a late assistant event with the same sequence number.
- Then: After completion exactly one `output.message` for the Run has the original text. The late event post returns HTTP 200, the original text remains, and the late text is never stored.

## run-lifecycle-chat-events.bdd-004

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > persists assistant events into the linked thread and swallows optional consumer failures"
- Mode: run
- Given: An entitled member on the native Runner route sent a chat message at a fixed time; the first realtime publish of a new assistant message fails.
- When: The sandbox posts an assistant event (sequence 1), a second assistant event, Codex `item.completed` items (reasoning, an agent message, a command and blank messages), a tool-use-only and an empty-text assistant event, and a duplicate of sequence 1 with different text; the member then cancels the Run.
- Then: The Run is `running` before dispatch and the execution's API start time equals the send time. The first message is stored with an ID derived from the Run and `event:1`; the second is stored despite the publish failure, and `chatThreadMessageCreated:<threadId>` is published. After the Codex items exactly three output messages exist including `Codex follow-up note`; tool-use and empty events add none. The duplicate leaves one row for that ID with the original text, and the Run becomes `cancelled`.

## run-lifecycle-chat-events.bdd-005

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > publishes one assistant event when acknowledgements race"
- Mode: run
- Given: An entitled member on the native Runner route has a running chat Run whose execution API start time equals the send time; realtime publishes for the conversation are held until both are in flight.
- When: The sandbox concurrently posts two assistant events with sequence numbers 0 and 1.
- Then: Both posts return HTTP 200 and the conversation contains both `Concurrent answer one` and `Concurrent answer two`.

## run-lifecycle-chat-events.bdd-006

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > records a Codex agent message as the first real assistant output"
- Mode: run
- Given: An entitled member uses native subscription models with `gpt-6-astra` selected and sent a chat message at a fixed time.
- When: The sandbox posts Codex `item.completed` items: a command execution, an agent message `First real Codex output`, and a blank agent message.
- Then: The execution uses the `codex` agent and its API start time equals the send time. Exactly one output message with content exists for the Run, `First real Codex output`, and `chatThreadMessageCreated:<threadId>` is published.

## run-lifecycle-chat-events.bdd-007

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > omits the api start for a chat input picked after a slot frees"
- Mode: run
- Given: The concurrent Run limit is 2. An entitled member on the native Runner route has two running chat Runs and a third input waiting.
- When: Two minutes later the first Run is cancelled and finishes, the waiting input launches, and the Runner reads its execution input.
- Then: The picked Run's execution has no API start time.

## run-lifecycle-chat-events.bdd-008

- Vitest: "HOOK-02/CHAT-02: assistant events reach optional chat consumers > publishes assistant content for a dispatched Run"
- Mode: run
- Given: An entitled member on the native Runner route has a dispatched chat Run.
- When: The sandbox posts an assistant text event via `POST /api/webhooks/run/events`.
- Then: The conversation contains an `output.message` for the Run with content `Mixed-version visible text`, and `chatThreadMessageCreated:<threadId>` is published.

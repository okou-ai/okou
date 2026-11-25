# chat-events-shared-queue

## chat-events-shared-queue-001

- Vitest: "CHAT-02: shared user message queue > dispatches idle-thread sends by appending a run-associated replacement"
- Mode: run
- Given: An entitled member sends a structured message to an idle thread, with a client event ID and a reference to another chat.
- When: The member sends it, repeats the send with the same ID, reads the events and claims the new Run.
- Then: The event stream contains the original structured prompt without a Run ID and exactly one higher-sequence replacement with a new ID, the original revoke reference, and the Run and selected-model annotation. Retry returns HTTP 201 for the same thread without adding a row. The message-created topic is published, and the dispatch retains the API start time and a rendered link to the referenced Chat.

## chat-events-shared-queue-002

- Vitest: "CHAT-02: shared user message queue > launches the FIFO head of overlapping idle sends and steers the other input"
- Mode: run
- Given: An entitled member owns an idle thread and has two different client event IDs and prompts.
- When: The member sends both concurrently and then the resulting Sandbox polls and acknowledges a steerable input.
- Then: Both originals commit. Exactly one Run starts from the lower-sequence input, and dispatch receives that prompt. The later input is available for steering by exact ID and prompt, then a subsequent poll is empty.

## chat-events-shared-queue-003

- Vitest: "CHAT-02: shared user message queue > skips a recalled queue head when dispatching a later idle Web send"
- Mode: run
- Given: A member has a thread with a running anchor and an older queued input.
- When: The owner recalls the queued head and sends further input when the anchor is no longer running.
- Then: The later accepted input gets a Run-associated replacement. The recalled input does not get a replacement for that Run.

## chat-events-shared-queue-004

- Vitest: "CHAT-02: shared user message queue > persists user-forwarded run provenance across chat threads"
- Mode: run
- Given: An entitled member owns a source Run with depleted delegation capacity and an accessible target thread for human forwarding.
- When: The member forwards selected content to the target using the source Run ID, then tries an unknown source and an unknown target.
- Then: The accepted input retains the source Run and thread and the captured title. The dispatched system guidance identifies person-forwarded content, supplies both source IDs and has one user-info section with the member's email. An unknown source returns HTTP 400 "Forward source run not found"; an unknown target returns HTTP 404 "Chat thread not found".

## chat-events-shared-queue-005

- Vitest: "CHAT-02: shared user message queue > preserves the source run when forwarding between chats"
- Mode: run
- Given: An entitled user has a source Run able to delegate and owns several target chats. Its title can change between sends and workspace capacity can become full.
- When: The source sends one delegation immediately and queues a second after rename and slot exhaustion. The member also forwards from the source and tries injecting a forged source reference. A slot later frees.
- Then: Each accepted handoff retains the authentic source Run and thread, with its title snapshot at the relevant send. The target guidance supplies source IDs and history lookup commands, while source guidance remains without a trigger section. The forged reference returns HTTP 400 with "Forwarded chat references are server-managed" and appends no event. The queued delegation launches when capacity becomes available.

## chat-events-shared-queue-006

- Vitest: "CHAT-02: shared user message queue > keeps Web context and tools for agent prompts sent into existing threads"
- Mode: run
- Given: A workspace member has a source Run token and an existing Web Chat thread whose session may rotate or contain an incomplete previous turn.
- When: The source agent sends prompts into existing threads in those states and the resulting Runs launch.
- Then: The rotated Run retains source Run and thread provenance, the agent prompt, Web file guidance, cross-integration messaging guidance and Web image upload instructions. The incomplete-session case retains the incomplete prompt in its recovery context and also keeps Web file tools.

## chat-events-shared-queue-007

- Vitest: "CHAT-02: shared user message queue > blocks cross-thread delegation from a zero-budget run"
- Mode: run
- Given: An entitled member starts a root Run with one allowed delegation and a delegated Run uses that budget.
- When: The delegated Run submits a further cross-thread send under its own Run token.
- Then: Enqueue returns HTTP 201 for the target thread. At pick time the input is rejected once and a single output error reports `autonomy_budget_exhausted`.

## chat-events-shared-queue-008

- Vitest: "CHAT-02: shared user message queue > derives real-agent preview mode when queued messages are claimed"
- Mode: run
- Given: An entitled member has a busy thread, may toggle real-agent preview behavior and has an attachment available.
- When: The member queues preview prompts, changes the setting before each input is claimed and lets both Runs dispatch.
- Then: The dispatch claimed with real-agent preview enabled contains the original prompt and attachment and sets the preview flag. The later mock-preview dispatch has its original prompt and no real-agent flag.

## chat-events-shared-queue-009

- Vitest: "CHAT-02: shared user message queue > projects additional info and inline templates into queued web launch material"
- Mode: run
- Given: An entitled member has a busy Web Chat and an illustration style can accompany a queued image request.
- When: The member queues structured additional image settings and the template while the thread is busy, then releases the blocking Run.
- Then: The promoted Run's prompt includes the image request, 1:1 aspect ratio and numbered inline marker. Its guidance identifies Web, the exact Chat thread and the selected illustration style. The Runner receives the same prompt and guidance as the captured Run.

## chat-events-shared-queue-010

- Vitest: "CHAT-02: shared user message queue > appends a claimed queued message after messages that are still queued"
- Mode: run
- Given: An entitled member has an active thread with two queued prompts.
- When: The active Run ends and the first queued input is claimed while the second is still waiting.
- Then: The first input's claimed replacement is appended later than the original. After event replacement the visible order is the second queued prompt followed by the first prompt's claim.

## chat-events-shared-queue-011

- Vitest: "CHAT-02: shared user message queue > keeps a queued send drainable when thread-list publication fails"
- Mode: run
- Given: An entitled member has a busy thread and the realtime provider fails the thread-list notification for a queued send.
- When: The member sends an input, retries with the same ID and lets the anchor terminate.
- Then: Both sends return HTTP 201 for the same thread. The failure does not block acceptance or drain, and the retry makes no second thread-list publication. The queued input subsequently gets a Run.

## chat-events-shared-queue-012

- Vitest: "CHAT-02: shared user message queue > appends replacements on auto-send and keeps queued recalls idempotent"
- Mode: run
- Given: An entitled member has an active Run with two pending messages, one intended for recall.
- When: The owner recalls the designated input repeatedly, then lets the active Run finish and reads the subsequent events with paired cursors.
- Then: Only the retained input launches. The original remains in history without a Run, and its later replacement has the original revoke reference, null legacy content and the original rendered text. Paired paging includes that replacement, a thread message is published and the promoted prompt excludes the recalled text from recovery context.

## chat-events-shared-queue-013

- Vitest: "CHAT-02: shared user message queue > waits when a fresh cancellation recovery is the only dispatch blocker"
- Mode: run
- Given: A member has cancelled a running Run and recovery is still awaiting its terminal callback.
- When: The member sends a new prompt while cancellation recovery is the only blocker, then lets the Sandbox deliver its end-of-Run callback.
- Then: The new prompt is accepted but no Run-associated replacement appears before recovery. Once the callback completes the queued input launches.

## chat-events-shared-queue-014

- Vitest: "CHAT-02: shared user message queue > auto-fires queued messages after cancellation recovery completes"
- Mode: run
- Given: A member owns a running thread with a previously queued prompt.
- When: The member cancels the active Run and then the Sandbox reports its completion.
- Then: Readback becomes cancelled before promotion and the queued input has no replacement at that point. The end callback automatically launches it. The original stays without a Run and the replacement has null legacy content and the original display text, which is also readable in the successor Run.

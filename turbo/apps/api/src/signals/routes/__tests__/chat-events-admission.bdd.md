# chat-events-admission

## chat-events-admission-001

- Vitest: "CHAT-02: on-demand member memory initialization > initializes an existing member's memory from preferences before the member's first run"
- Mode: run
- Given: A workspace member has personal Fable available, existing preferences for Asia/Tokyo and Japanese, and no initialized Memory.
- When: The member reads preferences twice, initializes with different timezone and locale, sends their first prompt, repeats initialization and sends again.
- Then: Both initial reads show Memory uninitialized. Initialization returns HTTP 200 and keeps Tokyo and Japanese while marking Memory initialized. The first Runner gets the member's empty Memory mount. After repeat initialization a second Run mounts the same empty storage and version.

## chat-events-admission-002

- Vitest: "CHAT-02: web chat send and client ids > dispatches an uppercase client Chat id with the canonical Runner reuse key"
- Mode: run
- Given: An entitled member supplies their Chat UUID using uppercase characters.
- When: The member sends a new Chat prompt with that client thread ID.
- Then: The Runner dispatch's thread reuse key uses the canonical lowercase UUID.

## chat-events-admission-003

- Vitest: "CHAT-02: web chat send and client ids > keeps one input and one launch when the first web send races its retry"
- Mode: run
- Given: An entitled Web member supplies a stable client thread ID and event ID for their first prompt.
- When: The member submits two identical requests concurrently.
- Then: Both return HTTP 201 and the same thread ID. Public thread history has one event with the submitted ID and one associated launched replacement. The Run readback preserves the original prompt.

## chat-events-admission-004

- Vitest: "CHAT-02: web chat send and client ids > creates a web chat run with client-provided ids"
- Mode: run
- Given: An entitled Web member supplies fresh client thread and event IDs.
- When: The member sends a prompt and later tries injecting MCP source annotations on fresh and repeated IDs. They also try sending with a client thread ID already used by a separately pre-created empty thread.
- Then: The first response is HTTP 201 with the supplied thread ID and a creation timestamp. Web dispatch contains the original prompt and Web context. Thread history keeps one original structured event without Run or revoke IDs and one Run-associated replacement; both use null legacy content. Thread readback starts with no read watermark or recovery pending. Forged MCP annotations return HTTP 400 even on replay. The occupied client thread ID returns HTTP 400 with "Client thread id is already in use".

## chat-events-admission-005

- Vitest: "CHAT-02: web chat send and client ids > requires authentication and accepts a member without a default executor"
- Mode: run
- Given: One client is unauthenticated, and another is a signed-in member without a default executor.
- When: Both send the same Chat prompt.
- Then: The unauthenticated client receives HTTP 401 `UNAUTHORIZED`. The member's input is accepted with HTTP 201 and a thread ID.

## chat-events-admission-006

- Vitest: "CHAT-02: web chat send and client ids > authorizes existing-thread sends by owner"
- Mode: run
- Given: A workspace member owns an empty thread and another member shares the workspace.
- When: The peer tries a send first, then the owner sends a prompt with a client event ID.
- Then: The peer's send returns HTTP 404 "Chat thread not found" and leaves history empty. The owner's HTTP 201 send appends an input with the supplied ID.

## chat-events-admission-007

- Vitest: "CHAT-02: interrupting active chat runs > interrupts an active run, guards interrupt ids, and feeds cancelled rounds into the next run"
- Mode: run
- Given: An entitled member owns a running Chat Run and another actor lacks access. Later the owner directly cancels a second Run on that thread.
- When: The foreign actor tries interrupting the first Run. The owner interrupts using an uppercase Run ID, repeats with both the same and a new client event ID, and attempts to reuse the interrupt ID for a normal send. The owner tries interrupting the directly cancelled Run and then starts another turn.
- Then: The foreign attempt returns HTTP 404. The valid interrupt publishes cooperative cancel and produces one interrupt row with canonical Run ID and one cancelled terminal marker despite replays. Reusing its event ID enqueues no new text, and a late interrupt of the separately cancelled Run returns HTTP 400. The new dispatch includes both cancelled prompts and cancellation statuses in its incomplete-round context.

## chat-events-admission-008

- Vitest: "CHAT-02: dispatch failure > rejects the picked input and releases the lease when run preparation cannot configure dispatch"
- Mode: run
- Given: An entitled member submits a prompt while no default executor is configured.
- When: The member sends, reads history and the Run list after preparation fails, then sends a second prompt after service configuration is restored.
- Then: The initial send returns HTTP 201 with a thread ID and creation time. History contains exactly one rejection and one adjacent output error marked internal error, with no Run ID, and the Run list is empty. The second send launches immediately once an executor is available.

## chat-events-admission-009

- Vitest: "CHAT-02: admission without spendable credits > blocks admission with request-branded guidance through visible chat messages"
- Mode: run
- Given: A signed-in member's subscription is suspended without spendable credits, and the current App origin is `https://app.okou.ai`.
- When: The member sends an Auto prompt, reads the resulting thread events and queue, and retries the same client event ID.
- Then: Both sends return HTTP 201 with the thread ID. The thread contains exactly the original queued row, its `insufficient_credits` rejection with no Run, and an adjacent error telling the user to buy more credits at the current App usage URL. Reading after the original cursor returns exactly the rejection and guidance. The retry adds nothing and active concurrency remains zero.

## chat-events-admission-010

- Vitest: "CHAT-02: admission without spendable credits > settles a send right after cancelling a pending run with one rejection"
- Mode: run
- Given: A paid member has a pending Run with dispatch signing delayed and their plan is then suspended.
- When: The member cancels the pending Run, releases signing and immediately sends a new prompt on the same thread.
- Then: Cancel returns HTTP 200 and the send returns HTTP 201. The thread ultimately contains exactly one replacement rejecting that client ID for insufficient credits.

## chat-events-admission-011

- Vitest: "CHAT-02: Okou Mail link delivery > delivers a linked Gmail draft exactly once through the agent reply"
- Mode: run
- Given: An entitled member has a connected Gmail account and an agent Run that can link an existing draft.
- When: The Run links the draft through the mail API, then the Sandbox replies with the returned URL and completes.
- Then: The link call returns HTTP 200 and fetches the exact draft with the connected Gmail bearer credential in full format. The URL has no assistant event before the reply; completion publishes exactly one assistant message containing the review URL for that Run.

## chat-events-admission-012

- Vitest: "CHAT-02: network body capture > carries a send's network body capture into the run the pick launches"
- Mode: run
- Given: An entitled member can start Chat Runs and choose whether their network bodies should be captured.
- When: The member sends one prompt with capture enabled, then sends another with the capture option omitted.
- Then: The first dispatched Run has capture enabled and the second has capture disabled.

## chat-events-admission-013

- Vitest: "CHAT-02: network body capture > carries a queued input's network body capture into a later pick"
- Mode: run
- Given: An entitled member has a queued Chat input with network-body capture enabled.
- When: A later pick launches the input and the Runner claims it.
- Then: The dispatch retains network-body capture enabled.

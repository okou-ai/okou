# chat-events-identity

## chat-events-identity-001

- Vitest: "CHAT-02: default assistant identity > uses the fixed Okou identity on immediate, queued and historical threads"
- Mode: run
- Given: An entitled workspace member can send Chat prompts in a production-style App and in an App with a different base URL.
- When: The member sends an initial prompt, queues another on the busy thread, completes the first Run to promote the queued turn, and sends on an existing thread after the App URL changes.
- Then: Every dispatch says "Your name is Okou." and carries the App URL for that environment. The dispatch token can read its own Run with HTTP 200 and matching ID. The queued event is accepted with HTTP 201 and the raw event identifies it as Web context. The promoted Run retains the same identity.

## chat-events-identity-002

- Vitest: "CHAT-02: run-scoped agent-token chat launches > preserves the caller's run annotation on immediate and queued handoffs"
- Mode: run
- Given: An authenticated workspace member has an active source Run whose agent token can start Chat work.
- When: Using that token, the caller creates another thread and sends a prompt on it, then queues a second handoff before cancelling the first child.
- Then: Creation and both sends return HTTP 201. The first input launches and the queued input promotes after cancellation. Public Run reads return the corresponding prompt and Run ID. Both launched prompt events refer to the source Run in a chat-thread annotation.

## chat-events-identity-003

- Vitest: "CHAT-02/FILE-03: computer-use host grants > grants computer-use capability only for a selected host"
- Mode: run
- Given: An authenticated workspace owner has a connected computer-use host and can send Chat prompts with or without a host selection.
- When: The owner sends without a host, explicitly selects an online host on a new thread, sends a subsequent prompt omitting the selection, clears with explicit null, then selects the same host when its heartbeat is stale and it subsequently reconnects.
- Then: The no-host token receives HTTP 403 for host write commands while it can still submit and recall Chat input with HTTP 201. The selected and sticky host Runs can issue host write commands with HTTP 200 and guidance gives the host's name without exposing its ID. Explicit null removes the grant and yields HTTP 403. The stale selection retains its guidance and becomes usable with HTTP 200 after heartbeat.

## chat-events-identity-004

- Vitest: "CHAT-02/FILE-03: computer-use host grants > rejects unusable computer-use host selections"
- Mode: run
- Given: A provisioned workspace member can select a computer-use host. One installation-backed host can stop and reconnect, another host can become stale, and a random host ID is unknown.
- When: The member explicitly selects the unknown host, binds the installation-backed host to a thread and stops it, sends to the stopped host and reconnects it, then sends explicitly and by sticky selection after the other host's heartbeat becomes stale.
- Then: The unknown selection returns HTTP 404 with "Computer-use host not found". The stopped installation-backed host remains bound and its continuation returns HTTP 201 with the same thread, then reconnects using the same host ID. Both stale-host sends are accepted with HTTP 201, including continuation on the sticky thread.

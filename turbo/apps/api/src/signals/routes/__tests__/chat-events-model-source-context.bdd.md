# chat-events-model-source-context

## chat-events-model-source-context-001

- Vitest: "chat send authorization, validation and cancellation > launches an uppercase client UUID and accepts its lowercase retry as the same input"
- Mode: run
- Given: An authenticated workspace owner can launch a Chat Run and provides a client UUID using uppercase letters.
- When: The member sends a prompt, reads its launched event and retries the request on the resulting thread with the equivalent lowercase UUID.
- Then: Both sends return HTTP 201. The event history normalizes the UUID to lowercase and shows one matching launched prompt with the same Run ID after retry.

## chat-events-model-source-context-002

- Vitest: "chat send authorization, validation and cancellation > rejects invalid model settings before resolving unavailable attachments"
- Mode: run
- Given: An entitled member owns a Claude Fable 5.1 thread and attachment lookup is unavailable.
- When: The member sends a prompt with that attachment and requests unsupported `xhigh` reasoning effort.
- Then: The send returns HTTP 400 `BAD_REQUEST` with "Reasoning effort is not supported by the selected model" and no thread events change.

## chat-events-model-source-context-003

- Vitest: "chat send authorization, validation and cancellation > does not enqueue when the caller aborts during attachment lookup"
- Mode: run
- Given: An entitled member owns a thread and object storage begins listing files for a submitted attachment.
- When: The caller aborts the Chat send while the attachment is being looked up.
- Then: The request resolves to HTTP 500 with "Internal server error". The thread event list remains exactly unchanged.

## chat-events-model-source-context-004

- Vitest: "chat send authorization, validation and cancellation > rejects an unknown model without changing thread events"
- Mode: run
- Given: An entitled organization member owns a thread with a prior cancelled Run.
- When: The member sends a new prompt explicitly selecting an unknown model and reads the event feed afterward.
- Then: The send returns HTTP 400 `BAD_REQUEST` naming the unknown model, and the event list remains exactly unchanged.

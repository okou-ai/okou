# chat-events-telemetry

## chat-events-telemetry-001

- Vitest: "chat enqueue telemetry failures > keeps an input claimable and its retry idempotent when timing delivery throws AbortError"
- Mode: run
- Given: An authenticated workspace member has paid capacity and a native execution route. Enqueue timing delivery to the external telemetry sink throws an `AbortError`.
- When: The member sends a prompt with a client event ID, then resends that prompt and ID on the resulting thread and reads the events again.
- Then: A Runner can claim the first send and receives the prompt. The retry returns HTTP 201 and the public thread event list is exactly the same as before the retry.

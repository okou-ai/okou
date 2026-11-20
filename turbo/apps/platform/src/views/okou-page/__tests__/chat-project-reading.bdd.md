# Chat project reading

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-project-reading.test.tsx](chat-project-reading.test.tsx).

## chat-project-reading-001

Original test `future Project references remain readable in a restored conversation and feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-project-reading.test.tsx#L16).

- **Given** A restored conversation contains a structured user message with a future Project reference named “Original launch” and feedback quoting “Check the schedule” that includes the same reference.
- **When** The conversation is loaded.
- **Then** The message displays “Original launch” as a link to that Project and displays “Check the schedule.”

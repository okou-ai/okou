# chat-events-concurrency-prefetch

## chat-events-concurrency-prefetch-001

- Vitest: "chat concurrency capacity prefetch > keeps the captured subscription limit while live occupancy queues and releases fresh picks"
- Mode: run
- Given: A paid workspace member has a base limit of one active Run plus one temporarily paid slot in its grace period, and one Run is holding the base slot. Object storage can return the member's file metadata but delays that response.
- When: The member sends a prompt with the file attached before the grace cutoff and the metadata arrives just after it. The member then sends another prompt after the cutoff and cancels the two active Runs one at a time.
- Then: The in-flight send launches using its captured paid slot, with the referenced file and text in the Run prompt. The later send waits while either existing Run occupies the only live slot. After the second cancel it gets a distinct Run ID and its original prompt.

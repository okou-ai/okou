# chat-events-pi-delegation

## chat-events-pi-delegation-001

- Vitest: "CHAT-02: model-first routing > preserves delegated Pi provenance and rejects foreign thread writes"
- Mode: run
- Given: An authenticated member owns a running Claude Fable Chat source and another thread in the same workspace, and has a personal Pi subscription route for `gpt-6-luna`. A different workspace, a different member in the same workspace and an unknown thread ID are also available.
- When: The source Run's agent bearer token sends a delegated prompt with a client event ID to the member's target thread. The Pi Run completes and the member reads the thread history. The same token submits sends to the cross-workspace, cross-member and unknown targets.
- Then: The owned target send returns HTTP 201 with the target thread and creation time, then the queued input is promoted to a Run. Its original prompt event includes a chat-thread reference to the source Run and thread with the title snapshot. Each foreign or unknown thread send returns HTTP 404.

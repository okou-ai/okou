# chat-events-pi-failures

## chat-events-pi-failures-001

- Vitest: "CHAT-02: model-first routing > continues an ordinary Pi stop through retained home without uploading an archive"
- Mode: run
- Given: An authenticated workspace owner can use personal `gpt-6-luna` through Pi on a fresh thread with retained Sandbox home.
- When: The owner sends a prompt, completes the first Sandbox Run, then sends a continuation and cancels it.
- Then: The first dispatch uses the thread ID as the Pi session ID. The continuation refers to that session and first Run's generation, omits the last complete answer from its system prompt, and makes no history blob uploads through either completion or cancellation.

## chat-events-pi-failures-002

- Vitest: "CHAT-02: model-first routing > preserves native subscription continuity and active input without a history transfer"
- Mode: run
- Given: An authenticated workspace owner has a completed Pi Run under a personal Codex subscription and a native session retained in Sandbox home.
- When: The owner starts another Run in the same thread and sends an additional input while it is active. The Sandbox polls twice for steering input, acknowledges it as steered and the owner reads thread events and usage.
- Then: The execution keeps its original prompt, resumes the previous Pi generation and omits the previous answer from its system guidance. No history blobs are uploaded. Both polls return the additional event ID and prompt, acknowledgement returns `steered`, readback contains exactly one event revoking the queued input, and the active Run has no terminal event with zero thread model credits charged so far.

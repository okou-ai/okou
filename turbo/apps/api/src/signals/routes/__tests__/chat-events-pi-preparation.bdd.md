# chat-events-pi-preparation

## chat-events-pi-preparation-001

- Vitest: "CHAT-02: model-first routing > launches an at-capacity Pi send on a fresh session once a slot frees"
- Mode: run
- Given: An authenticated workspace owner has a healthy Runner and one available run slot, which a Claude Fable Run occupies. The owner also configures personal `gpt-6-luna` for Pi.
- When: The owner sends a fresh Chat prompt selecting `gpt-6-luna` at capacity, then cancels the blocking Run using its Sandbox authorization.
- Then: The queued prompt launches when capacity becomes available. The Runner receives the original prompt, the new thread ID as the Pi session ID, and Pi launch schema version 2.

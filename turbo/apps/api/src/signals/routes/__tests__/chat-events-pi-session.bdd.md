# chat-events-pi-session

## chat-events-pi-session-001

- Vitest: "CHAT-02: personal subscription model selection > preserves one Pi session while selecting Luna, Sol, Luna, and Luna again"
- Mode: run
- Given: An authenticated workspace member has a personal Codex subscription usable by multiple Pi models.
- When: The member sends four turns on one thread, selecting `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol` and `gpt-6-luna` respectively and completing each through its Sandbox callbacks.
- Then: Each dispatch uses the selected model. The initial dispatch uses the thread ID as its Pi session ID, with `xhigh` thinking and no service tier, and all completions return the same nonempty native session ID.

## chat-events-pi-session-002

- Vitest: "CHAT-02: personal subscription model selection > preserves generations across Luna Pi and fast Astra Codex boundaries"
- Mode: run
- Given: An authenticated workspace member can run personal Luna in Pi and fast Astra in Codex on the same thread.
- When: The member completes a Luna turn, a fast Astra turn and another Luna turn, cancels a Luna follow-up, then completes another fast Astra turn and another Luna turn.
- Then: Fast Astra uses Codex's fast tier without Pi launch options. Switching frameworks omits the earlier completed text from system instructions and starts new native generations with Chat recovery guidance where tested. The same-framework Luna follow-up targets the preceding Luna generation and uses launch schema 2. A later Codex dispatch includes the cancelled prompt and cancellation marker. The completed Pi turns retain the canonical thread session ID. Public history lists each prompt and successful answer in order, with no answer for the cancelled turn, and the readbacks distinguish completed and cancelled Runs.

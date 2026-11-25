# chat-events-connector-selection

## chat-events-connector-selection-001

- Vitest: "thread connector selection > keeps active Run accounts and uses an allowed replacement for queued input"
- Mode: run
- Given: An authenticated workspace member has a Claude Fable model preference, a default OpenAI account, a second OpenAI account selected for a thread, and a selected Runtime account for the same thread.
- When: The member reads the thread selections, sends a message, and resolves connector headers from the resulting dispatch. While the Run is active, the member queues another message, disables the selected OpenAI account for the thread, reconnects the Runtime account with a new credential, and cancels the first Run to free the slot.
- Then: The selection read initially returns the selected OpenAI and Runtime accounts. The first dispatch contains nonempty credential references with the corresponding connection IDs and omits the raw secrets. Its authorized header resolution returns the selected account credentials. Disabling the OpenAI account returns the default account as current and the selection read reflects that change. The queued Run launches on the thread with references to the default OpenAI and reconnected Runtime accounts, still omits raw secrets, and resolves headers to their current credentials.

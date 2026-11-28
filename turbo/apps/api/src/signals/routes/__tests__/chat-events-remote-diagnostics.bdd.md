# chat-events-remote-diagnostics

## chat-events-remote-diagnostics-001

- Vitest: "claims exact-attempt SSH and VNC guidance"
- Mode: run
- Given: An authenticated workspace owner can dispatch a Chat Run.
- When: The owner asks the agent to explain a retained remote-operation failure and the Runner receives the execution guidance.
- Then: The guidance covers SSH and VNC and instructs the agent to use the failed operation's exact Attempt ID and known session ID when diagnosing. It explains how to verify the latest matching failure when only connection or session information is available, how to report unavailable exact evidence, why retained history supplies no current-connectivity or cause claim by itself, and that uncertain commands, input or checks must not be replayed automatically.

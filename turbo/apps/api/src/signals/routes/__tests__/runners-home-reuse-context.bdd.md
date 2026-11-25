# runners-home-reuse-context

## runners-home-reuse-context-001

- Vitest: "Execution home-reuse context > distinguishes current input, earlier Runs and another thread through dispatched input"
- Mode: run
- Given: A signed-in member selects Claude Fable and can start and complete Runs on an authorized Runner.
- When: The member starts a Run in a new thread, completes it, starts and completes another Run in that thread, and starts a Run in a different thread. The Runner reads each dispatched input.
- Then: The first and third inputs report `isFirstRun: true` and the second reports false. The completed Runs accept their sandbox-authenticated completion callbacks with HTTP 200.

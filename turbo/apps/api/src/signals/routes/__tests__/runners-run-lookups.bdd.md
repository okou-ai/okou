# runners-run-lookups

## runners-run-lookups-001

- Vitest: "Runner run lookup ownership > scopes active runtime synchronization to its owner without exposing terminal state"
- Mode: run
- Given: A workspace has a Run owner and a different member, each with a CLI token, and the requested built-in connector does not exist.
- When: The foreign member requests runtime synchronization before and after dispatch, then the owner requests it and the sandbox completes the Run. Both users retry synchronization after completion.
- Then: The foreign member gets HTTP 403 before and during execution, with `Run does not belong to user` during execution. The Runner receives the original prompt, first-Run status and Claude Code agent type. Owner synchronization while running returns HTTP 200 and exactly one absent result with reason `connector-unavailable`. Readback shows completion, after which the owner gets HTTP 409 with `RUN_TERMINAL` and the foreign member gets HTTP 404.

## runners-run-lookups-002

- Vitest: "Runner run lookup ownership > keeps completed and running lookups separate across distinct executions"
- Mode: run
- Given: An owner with a CLI token finishes a Claude Code Run and starts a distinct Run. The requested built-in connector is unavailable.
- When: The owner alternates runtime synchronization requests for the completed and new Runs and reads the new execution.
- Then: The completed Run consistently returns HTTP 409. The new Run has its own prompt and first-Run status, returns HTTP 200 with one absent connector result, and stays running.

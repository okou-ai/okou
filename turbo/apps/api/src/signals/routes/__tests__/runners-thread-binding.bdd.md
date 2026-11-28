# runners-thread-binding

## runners-thread-binding-001

- Vitest: "Runner first-start Thread binding > preserves native context when cancellation wins during execution preparation"
- Mode: run
- Given: A signed-in member has a Thread whose first `claude-fable-5-1` Run completed and initialized a native session. The member has personal instructions, and signing of execution content download URLs is held pending.
- When: The member sends a follow-up prompt to the Thread with `POST /api/chat/events`, sees the pending Run, cancels it with `POST /api/runs/:id/cancel` before signing is released, then sends another prompt to the Thread.
- Then: The Run reads `pending` before cancellation; the cancel returns HTTP 200 and the Run is never dispatched to the Runner. It reads back `cancelled` without `startedAt`, active concurrency is 0, and `GET /api/chat-threads/:id` shows `cancellationRecoveryPending` false. The next Run's native continuation resumes the Thread session with the first Run as its generation.

## runners-thread-binding-002

- Vitest: "Runner first-start Thread binding > preserves the preceding native context when a waiting input is recalled"
- Mode: run
- Given: A signed-in member has a Thread whose first `claude-fable-5-1` Run completed and initialized a native session. The concurrent Run cap is 1 and another Thread's Run occupies it.
- When: The member sends a prompt to the Thread with `POST /api/chat/events`, recalls it with a second send that revokes that input, the blocking Run completes through the sandbox callbacks, and the member sends another prompt to the Thread.
- Then: Both sends return HTTP 201. The next Run's native continuation still resumes the Thread session with the first Run as its generation.

## runners-thread-binding-003

- Vitest: "Runner first-start Thread binding > recovers Chat after a started Run is failed before initialization despite a late predecessor event"
- Mode: run
- Given: A signed-in member has a Thread whose first `claude-fable-5-1` Run completed and initialized a native session, and a second Run in the Thread has started with that continuation (row `failed`).
- When: A late native `init` event for the first Run posts to `POST /api/webhooks/run/events`, then the second Run reports `POST /api/webhooks/run/complete` with exit code 1 before native initialization, and the member sends another prompt to the Thread.
- Then: The second Run's input resumes the first Run's session. Both callbacks return HTTP 200, the second Run reads `failed` with a `startedAt`, and the next Run has no session or generation Run and a recovery prompt referencing `okou chat messages --output-dir /tmp/okou-chat-history`.

## runners-thread-binding-004

- Vitest: "Runner first-start Thread binding > recovers Chat after a started Run is cancelled before initialization despite a late predecessor event"
- Mode: run
- Given: A signed-in member has a Thread whose first `claude-fable-5-1` Run completed and initialized a native session, and a second Run in the Thread has started with that continuation (row `cancelled`).
- When: A late native `init` event for the first Run posts to `POST /api/webhooks/run/events`, the member cancels the second Run with `POST /api/runs/:id/cancel`, the second Run reports `POST /api/webhooks/run/complete` with exit code 1 before native initialization, and the member sends another prompt to the Thread.
- Then: The second Run's input resumes the first Run's session. The callbacks and cancel return HTTP 200, the second Run reads `cancelled` with a `startedAt`, and the next Run has no session or generation Run and a recovery prompt referencing `okou chat messages --output-dir /tmp/okou-chat-history`.

## runners-thread-binding-005

- Vitest: "Runner first-start Thread binding > retains initialized native context after a failed outcome"
- Mode: run
- Given: A signed-in member has a Thread whose first `claude-fable-5-1` Run completed and initialized a native session, and a second Run in the Thread has started with that continuation (row `failed`).
- When: The second Run posts a native `init` event with a new session ID to `POST /api/webhooks/run/events`, then reports `POST /api/webhooks/run/complete` with exit code 1, and the member sends another prompt to the Thread.
- Then: The second Run's input resumes the first Run's session. The callbacks return HTTP 200 and the next Run's native continuation uses the second Run's new session ID with the second Run as its generation.

## runners-thread-binding-006

- Vitest: "Runner first-start Thread binding > retains initialized native context after a cancelled outcome"
- Mode: run
- Given: A signed-in member has a Thread whose first `claude-fable-5-1` Run completed and initialized a native session, and a second Run in the Thread has started with that continuation (row `cancelled`).
- When: The second Run posts a native `init` event with a new session ID to `POST /api/webhooks/run/events`, the member cancels it with `POST /api/runs/:id/cancel`, it reports `POST /api/webhooks/run/complete` with exit code 1, and the member sends another prompt to the Thread.
- Then: The second Run's input resumes the first Run's session. The callbacks and cancel return HTTP 200 and the next Run's native continuation uses the second Run's new session ID with the second Run as its generation.

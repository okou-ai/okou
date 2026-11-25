# runner-cancellation

## runner-cancellation-001

- Vitest: "Run cancellation reconciliation > reconciles cooperative cancellation for a directly dispatched Run"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner (known group, Runner ID and heartbeat generation) and the sandbox holds the run's sandbox token.
- When: The sandbox reads `GET /api/runners/runs/:runId/cancellation` with the matching group and identity, then with another Runner group; the member cancels via `POST /api/runs/:id/cancel`; the sandbox reads again, acknowledges via `POST /api/webhooks/run/complete` (exit code 1, "Run cancelled") and reads once more.
- Then: The healthy read returns `{ protocolVersion: 1, runId, state: "present", mode: null }` with `Cache-Control: no-store`; the other group returns `state: "unavailable"`. After cancellation the read returns `state: "present", mode: "cooperative"`; after the acknowledgement the run reads `cancelled` and the cancellation read still returns `present`/`cooperative`.

## runner-cancellation-002

- Vitest: "Run cancellation reconciliation > isolates Run credentials and cancellation in the same workspace"
- Mode: run
- Given: Row `the same workspace`: one Pro member has two thread runs dispatched to the same Runner, each with its own sandbox token.
- When: The peer run's sandbox token reads `GET /api/runners/runs/:runId/cancellation` for the target run; the member cancels the target; the target sandbox acknowledges; the peer completes with exit code 1 "test execution failed" and reads its own cancellation state.
- Then: The cross-run read returns HTTP 401 `{ error: { code: "UNAUTHORIZED", message: "Not authenticated or runId mismatch" } }`. The target reads `present` with mode null before cancellation and `cooperative` after it and after the acknowledged `cancelled` status. The peer run becomes `failed` and its read returns `present` with mode null.

## runner-cancellation-003

- Vitest: "Run cancellation reconciliation > isolates Run credentials and cancellation in another workspace"
- Mode: run
- Given: Row `another workspace`: two Pro members in separate workspaces each have one thread run dispatched to the same Runner, each with its own sandbox token.
- When: The other workspace's sandbox token reads `GET /api/runners/runs/:runId/cancellation` for the target run; the target owner cancels; the target sandbox acknowledges; the peer completes with exit code 1 "test execution failed" and reads its own cancellation state.
- Then: The cross-run read returns HTTP 401 `{ error: { code: "UNAUTHORIZED", message: "Not authenticated or runId mismatch" } }`. The target reads `present` with mode null before cancellation and `cooperative` after it and after the acknowledged `cancelled` status. The peer run becomes `failed` and its read returns `present` with mode null.

## runner-cancellation-004

- Vitest: "Run cancellation reconciliation > recovers committed cooperative cancellation after publication fails"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner, and the realtime publisher fails the first cancellation publication.
- When: The sandbox reads `GET /api/runners/runs/:runId/cancellation`; the member cancels via `POST /api/runs/:id/cancel` twice; the sandbox reads again.
- Then: The first read returns `present` with mode null and `Cache-Control: no-store`. Both cancel requests return HTTP 200, and the subsequent read returns `{ protocolVersion: 1, runId, state: "present", mode: "cooperative" }`.

## runner-cancellation-005

- Vitest: "Run cancellation reconciliation > keeps the cancelled member Run visible to its sandbox"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner.
- When: The member cancels via `POST /api/runs/:id/cancel` and the sandbox reads `GET /api/runners/runs/:runId/cancellation`.
- Then: The read returns exactly `{ protocolVersion: 1, runId, state: "present", mode: "cooperative" }`.

## runner-cancellation-006

- Vitest: "Run cancellation reconciliation > does not mistake a present row with another group or Runner assignment for deletion"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner with a known group, Runner ID and heartbeat generation.
- When: The sandbox reads `GET /api/runners/runs/:runId/cancellation` with another group, another Runner ID, and the next heartbeat generation, then with the correct identity.
- Then: Each mismatched read returns HTTP 200 `{ protocolVersion: 1, runId, state: "unavailable" }`; the matching read returns `state: "present"` with mode null.

## runner-cancellation-007

- Vitest: "Run cancellation reconciliation > rejects missing, forged, agent-scope and wrong-Run credentials"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner, with a sandbox token and an agent-scope `OKOU_TOKEN`.
- When: `GET /api/runners/runs/:runId/cancellation` is requested with no authorization, a forged `vm0_sandbox_invalid` bearer, the agent `OKOU_TOKEN`, and the valid sandbox token against a random run ID.
- Then: Every request returns HTTP 401; the first three carry error code `UNAUTHORIZED`.

## runner-cancellation-008

- Vitest: "Run cancellation reconciliation > does not turn an expired token into a disappearance decision"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner, and the clock advances 3 hours and 1 second past dispatch.
- When: The sandbox reads `GET /api/runners/runs/:runId/cancellation` with its expired token, then reads again at the current time.
- Then: The expired read returns HTTP 401; the later read still returns `state: "present"` with mode null.

## runner-cancellation-009

- Vitest: "Run cancellation reconciliation > preserves ordinary Guest completion without inventing a hard stop"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner.
- When: The sandbox completes the run via `POST /api/webhooks/run/complete` with exit code 1 and "test execution failed", then reads `GET /api/runners/runs/:runId/cancellation`.
- Then: The read returns `state: "present"` with mode null.

## runner-cancellation-010

- Vitest: "Run cancellation reconciliation > persists hard cancellation on member revocation without depending on live membership"
- Mode: run
- Given: A Pro member has a thread run dispatched to a Runner and a signed Clerk webhook secret is configured.
- When: A signed `organizationMembership.deleted` event for the member's organization membership is posted to `POST /api/webhooks/clerk`, then the sandbox reads `GET /api/runners/runs/:runId/cancellation`.
- Then: The webhook returns HTTP 200 and the read returns `state: "present"` with mode `hard`.

## runner-cancellation-011

- Vitest: "Run cancellation reconciliation > retains the Run and its original Runner credential with hard cancellation after user.deleted"
- Mode: run
- Given: Row `user.deleted`: a Pro member has a dispatched thread run; a peer in the same organization, the same user in another organization, and a foreign user each also have a dispatched run. A signed Clerk webhook secret is configured.
- When: A signed `user.deleted` event for the member is posted to `POST /api/webhooks/clerk` twice; each sandbox reads `GET /api/runners/runs/:runId/cancellation` with its original credential.
- Then: The member's run reads exactly `{ protocolVersion: 1, runId, state: "present", mode: "hard" }`, unchanged after the replayed webhook. The same user's run in the other organization is `hard`; the same-organization peer and the foreign run stay `present` with mode null.

## runner-cancellation-012

- Vitest: "Run cancellation reconciliation > retains the Run and its original Runner credential with hard cancellation after organization.deleted"
- Mode: run
- Given: Row `organization.deleted`: a Pro member has a dispatched thread run; a peer in the same organization, the same user in another organization, and a foreign user each also have a dispatched run. A signed Clerk webhook secret is configured.
- When: A signed `organization.deleted` event for the member's organization is posted to `POST /api/webhooks/clerk` twice; each sandbox reads `GET /api/runners/runs/:runId/cancellation` with its original credential.
- Then: The member's run reads exactly `{ protocolVersion: 1, runId, state: "present", mode: "hard" }`, unchanged after the replayed webhook. The same-organization peer's run is `hard`; the same user's run in another organization and the foreign run stay `present` with mode null.

# run-phase-timing

## run-phase-timing-001

- Vitest: "current Run phase timing > gives the allowlisted owner three-point guidance and accepts legal raw observations"
- Mode: run
- Given: The allowlisted timing owner has a running chat Run on `claude-fable-5-1` and holds its Okou Run token.
- When: The Run posts phase marks to `POST /api/runs/current/phase-mark`: `generation-start` (report, no skip), `research-start`, `generation-start` (image, skip research), and `research-start` again.
- Then: The system prompt says the only AI phase marks are `research-start` and `generation-start` and that the successful completion callback supplies `completion-callback`. Every mark returns HTTP 202 with exactly `{ schemaVersion: 2, status: "accepted" }`.

## run-phase-timing-002

- Vitest: "current Run phase timing > gives the staff workspace member three-point guidance and accepts legal raw observations"
- Mode: run
- Given: A member of a staff workspace has a running chat Run on `claude-fable-5-1` and holds its Okou Run token.
- When: The Run posts phase marks to `POST /api/runs/current/phase-mark`: `generation-start` (report, no skip), `research-start`, `generation-start` (image, skip research), and `research-start` again.
- Then: The system prompt says the only AI phase marks are `research-start` and `generation-start` and that the successful completion callback supplies `completion-callback`. Every mark returns HTTP 202 with exactly `{ schemaVersion: 2, status: "accepted" }`.

## run-phase-timing-003

- Vitest: "current Run phase timing > keeps timing unavailable to a non-audience user with default settings"
- Mode: run
- Given: An ordinary user outside the timing audience, with default feature switch settings, has a running chat Run.
- When: The Run posts `research-start` and `generation-start` marks with its Run token.
- Then: The system prompt does not mention `okou run mark`, and both marks return HTTP 404 with `cache-control: no-store`.

## run-phase-timing-004

- Vitest: "current Run phase timing > keeps timing unavailable to a non-audience user with stored opt-in settings"
- Mode: run
- Given: An ordinary user outside the timing audience has stored the three-point timing switch as on and has a running chat Run.
- When: The Run posts `research-start` and `generation-start` marks with its Run token.
- Then: The system prompt does not mention `okou run mark`, and both marks return HTTP 404 with `cache-control: no-store`.

## run-phase-timing-005

- Vitest: "current Run phase timing > accepts a generation observation with the default skip declaration"
- Mode: run
- Given: The allowlisted timing owner has a running chat Run.
- When: The Run posts `POST /api/runs/current/phase-mark` with `generation-start`, kind `document`, and no skip declaration.
- Then: The request returns HTTP 202 with exactly `{ schemaVersion: 2, status: "accepted" }` and `cache-control: no-store`.

## run-phase-timing-006

- Vitest: "current Run phase timing > accepts late legal observations after the completion callback"
- Mode: run
- Given: The allowlisted timing owner has a chat Run that the sandbox has completed with a Claude reply.
- When: The Run token posts `research-start` and `generation-start` (report) marks after completion.
- Then: The Run reads `completed` and both marks return the accepted receipt.

## run-phase-timing-007

- Vitest: "current Run phase timing > accepts the originally issued Run token after the owner enables timing live"
- Mode: run
- Given: The allowlisted timing owner turned three-point timing off and started a chat Run.
- When: The Run posts `research-start`, the owner turns the switch on, and the same Run token posts `research-start` and `generation-start`.
- Then: The system prompt does not mention `okou run mark` and the first mark returns HTTP 404 with `cache-control: no-store`. After enabling, both marks return the accepted receipt.

## run-phase-timing-008

- Vitest: "current Run phase timing > honors a live kill switch for an already issued Run token"
- Mode: run
- Given: The allowlisted timing owner has a running chat Run.
- When: The Run posts `research-start`, the owner turns three-point timing off, and the Run posts `research-start` again.
- Then: The first mark returns the accepted receipt; the second returns HTTP 404 with `cache-control: no-store`.

## run-phase-timing-009

- Vitest: "current Run phase timing > reserves completion-callback for the authenticated Agent completion protocol"
- Mode: run
- Given: The allowlisted timing owner has a running chat Run.
- When: The Run posts a `completion-callback` mark, then a `generation-start` (report) mark.
- Then: The `completion-callback` mark returns HTTP 400, and the following `generation-start` mark is accepted.

## run-phase-timing-010

- Vitest: "current Run phase timing > requires kind and rejects caller-supplied identity and timestamps"
- Mode: run
- Given: The allowlisted timing owner has a running chat Run.
- When: The Run posts `generation-start` without a kind, `generation-start` with only `skipResearch`, `research-start` with a `runId`, and `research-start` with a `recordedAt`, then a plain `research-start`.
- Then: Each of the four malformed marks returns HTTP 400, and the plain `research-start` mark is accepted.

## run-phase-timing-011

- Vitest: "current Run phase timing > requires a signed Run credential rather than session, Sandbox or PAT credentials"
- Mode: run
- Given: The allowlisted timing owner has a running chat Run and a CLI personal access token.
- When: A `research-start` mark is posted with no credentials, then with a browser session, the sandbox token, and the personal access token.
- Then: The unauthenticated request returns HTTP 401, and each of the session, sandbox and personal access token requests returns HTTP 403.

# run-runner-startup.bdd

## run-runner-startup.bdd-001

- Vitest: "dedicated startup API persists sandbox through a pre-cleanup completion"
- Mode: run
- Given: Row `sandbox`: a signed-in chat user has a dispatched chat run whose startup path is not yet known, and the sandbox holds the run's sandbox token.
- When: The sandbox reports `PUT /api/runners/runs/:runId/startup` with `sandboxStartupPath: "sandbox"`, then completes the run through `POST /api/webhooks/run/complete` with `sandboxReuseResult: "reused"` and `homeReuseResult: "sandboxReused"`; the user reads `GET /api/runs/:id/runner` before and after.
- Then: The runner read returns `sandboxStartupPath: null` before the report and `sandbox` after it (HTTP 204 for the report). Completion returns HTTP 200 `{ success: true, status: "completed" }` and the runner read still shows `sandbox`.

## run-runner-startup.bdd-002

- Vitest: "dedicated startup API persists home through a pre-cleanup completion"
- Mode: run
- Given: Row `home`: a signed-in chat user has a dispatched chat run whose startup path is not yet known, and the sandbox holds the run's sandbox token.
- When: The sandbox reports `PUT /api/runners/runs/:runId/startup` with `sandboxStartupPath: "home"`, then completes the run through `POST /api/webhooks/run/complete` with `sandboxReuseResult: "poolMiss"` and `homeReuseResult: "reused"`; the user reads `GET /api/runs/:id/runner` before and after.
- Then: The runner read returns `sandboxStartupPath: null` before the report and `home` after it (HTTP 204 for the report). Completion returns HTTP 200 `{ success: true, status: "completed" }` and the runner read still shows `home`.

## run-runner-startup.bdd-003

- Vitest: "dedicated startup API persists blank through a pre-cleanup completion"
- Mode: run
- Given: Row `blank`: a signed-in chat user has a dispatched chat run whose startup path is not yet known, and the sandbox holds the run's sandbox token.
- When: The sandbox reports `PUT /api/runners/runs/:runId/startup` with `sandboxStartupPath: "blank"`, then completes the run through `POST /api/webhooks/run/complete` with `sandboxReuseResult: "poolMiss"` and `homeReuseResult: "cacheMiss"`; the user reads `GET /api/runs/:id/runner` before and after.
- Then: The runner read returns `sandboxStartupPath: null` before the report and `blank` after it (HTTP 204 for the report). Completion returns HTTP 200 `{ success: true, status: "completed" }` and the runner read still shows `blank`.

## run-runner-startup.bdd-004

- Vitest: "dedicated startup API persists cold through a pre-cleanup completion"
- Mode: run
- Given: Row `cold`: a signed-in chat user has a dispatched chat run whose startup path is not yet known, and the sandbox holds the run's sandbox token.
- When: The sandbox reports `PUT /api/runners/runs/:runId/startup` with `sandboxStartupPath: "cold"`, then completes the run through `POST /api/webhooks/run/complete` with `sandboxReuseResult: "poolMiss"` and `homeReuseResult: "cacheMiss"`; the user reads `GET /api/runs/:id/runner` before and after.
- Then: The runner read returns `sandboxStartupPath: null` before the report and `cold` after it (HTTP 204 for the report). Completion returns HTTP 200 `{ success: true, status: "completed" }` and the runner read still shows `cold`.

## run-runner-startup.bdd-005

- Vitest: "telemetry and completion leave startup unknown until an authenticated report"
- Mode: run
- Given: A signed-in chat user has a dispatched chat run and the sandbox holds its sandbox token.
- When: The sandbox posts `POST /api/webhooks/run/telemetry` with ready operations naming `blank`, a failed `cold` and a `home` of another action type, completes the run via `POST /api/webhooks/run/complete`, and later reports `PUT /api/runners/runs/:runId/startup` with `cold`.
- Then: After telemetry and after completion, `GET /api/runs/:id/runner` shows `sandboxStartupPath: null`. After the delayed startup report it shows `cold`.

## run-runner-startup.bdd-006

- Vitest: "same-value retries succeed and conflicting or telemetry reports cannot overwrite startup"
- Mode: run
- Given: A signed-in chat user has a dispatched chat run and the sandbox holds its sandbox token.
- When: The sandbox reports `PUT /api/runners/runs/:runId/startup` with `blank` twice, then `cold`; completes the run; reports `blank` again, then `home`; then posts telemetry with a `cold` ready operation.
- Then: Same-value `blank` reports return HTTP 204 before and after completion; the conflicting `cold` and `home` reports return HTTP 409. The runner read finally shows `sandboxStartupPath: "blank"`.

## run-runner-startup.bdd-007

- Vitest: "concurrent conflicting startup reports accept exactly one immutable fact"
- Mode: run
- Given: A signed-in chat user has a dispatched chat run and the sandbox holds its sandbox token.
- When: The sandbox sends two concurrent `PUT /api/runners/runs/:runId/startup` reports, one `blank` and one `cold`, then repeats the accepted value.
- Then: Exactly one report returns HTTP 204 and the other HTTP 409. `GET /api/runs/:id/runner` shows the accepted path, and repeating the accepted path returns HTTP 204.

## run-runner-startup.bdd-008

- Vitest: "startup writes and reads preserve Run token, user and organization boundaries"
- Mode: run
- Given: A signed-in chat user has a dispatched chat run and the sandbox holds its sandbox token; another member of the same organization and the same user under a different organization are also signed in.
- When: The startup report `PUT /api/runners/runs/:runId/startup` is sent with the sandbox token for a random run ID, without authorization, and with a Clerk session bearer; then with the sandbox token for the real run. Runner reads `GET /api/runs/:id/runner` are made by the other member, the user in another organization and an unauthenticated caller.
- Then: The random-run, missing-auth and Clerk-session reports return HTTP 401 and leave the startup path null; the valid report returns HTTP 204. The other member and other-organization reads return HTTP 404, the unauthenticated read returns HTTP 401, and the owner still reads `blank`.

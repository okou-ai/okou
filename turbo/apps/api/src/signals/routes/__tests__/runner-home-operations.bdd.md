# runner-home-operations

## runner-home-operations-001

- Vitest: "Runner sandbox operations without a Run > accepts GC from a real user Runner token and rejects unowned Run correlation"
- Mode: run
- Given: A user has approved a CLI device login and exchanged it for a real CLI access token.
- When: The CLI token posts `POST /api/webhooks/run/telemetry` with a Home image removal sandbox operation (no run), then again with the same operation correlated to a random run ID.
- Then: The run-less report returns HTTP 200 `{ success: true }`; the report correlated to an unowned run returns HTTP 401 with error code `UNAUTHORIZED`.

## runner-home-operations-002

- Vitest: "Runner sandbox operations without a Run > accepts authenticated GC without inventing a response Run"
- Mode: run
- Given: The official Runner secret is configured.
- When: The official Runner posts `POST /api/webhooks/run/telemetry` with `Bearer vm0_official_<secret>`, a Runner hostname and version, and a Home image removal operation without a run.
- Then: The response is HTTP 200 with exactly `{ success: true }`.

## runner-home-operations-003

- Vitest: "Runner sandbox operations without a Run > accepts known publication identity and a false first-run label from the official host"
- Mode: run
- Given: The official Runner secret is configured.
- When: The official Runner posts `POST /api/webhooks/run/telemetry` with a `runner_home_image_publication` operation (outcome `published`, reason `synced_commit`) carrying a random run ID, `is_first_run: false`, profile `default` and reuse key `thread:known`.
- Then: The response is HTTP 200 with exactly `{ success: true }`.

## runner-home-operations-004

- Vitest: "Runner sandbox operations without a Run > rejects invalid Runner credentials for unlinked operations"
- Mode: run
- Given: The official Runner secret is configured.
- When: `POST /api/webhooks/run/telemetry` with a run-less Home image removal operation is sent with `Bearer vm0_official_wrong-secret`, `Bearer unrecognized-token` and `Bearer clerk-session`.
- Then: Each request returns HTTP 401 with error code `UNAUTHORIZED`.

## runner-home-operations-005

- Vitest: "Runner sandbox operations without a Run > accepts settled startup source identity and candidate outcomes through the current endpoint"
- Mode: run
- Given: The official Runner secret is configured.
- When: The official Runner posts `POST /api/webhooks/run/telemetry` with a `runner_sandbox_startup` operation (random run ID, startup path `home`, Home reuse `reused`, not first run) and three `runner_home_image_consumption` operations with outcomes `selected` (cache hit), `busy` (active) and `unavailable`.
- Then: The response is HTTP 200 with exactly `{ success: true }`.

## runner-home-operations-006

- Vitest: "Runner sandbox operations without a Run > accepts unloaded inventory and Run-correlated admission through the normal Runner path"
- Mode: run
- Given: The official Runner secret is configured.
- When: The official Runner posts `POST /api/webhooks/run/telemetry` with two `runner_home_inventory` operations (unloaded `loading`, then loaded `assembled` with zero state counts) and a `runner_home_admission` operation deferred for `capacity_exhausted` correlated to a random run ID, all for one Runner ID and heartbeat generation 7.
- Then: The response is HTTP 200 with exactly `{ success: true }`.

## runner-home-operations-007

- Vitest: "Runner sandbox operations without a Run > requires Run attribution for metrics and system logs"
- Mode: run
- Given: The official Runner secret is configured.
- When: The official Runner posts `POST /api/webhooks/run/telemetry` with a run-less Home image removal operation plus an empty `metrics` list, and again plus a `systemLog` string.
- Then: Each request returns HTTP 400 with error code `BAD_REQUEST`.

# webhooks-agent-health-usage-telemetry

## webhooks-agent-health-usage-telemetry-001

- Vitest: "agent usage event webhook > requires an existing authenticated run for resource observations (mixed=false)"
- Mode: run
- Given: A sandbox token is signed for a random Run ID that has no existing Run, with the secrets encryption key configured.
- When: The sandbox calls `POST /api/webhooks/run/usage-event` for that Run ID with a single `x-resource-v1` X `posts.read` resource observation, then repeats the call naming a different Run ID than its token.
- Then: The first call returns HTTP 404 with error code `NOT_FOUND`. The mismatched Run ID call returns HTTP 401 with error code `UNAUTHORIZED`.

## webhooks-agent-health-usage-telemetry-002

- Vitest: "agent usage event webhook > requires an existing authenticated run for resource observations (mixed=true)"
- Mode: run
- Given: A sandbox token is signed for a random Run ID that has no existing Run, with the secrets encryption key configured.
- When: The sandbox calls `POST /api/webhooks/run/usage-event` for that Run ID with a mixed batch: a plain X `tweet.read` usage event of quantity 2 and an `x-resource-v1` `posts.read` resource observation. It then repeats a resource-only call naming a different Run ID than its token.
- Then: The first call returns HTTP 404 with error code `NOT_FOUND`. The mismatched Run ID call returns HTTP 401 with error code `UNAUTHORIZED`.

## webhooks-agent-health-usage-telemetry-003

- Vitest: "agent usage event webhook > rejects a usage quantity above the exact integer range"
- Mode: run
- Given: A sandbox token is signed for a Run ID.
- When: The sandbox calls `POST /api/webhooks/run/usage-event` with an X `tweet.read` usage event whose quantity is `Number.MAX_SAFE_INTEGER + 1`.
- Then: The request is rejected with HTTP 400.

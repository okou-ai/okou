# hooks-ops.bdd

## hooks-ops.bdd-001

- Vitest: "OPS-02: API health and auth boundary > returns public build info with a configured commit SHA"
- Mode: run
- Given: The deployment is configured with commit SHA `0123456789abcdef0123456789abcdef01234567`; the caller is unauthenticated.
- When: The caller requests `GET /api/build-info`.
- Then: The API responds with HTTP 200, exactly `{ commitSha: <that SHA>, version: <API package version> }`, and `Cache-Control: no-store`.

## hooks-ops.bdd-002

- Vitest: "OPS-02: API health and auth boundary > returns null build info for local commit placeholders"
- Mode: run
- Given: The deployment's commit SHA is the local placeholder `local-dev`; the caller is unauthenticated.
- When: The caller requests `GET /api/build-info`.
- Then: The API responds with HTTP 200, exactly `{ commitSha: null, version: <API package version> }`, and `Cache-Control: no-store`.

## hooks-ops.bdd-003

- Vitest: "OPS-02: API health and auth boundary > checks public health and the auth boundary through HTTP routes"
- Mode: run
- Given: An unauthenticated caller, and a signed-in workspace member known to the identity provider.
- When: The unauthenticated caller requests `GET /health` and `GET /api/auth/me`, and the member requests `GET /api/auth/me`.
- Then: Health returns HTTP 200 with exactly `{ status: "ok" }`. The unauthenticated identity read returns HTTP 401 with error code `UNAUTHORIZED`. The member's read returns HTTP 200 with their `userId`, `orgId`, and `email`.

## hooks-ops.bdd-004

- Vitest: "OPS-01: feature switch routes > updates, reads, merges, and deletes feature switch overrides through API"
- Mode: run
- Given: A signed-in member with no stored feature switch overrides.
- When: The member reads `GET /api/feature-switches`, sets `_dummy: false` and then `_dummy: true` with `POST /api/feature-switches`, reads again, deletes with `DELETE /api/feature-switches`, and reads once more.
- Then: Initially `_dummy` is not stored. The first update stores it as `false` and the second as `true`; the read returns the same stored switches as the second update. The delete returns exactly `{ deleted: true }`, after which `_dummy` is not stored.

## hooks-ops.bdd-005

- Vitest: "OPS-01: feature switch routes > stores org-scoped feature switch overrides separately from personal overrides"
- Mode: run
- Given: An owner and a peer belong to the same workspace, and an outsider belongs to another workspace.
- When: The owner sets `larkIntegration: true` and `_dummy: false`; the peer and outsider read `GET /api/feature-switches`; the peer sets `larkIntegration: false`; the owner reads; the owner sends `DELETE /api/feature-switches`; the peer reads again.
- Then: The owner's update stores `larkIntegration: true` and `_dummy: false`. The peer sees `larkIntegration: true` but no `_dummy`; the outsider sees no `larkIntegration`. The peer's update stores `larkIntegration: false` without `_dummy`, and the owner then reads `larkIntegration: false` and `_dummy: false`. The delete returns exactly `{ deleted: true }`, after which the peer has neither key stored.

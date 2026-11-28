# cron-connector-catalog-v4

## cron-connector-catalog-v4-001

- Vitest: "connector catalog v4 preparation > keeps a Run operational without exposing a selected connector that has no usable firewall"
- Mode: run
- Given: A user who can run chat agents with a personal Claude token; the connector catalog source publishes a valid v4 release containing an HTTP connector `catalog-service` (manual `api-token`, no firewall) and an MCP connector.
- When: The cron calls `GET /api/cron/sync-connector-catalog` with the cron secret; the user connects `catalog-service` with credential `unusable-native-token` via `POST /api/connectors/catalog-service/manual-grant`, starts a chat run, the sandbox requests the model credential from `POST /api/webhooks/run/firewall/auth`, and the run completes.
- Then: The sync returns `{outcome: "accepted", failureCode: null}`. The run execution has a non-empty `FIXTURE_TOKEN` environment value sourced from the connector account, but never contains the raw credential. The firewall resolves the model header to `Bearer bdd-personal-claude-token`, the run reads back as `completed`, and the connector account still exists.

## cron-connector-catalog-v4-002

- Vitest: "connector catalog v4 preparation > keeps the serving catalog until every legacy Skill has a preparation receipt"
- Mode: run
- Given: Row `legacy`: the catalog source publishes a v4 release whose `catalog-service` connector has a bundled Skill in the legacy storage layout, and no Skill preparation receipt exists yet; a signed-in user can read the public catalog.
- When: The cron calls `GET /api/cron/sync-connector-catalog`; then a matching preparation receipt is published and the cron syncs twice more; the user reads `GET /api/connector-catalog` in between.
- Then: The first sync returns `{outcome: "rejected", failureCode: "invalid-reference"}` and the public catalog is unchanged. After the receipt appears the next sync returns `accepted`, the following one `unchanged`, and the public catalog includes `catalog-service`.

## cron-connector-catalog-v4-003

- Vitest: "connector catalog v4 preparation > keeps the serving catalog until every contracted Skill has a preparation receipt"
- Mode: run
- Given: Row `contracted`: the catalog source publishes a v4 release whose `catalog-service` connector has a bundled Skill in the contracted layout, and no Skill preparation receipt exists yet; a signed-in user can read the public catalog.
- When: The cron calls `GET /api/cron/sync-connector-catalog`; then a matching preparation receipt is published and the cron syncs twice more; the user reads `GET /api/connector-catalog` in between.
- Then: The first sync returns `{outcome: "rejected", failureCode: "invalid-reference"}` and the public catalog is unchanged. After the receipt appears the next sync returns `accepted`, the following one `unchanged`, and the public catalog includes `catalog-service`.

## cron-connector-catalog-v4-004

- Vitest: "connector catalog v4 preparation > retains the serving catalog when a receipt binds a legacy candidate to a different source version"
- Mode: run
- Given: Row `legacy`: the catalog source publishes a v4 release with a legacy-layout bundled Skill, and its preparation receipt names a different Skill source version.
- When: The cron calls `GET /api/cron/sync-connector-catalog` and a signed-in user reads `GET /api/connector-catalog` before and after.
- Then: The sync returns `{outcome: "rejected", failureCode: "invalid-reference"}` and the public catalog is identical to before.

## cron-connector-catalog-v4-005

- Vitest: "connector catalog v4 preparation > retains the serving catalog when a receipt binds a contracted candidate to a different source version"
- Mode: run
- Given: Row `contracted`: the catalog source publishes a v4 release with a contracted-layout bundled Skill, and its preparation receipt names a different Skill source version.
- When: The cron calls `GET /api/cron/sync-connector-catalog` and a signed-in user reads `GET /api/connector-catalog` before and after.
- Then: The sync returns `{outcome: "rejected", failureCode: "invalid-reference"}` and the public catalog is identical to before.

## cron-connector-catalog-v4-006

- Vitest: "connector catalog v4 preparation > keeps serving the catalog when its source is unavailable"
- Mode: run
- Given: The connector catalog source has no objects (neither the active pointer nor a catalog).
- When: The cron calls `GET /api/cron/sync-connector-catalog` and a signed-in user reads `GET /api/connector-catalog` before and after.
- Then: The sync returns `{outcome: "rejected", failureCode: "source-unavailable"}` and the public catalog is identical to before.

## cron-connector-catalog-v4-007

- Vitest: "connector catalog v4 preparation > dispatches and completes a healthy Run after rejecting malformed catalog auth"
- Mode: run
- Given: A user who can run chat agents has connected Figma with an access token; the catalog source publishes a v4 release whose only connector declares a firewall header value that is a number instead of a string.
- When: The cron calls `GET /api/cron/sync-connector-catalog`; the user starts a chat run whose sandbox resolves `X-Figma-Token` via `POST /api/webhooks/run/firewall/auth`; the run completes; the cron syncs again.
- Then: Both syncs return `{outcome: "rejected", failureCode: "invalid-artifact"}` and the public catalog stays identical. The firewall returns `X-Figma-Token: accepted-catalog-figma-token` and the run reads back as `completed`.

## cron-connector-catalog-v4-008

- Vitest: "connector catalog v4 preparation > rejects a pointer outside the canonical v4 release namespace"
- Mode: run
- Given: The catalog source's active v4 pointer references a catalog key under the `connectors/v3/releases/` namespace, for a release labelled "Outside namespace".
- When: The cron calls `GET /api/cron/sync-connector-catalog` and a signed-in user reads `GET /api/connector-catalog`.
- Then: The sync returns `{outcome: "rejected", failureCode: "invalid-pointer"}` and the public catalog does not contain "Outside namespace".

## cron-connector-catalog-v4-009

- Vitest: "connector catalog v4 preparation > finds the current Monday MCP connector by name and slug"
- Mode: run
- Given: A signed-in user with the currently served connector catalog.
- When: For the keywords "Monday.com" and "monday-mcp", the user calls `GET /api/connectors/search` and `GET /api/connector-catalog/discovery`.
- Then: Every response returns HTTP 200 with `monday-mcp` as the first connector.

## cron-connector-catalog-v4-010

- Vitest: "connector catalog v4 preparation > does not expose an MCP transport as an executable HTTP permission bundle"
- Mode: run
- Given: A signed-in user with the currently served catalog, which includes the `plaud-mcp` MCP connector.
- When: The user reads `GET /api/connector-catalog/plaud-mcp`, then creates a manual HTTP custom connector via `POST /api/custom-connectors` with permission bundle `builtin:plaud-mcp@1`.
- Then: The catalog entry lists an `automatic` grant auth method. The create returns HTTP 400 "Unknown custom connector permission bundle: builtin:plaud-mcp@1".

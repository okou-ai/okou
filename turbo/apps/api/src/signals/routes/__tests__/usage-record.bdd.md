# usage-record

## usage-record-001

- Vitest: "GET /api/usage/record > returns 401 when not authenticated"
- Mode: run
- Given: A caller has no authentication.
- When: The caller sends `GET /api/usage/record` with no filters.
- Then: HTTP 401 returns exactly `UNAUTHORIZED` and `Not authenticated`.

## usage-record-002

- Vitest: "GET /api/usage/record > returns 403 when team usage records are requested"
- Mode: run
- Given: An authenticated organization administrator requests organization-level detail.
- When: The administrator sends `GET /api/usage/record` with team scope, seven days and UTC.
- Then: HTTP 403 returns `FORBIDDEN` and `Team usage records are aggregated by member`.

## usage-record-003

- Vitest: "GET /api/usage/record > returns an empty null-period response for free billing period usage"
- Mode: run
- Given: An authenticated free user has no paid billing period.
- When: The user reads usage records for the billing period in UTC.
- Then: HTTP 200 returns a null period, empty rows and zero credits, with page 1, page size 20 and zero total rows.

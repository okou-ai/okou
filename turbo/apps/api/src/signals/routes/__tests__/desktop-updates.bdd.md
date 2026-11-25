# desktop-updates

## desktop-updates-001

- Vitest: "desktop update routes > exposes the source-controlled floor without authentication and supports disabling it"
- Mode: run
- Given: The Desktop policy starts with the committed minimum version 0.54.0, then is disabled, set to 0.51.0 and disabled again.
- When: A caller sends `GET /api/desktop/compatibility` without authentication in each configuration.
- Then: The responses carry `minimumSupportedVersion` equal to `0.54.0`, null, `0.51.0` and null respectively. The first two responses are HTTP 200 with `Cache-Control: no-store`.

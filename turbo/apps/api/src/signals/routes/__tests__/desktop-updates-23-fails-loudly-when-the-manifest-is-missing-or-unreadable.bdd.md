# desktop-updates-23-fails-loudly-when-the-manifest-is-missing-or-unreadable

## desktop-updates-23-fails-loudly-when-the-manifest-is-missing-or-unreadable-001

- Vitest: "desktop update routes > fails loudly when the manifest is missing or unreadable"
- Mode: run
- Given: The upstream stable manifest first returns HTTP 404, then a JSON object containing only `schemaVersion: 1`.
- When: An unauthenticated caller requests `GET /api/desktop/updates/stable/darwin/arm64/dmg` in each state.
- Then: Both requests return HTTP 500. For the 404, the API makes one upstream attempt and reports `Desktop update manifest fetch failed with 404` to Sentry.

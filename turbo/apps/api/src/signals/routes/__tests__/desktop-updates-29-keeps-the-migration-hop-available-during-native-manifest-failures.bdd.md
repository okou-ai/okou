# desktop-updates-29-keeps-the-migration-hop-available-during-native-manifest-failures

## desktop-updates-29-keeps-the-migration-hop-available-during-native-manifest-failures-001

- Vitest: "desktop update routes > serves the fixed migration hop independently of missing, broken or unavailable Native metadata"
- Mode: run
- Given: The native manifest host is exercised in three states. It returns HTTP 404, a JSON body with only `schemaVersion: 1`, or HTTP 503.
- When: For each upstream state, a macOS ARM64 updater requests both `appcast.xml` and `RELEASES.json` under `/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/`.
- Then: The native appcast returns HTTP 500, 500 and 503 respectively. Every legacy feed response is HTTP 200, has `currentRelease: "0.52.2"` and points its first release to the 0.52.2 ZIP.

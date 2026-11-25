# desktop-updates-05-lets-native-clients-retry-when-the-release-manifest-is

## desktop-updates-05-lets-native-clients-retry-when-the-release-manifest-is-001

- Vitest: "desktop update routes > lets native clients retry when the release manifest is unavailable"
- Mode: run
- Given: The upstream release manifest responds with HTTP 503 and the updater feed starts without a cached manifest.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast responds with HTTP 503, `Retry-After: 60`, and `Cache-Control: no-store`.

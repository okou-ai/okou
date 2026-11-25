# desktop-updates-03-keeps-blocked-native-releases-out-of-the-sparkle-feed

## desktop-updates-03-keeps-blocked-native-releases-out-of-the-sparkle-feed-001

- Vitest: "desktop update routes > keeps blocked Native releases out of the Sparkle feed"
- Mode: run
- Given: The stable manifest targets native release 0.50.1 and blocks it. Both 0.50.0 and 0.50.1 have macOS ARM64 ZIPs.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast returns HTTP 200 with an `application/rss+xml` content type and `Cache-Control: no-store`. It advertises 0.50.0 with its ZIP and omits 0.50.1.

# desktop-updates-12-does-not-return-a-blocked-latest-release

## desktop-updates-12-does-not-return-a-blocked-latest-release-001

- Vitest: "desktop update routes > does not return a blocked latest release"
- Mode: run
- Given: The stable manifest marks its target 0.52.1 as blocked. It also lists eligible macOS ARM64 ZIPs for 0.52.0 and the newer 0.53.0.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast returns HTTP 200 with Sparkle version 0.52.0 and an enclosure pointing to the 0.52.0 ZIP.

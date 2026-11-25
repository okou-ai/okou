# desktop-updates-09-serves-an-okou-release-only-from-the-isolated-okou

## desktop-updates-09-serves-an-okou-release-only-from-the-isolated-okou-001

- Vitest: "desktop update routes > serves the authoritative R2 release feed"
- Mode: run
- Given: The stable release manifest in R2 points to native macOS ARM64 release 1.2.3 with its ZIP, title, release notes and publication date.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast returns HTTP 200 and XML containing Sparkle version 1.2.3, title `Okou 1.2.3`, publication date `Mon, 08 Jun 2026 00:00:00 GMT`, description `Release 1.2.3` and an enclosure pointing to the release ZIP URL.

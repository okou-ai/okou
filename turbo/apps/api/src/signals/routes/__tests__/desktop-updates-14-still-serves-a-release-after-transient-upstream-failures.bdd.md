# desktop-updates-14-still-serves-a-release-after-transient-upstream-failures

## desktop-updates-14-still-serves-a-release-after-transient-upstream-failures-001

- Vitest: "desktop update routes > still serves a release after transient upstream failures"
- Mode: run
- Given: The API has no cached manifest. The manifest host returns HTTP 502 twice, then returns a manifest targeting native release 1.2.3.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast returns HTTP 200 with Sparkle version 1.2.3 after three upstream requests. The API does not send an exception to Sentry.

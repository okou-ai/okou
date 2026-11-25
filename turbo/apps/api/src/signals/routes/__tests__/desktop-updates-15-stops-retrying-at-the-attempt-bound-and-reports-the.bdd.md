# desktop-updates-15-stops-retrying-at-the-attempt-bound-and-reports-the

## desktop-updates-15-stops-retrying-at-the-attempt-bound-and-reports-the-001

- Vitest: "desktop update routes > stops retrying at the attempt bound and reports the feed as unavailable"
- Mode: run
- Given: The upstream release manifest consistently responds with HTTP 500 and there is no cached manifest.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast responds with HTTP 503 and error code `DESKTOP_UPDATE_UNAVAILABLE` after exactly three upstream manifest requests. The API does not send an exception to Sentry.

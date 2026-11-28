# desktop-updates-24-fails-loudly-when-the-manifest-body-is-not-json

## desktop-updates-24-fails-loudly-when-the-manifest-body-is-not-json-001

- Vitest: "desktop update routes > fails loudly when the manifest body is not json"
- Mode: run
- Given: The release manifest responds as `application/json` but its body is `not-a-manifest`. There is no cached manifest.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast responds with HTTP 500 after one upstream manifest request. The API sends a `SyntaxError` to Sentry.

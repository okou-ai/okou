# desktop-updates-25-does-not-answer-a-broken-manifest-from-the-cache

## desktop-updates-25-does-not-answer-a-broken-manifest-from-the-cache-001

- Vitest: "desktop update routes > does not answer a broken manifest from the cache"
- Mode: run
- Given: At `2026-06-08T00:00:00.000Z`, a successful appcast request returned HTTP 200 from a manifest targeting release 1.2.3. The upstream manifest then starts returning HTTP 404.
- When: Five minutes later, an unauthenticated macOS ARM64 updater requests the same stable appcast.
- Then: The appcast responds with HTTP 500.

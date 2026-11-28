# desktop-updates-20-expires-the-cached-release-instead-of-renewing-it-on

## desktop-updates-20-expires-the-cached-release-instead-of-renewing-it-on-001

- Vitest: "desktop update routes > expires the cached release instead of renewing it on each stale hit"
- Mode: run
- Given: A successful appcast response populated the cache with release 1.2.3. The manifest host then becomes unreachable.
- When: The updater requests the same appcast 10, 20, 29 and 30 minutes after the successful load.
- Then: The first three requests return HTTP 200 and Sparkle version 1.2.3. At 30 minutes the response is HTTP 503 with error code `DESKTOP_UPDATE_UNAVAILABLE`.

# desktop-updates-21-does-not-serve-stale-after-retries-carry-it-past

## desktop-updates-21-does-not-serve-stale-after-retries-carry-it-past-001

- Vitest: "desktop update routes > does not serve stale after retries carry it past the stale deadline"
- Mode: run
- Given: A successful appcast response loaded release 1.2.3. The manifest host has since become unreachable.
- When: The updater requests the appcast a millisecond before its 30-minute stale deadline. An upstream attempt fails as the deadline arrives.
- Then: The response is HTTP 503 with error code `DESKTOP_UPDATE_UNAVAILABLE`.

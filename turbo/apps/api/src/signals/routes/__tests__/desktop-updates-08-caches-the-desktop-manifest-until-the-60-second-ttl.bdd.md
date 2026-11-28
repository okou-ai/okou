# desktop-updates-08-caches-the-desktop-manifest-until-the-60-second-ttl

## desktop-updates-08-caches-the-desktop-manifest-until-the-60-second-ttl-001

- Vitest: "desktop update routes > caches the desktop manifest until the 60-second ttl expires"
- Mode: run
- Given: The stable manifest initially targets macOS ARM64 release 0.52.0. After the first successful request the publisher replaces it with 0.52.1.
- When: The updater requests the stable macOS ARM64 appcast again at 59,999 ms and at 60,000 ms after the first request.
- Then: All three responses are HTTP 200. The first two include Sparkle version 0.52.0. The third includes 0.52.1.

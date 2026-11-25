# desktop-updates-19-serves-the-cached-release-while-the-manifest-host-is

## desktop-updates-19-serves-the-cached-release-while-the-manifest-host-is-001

- Vitest: "desktop update routes > serves the cached release while the manifest host is unreachable"
- Mode: run
- Given: A successful appcast response returned HTTP 200 and Sparkle version 1.2.3. The manifest host then becomes unreachable.
- When: The same appcast is requested one millisecond before 30 minutes have elapsed.
- Then: The appcast still returns HTTP 200 and includes Sparkle version 1.2.3.

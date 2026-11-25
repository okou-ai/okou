# desktop-updates-22-keeps-the-cached-release-usable-across-a-failed-refresh

## desktop-updates-22-keeps-the-cached-release-usable-across-a-failed-refresh-001

- Vitest: "desktop update routes > keeps the cached release usable across a failed refresh"
- Mode: run
- Given: An appcast request successfully loaded version 1.2.3. The manifest host fails at five minutes, then becomes reachable with version 1.2.4 by ten minutes.
- When: The updater requests the same appcast at both times.
- Then: Both responses are HTTP 200. The recovered response advertises Sparkle version 1.2.4.

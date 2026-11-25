# desktop-updates-28-freezes-the-electron-hop-while-native-updates-advance

## desktop-updates-28-freezes-the-electron-hop-while-native-updates-advance-001

- Vitest: "desktop update routes > keeps dormant Electron clients on the retained bridge-bearing hop while Native and manual downloads advance"
- Mode: run
- Given: The publisher supplies a stable manifest containing only 0.53.0, then one minute later replaces it with a manifest containing only 0.53.1. Both versions have macOS ARM64 ZIPs.
- When: At each version, callers request the product-specific stable macOS ARM64 `RELEASES.json` and `appcast.xml` and the neutral stable macOS ARM64 `dmg`.
- Then: The legacy response is always HTTP 200 and `Cache-Control: no-store` with current release 0.52.2 and exactly one release. Its update is named `Okou 0.52.2`, has version 0.52.2, empty notes, publication timestamp `2026-10-10T06:04:27.216Z` and the 0.52.2 ZIP. The native response is HTTP 200 with the current Sparkle version and ZIP. The manual response is HTTP 302 to the current DMG.

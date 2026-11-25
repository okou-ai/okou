# desktop-updates-30-requires-an-eligible-native-release

## desktop-updates-30-requires-an-eligible-native-release-001

- Vitest: "Native Desktop update availability > reports unavailable when every Native candidate is blocked and keeps the fixed migration hop"
- Mode: run
- Given: The stable manifest targets 0.53.2 and blocks 0.50.0 and 0.53.2. It also lists historical Electron 0.49.75 and newer native 0.53.3 with macOS ARM64 ZIPs.
- When: The caller requests the product-specific stable macOS ARM64 appcast and legacy `RELEASES.json`, plus the stable macOS ARM64 DMG and release endpoints without a product prefix.
- Then: The native appcast, DMG and release requests return HTTP 404. The legacy feed returns HTTP 200 and `currentRelease: "0.52.2"`.

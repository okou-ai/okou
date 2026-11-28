# desktop-updates-31-requires-a-native-platform-asset

## desktop-updates-31-requires-a-native-platform-asset-001

- Vitest: "Native Desktop platform availability > reports unavailable when Native platform assets are missing despite old manifest history"
- Mode: run
- Given: The stable manifest targets release 0.53.2. Releases 0.53.2 and 0.53.1 have no platform assets. Historical release 0.49.75 lists a macOS ARM64 ZIP.
- When: An unauthenticated caller requests the product-specific macOS ARM64 appcast and the stable macOS ARM64 DMG and release endpoints without a product prefix.
- Then: All three endpoints return HTTP 404.

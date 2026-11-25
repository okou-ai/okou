# desktop-updates-07-serves-the-current-okou-desktop-line-on-the-neutral

## desktop-updates-07-serves-the-current-okou-desktop-line-on-the-neutral-001

- Vitest: "desktop update routes > serves the current Okou desktop line on the neutral routes"
- Mode: run
- Given: The current stable manifest targets release 1.2.3 and the legacy manifest targets 0.50.0. Both provide macOS ARM64 ZIPs.
- When: An unauthenticated caller requests the `release` and `dmg` paths under `/api/desktop/updates/stable/darwin/arm64/`.
- Then: Both return HTTP 302 and `Cache-Control: no-store`. The release Location is the GitHub tag `okou-desktop-v1.2.3`. The DMG Location is its `Okou-darwin-arm64-1.2.3.dmg` asset.

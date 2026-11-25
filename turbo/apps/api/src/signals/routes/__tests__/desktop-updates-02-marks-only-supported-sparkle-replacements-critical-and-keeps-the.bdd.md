# desktop-updates-02-marks-only-supported-sparkle-replacements-critical-and-keeps-the

## desktop-updates-02-marks-only-supported-sparkle-replacements-critical-and-keeps-the-001

- Vitest: "desktop update routes > marks only supported Sparkle replacements critical and keeps the Electron feed accessible"
- Mode: run
- Given: The Desktop minimum supported version is 0.51.0. The stable manifest targets macOS ARM64 release 0.51.0 and also contains 0.50.1.
- When: The updater requests `appcast.xml`, `RELEASES.json` and `dmg` under `/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/`.
- Then: The appcast returns HTTP 200 and marks 0.51.0 critical at threshold 0.51.0. The legacy feed returns HTTP 200 with `currentRelease: "0.52.2"`. The manual download returns HTTP 302 to the 0.51.0 DMG.

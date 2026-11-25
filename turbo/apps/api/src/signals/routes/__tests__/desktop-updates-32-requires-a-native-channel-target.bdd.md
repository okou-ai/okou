# desktop-updates-32-requires-a-native-channel-target

## desktop-updates-32-requires-a-native-channel-target-001

- Vitest: "Native Desktop channel target > reports unavailable for a channel targeting an Electron release"
- Mode: run
- Given: The release manifest is available. Its stable channel targets Electron release 0.49.75, and the manifest also lists a macOS ARM64 ZIP for 0.50.0.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The API responds with HTTP 404.

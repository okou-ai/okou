# desktop-updates-10-redirects-the-final-okou-line-to-final-identity-release

## desktop-updates-10-redirects-the-final-okou-line-to-final-identity-release-001

- Vitest: "desktop update routes > redirects the final Okou line to final-identity release assets"
- Mode: run
- Given: The stable manifest points to native macOS ARM64 release 1.2.3.
- When: An unauthenticated caller requests the `release` and `dmg` paths under `/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/`.
- Then: Both return HTTP 302. The first Location is `https://github.com/okou-ai/okou/releases/tag/okou-desktop-v1.2.3`. The second is `https://github.com/okou-ai/okou/releases/download/okou-desktop-v1.2.3/Okou-darwin-arm64-1.2.3.dmg`.

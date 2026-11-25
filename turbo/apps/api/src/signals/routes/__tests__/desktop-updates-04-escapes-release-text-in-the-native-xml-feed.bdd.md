# desktop-updates-04-escapes-release-text-in-the-native-xml-feed

## desktop-updates-04-escapes-release-text-in-the-native-xml-feed-001

- Vitest: "desktop update routes > escapes release text in the native XML feed"
- Mode: run
- Given: The stable manifest points to the native macOS ARM64 release 0.50.0, with title `Okou & <native>` and notes `Text "quoted" <script>`.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The appcast responds with HTTP 200 and contains `Okou &amp; &lt;native&gt;` and `Text &quot;quoted&quot; &lt;script&gt;`.

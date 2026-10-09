# Okou Desktop

Native SwiftUI/AppKit application for Apple silicon Macs running macOS 14 or
later. The app hosts Computer Use and account/permission settings. Authentication
uses Clerk's native macOS SDK; the app has no browser-login alternative, chat,
PWA, MCP, filesystem sharing, or plugin runtime.

## Development

Use Xcode 26 or later. `Okou.xcodeproj` builds the application and packages the
Clerk resource bundle and Sparkle framework. The root Swift package contains the
transport, command executor, host lifecycle, and preferences. `ComputerUse/`
contains the existing native Accessibility and ScreenCaptureKit backend.

```bash
swift test --package-path desktop -j 4
swift test --package-path desktop/ComputerUse -j 4 --disable-automatic-resolution
CLERK_PUBLISHABLE_KEY=pk_test_example \
  OKOU_DESKTOP_PLATFORM_URL=https://staging-app.omby.ai \
  python3 desktop/scripts/build.py --development --package
```

Use the real staging publishable key. Development packages use `Okou Dev`,
`ai.okou.desktop.dev`, and a separate Application Support directory. Production
packages use `Okou`, `ai.okou.desktop`, and the live Clerk publishable key. Set
`CLERK_PUBLISHABLE_KEY` when building; the generated runtime configuration is
ignored and removed from the source tree after packaging. Open the resulting
app in `desktop/out/` to exercise the real UI. `--smoke-test` verifies packaged
configuration, helper presence, and the upgrade bridge without signing in or
registering a host.

`--auth-smoke-test` separately initializes the real Clerk SDK and reports its
Keychain namespace and whether a session was restored, without opening a login
window or registering a host. On the first Electron-to-native upgrade it must
report `signedIn: false`, even when the old native helper has a saved session.

```bash
CLERK_PUBLISHABLE_KEY=pk_live_example \
  python3 desktop/scripts/build.py --sign \
  'Developer ID Application: Max & Zoe, Inc. (C5UWSXYB67)' \
  --package --notarize --notary-profile vm0-desktop-notary
```

The local command requires that signing identity and notary profile in Keychain.
CI uses the existing atomic notarization API-key environment variables instead.
The builder signs all nested native code, submits the app ZIP, staples the app,
and creates, signs, notarizes, and staples a DMG. Archives retain the names
`Okou-darwin-arm64-VERSION.zip` and `.dmg`.

## Existing installations

The bundle ID, URL scheme, Developer ID team, and Application Support directory
stay unchanged. All upgrading users sign in once with the native flow. Native
authentication uses a fresh Keychain service `ai.okou.desktop.native-auth`;
development builds use `ai.okou.desktop.dev.native-auth`. The application does
not restore or migrate Electron's browser or native login credentials. Subsequent
native launches and upgrades retain the new native session. The native application
reads `desktop-preferences.json` and preserves the existing
`computerUseInstallationId`, `keepAwakeEnabled`, and unrelated settings.

The legacy `RELEASES.json` endpoint and mutable release manifest continue serving
the same ZIP. Old Electron/Squirrel versions replace the entire `.app`. On
macOS 11+, their relaunch step executes
`Contents/Frameworks/Squirrel.framework/Resources/ShipIt ___launch___ APP` inside
the new app. `LegacyRelaunch/` supplies that path with a small native Swift
launcher. The minimal framework envelope is only for code-signing compatibility;
the app does not load it. Keep the bridge in future native releases because old
installations can skip versions.

Subsequent native updates use Sparkle 2.10, the API's `appcast.xml`, and the same
Developer ID designated requirement. Code-signing-only validation is supported
in this pinned Sparkle version but deprecated upstream. Adopting EdDSA requires
a separately provisioned release signing key and manifest signature metadata;
do not enable mandatory EdDSA verification without coordinating those inputs.
Unsigned development and CI apps keep production updates disabled.

Stopping, changing workspace, signing out, quitting, and installing updates close
command admission and drain claimed work before retiring the host connection. Native
input is never replayed after a timeout. Background updates also wait until the
host has been idle for 30 minutes. Required upgrades bypass that grace while
still waiting for claimed commands, completion reports, and host cleanup.

See [the minimum version policy](../docs/desktop-version-policy.md) for the
default-disabled deployment floor, visible upgrade states, and activation gates.

## Release

Release Please owns `desktop/version.txt` and `desktop/CHANGELOG.md`, continuing
the existing Desktop version history and `desktop-v*` component tags. Builds
override the Xcode version from that file. Merge-group CI uploads the canonical
unsigned app under its exact commit SHA in R2. The production promotion job
downloads and verifies that artifact, signs and notarizes it without rebuilding,
publishes `okou-desktop-v*` ZIP/DMG assets, and updates the existing manifest only
after both Desktop promotion and API deployment succeed. This keeps the first
native ZIP behind deployment of its appcast route. Both updater formats share
channel/blocked-version selection in the canonical API service.

## Session authentication

Native Desktop uses the Clerk SDK's current session token for registration,
heartbeats, command claims, completion, and stop. The API binds each host to the
verified user, organization, Clerk session ID, and connection generation. A JWT
refresh preserves that connection; a different session requires registration.
The host ID and generation are ordinary identifiers, not bearer credentials.

SDK reads and HTTP share a bounded deadline. A rejected bearer gets one forced
SDK refresh; an unavailable provider pauses execution without clearing Keychain.
Local sign-out drains claimed work before ending the SDK session. Remote
revocation can prevent result reporting: the local command log retains the
execution result, the server command times out, and native input is never replayed.

See [the authentication contract](../docs/desktop-session-auth.md) for remote
revocation, mixed-version behavior, and acceptance steps.

# Computer Use Desktop

Electron shell for Okou.

Computer Use setup lives in the hosted Platform UI. This app exposes the
Desktop bridge and native macOS host runtime that page uses.

Okou supports macOS 14+ (macOS 14 or newer). Packaged app
metadata, native helper builds, and release verification all use the same
minimum for Apple silicon artifacts. Intel Macs are not supported.

When the user is signed in and the feature switch is enabled, the main process
registers a Desktop Computer Use host through the platform API command queue. It
uses the Electron session for auth, polls queued commands, executes them with a
native macOS `computer-use-helper`, and completes commands back to the API.
Electron only owns the app shell and command bridge; the helper owns macOS
Accessibility, target-window screenshot capture, and targeted CGEvent input
dispatch.

Computer Use uses the built-in Okou driver. Developer Tools controls filesystem,
MCP, and screen recording features; it does not select a Computer Use backend.

## Development

For quick Electron development without macOS bundle behavior, use:

```bash
pnpm desktop:dev:forge
```

This launches the generic Electron app from `node_modules`, so macOS URL scheme
handlers, bundle identifiers, Dock identity, and permission prompts do not match
the packaged Desktop app.

From `turbo/`, start a packaged development app against the local proxy
with:

```bash
pnpm desktop:dev
```

This packages and runs `Okou Dev.app` with `OKOU_DESKTOP_PLATFORM_URL` set to
the local proxy. Use packaged development apps for sign-in callback, URL scheme, and
permission testing.
Non-CI packaged desktop builds require the `Developer ID Application: Max &
Zoe, Inc. (C5UWSXYB67)` signing identity in the local keychain. This keeps the
app's code requirement stable across rebuilds so macOS Accessibility and Screen
Recording permissions are not reset by ad-hoc signatures.

The desktop build compiles both Electron entrypoints and the Swift native helper:

```bash
pnpm -F @okouai/desktop build
```

Create a macOS artifact with:

```bash
pnpm desktop:make
```

This builds the production `Okou.app` with bundle ID and callback scheme
`ai.okou.desktop`, signs it with the local Developer ID Application identity,
submits it to Apple's notary service, staples the notarization ticket, and
writes the zip artifact under `apps/desktop/out/make`. Development Okou builds
use `ai.okou.desktop.dev`.
Local notarized builds use the `notarytool` Keychain profile
`vm0-desktop-notary` by default. Set `OKOU_DESKTOP_NOTARIZE_KEYCHAIN_PROFILE` to
override the profile and `OKOU_DESKTOP_NOTARIZE_KEYCHAIN` to override the
Keychain path, or set `OKOU_DESKTOP_NOTARIZE_API_KEY_PATH`,
`OKOU_DESKTOP_NOTARIZE_API_KEY_ID`, and `OKOU_DESKTOP_NOTARIZE_API_ISSUER` to use
an API key file directly.

The helper source lives under `apps/desktop/native/computer-use-helper`. Build
output is copied to `apps/desktop/native/dist/native/computer-use-helper`, which
is also the path included in packaged macOS artifacts.

Point it at a local or staging platform URL with:

```bash
OKOU_DESKTOP_PLATFORM_URL=https://staging-app.omby.ai pnpm -F @okouai/desktop dev:packaged
OKOU_DESKTOP_PLATFORM_URL=https://app.vm7.ai:8443 pnpm -F @okouai/desktop dev:packaged
OKOU_DESKTOP_PLATFORM_URL=http://localhost:3002 pnpm -F @okouai/desktop dev:packaged
```

The desktop app does not start platform/web/api/proxy services itself. Start the
target platform surface separately, then pass its URL through
`OKOU_DESKTOP_PLATFORM_URL`.

## Internal macOS artifacts

The `Desktop` GitHub Actions workflow builds macOS artifacts for internal
testing. Run the workflow manually from GitHub Actions, then download the Apple
silicon artifact:

- `okou-desktop-macos-arm64-unsigned` for the shipping configuration, built the
  way a release is built: the Okou product selected explicitly, with a packaged
  runtime config
- `okou-desktop-macos-arm64-default-unsigned` for the same product built from an
  unconfigured checkout, with no packaged runtime config

Both contain `Okou-darwin-arm64.zip` and `Okou.app`. Unzip both layers, then
open the app.

These artifacts are ad-hoc signed, not Developer ID signed, and not notarized.
macOS Gatekeeper may require right-clicking the app and choosing Open, or
removing quarantine locally:

```bash
xattr -dr com.apple.quarantine "Okou.app"
```

## Release artifacts

Desktop releases are versioned by release-please. Changes under
`turbo/apps/desktop` with release-worthy Conventional Commit types update
`package.json`, this changelog, and the manifest entry, then create a
`desktop-vX.Y.Z` GitHub Release.

When a release-please merge group changes the Desktop package version, the
`deploy-desktop` job builds the unsigned production `Okou.app` for Apple silicon
Macs and publishes it to R2 under `okou-desktop/<commit-sha>/`. The matching
release run resolves the same commit as `release_target`, downloads and verifies
that immutable app artifact, signs it with the Developer ID Application
certificate, notarizes it for direct distribution outside the Mac App Store, and
publishes `okou-desktop-vX.Y.Z` containing `Okou-darwin-arm64-X.Y.Z.zip` and
`.dmg`.

The release workflow then updates the Okou manifest. The Zero manifest is frozen
at its final bridge release and is no longer produced by any build.

### Zero and Okou update compatibility

Final `ai.okou.desktop` installations use
`/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64` and the
`ai-okou-desktop-updates` manifest. The stable Okou download route at
`/api/desktop/updates/stable/darwin/arm64` also resolves through this
final-identity manifest. The manifest identifies its product, and the API
rejects ZIP assets whose product filename does not match it, so an Okou feed
never publishes a Zero archive.

`ai-okou-desktop` is the only line the API still resolves. The pre-adoption
`okou` manifest remains frozen without a final-identity artifact, and #31475
retired the `zero` line the same way: its manifest had been frozen since the
`hard` migration policy went live, and the Squirrel clients still polling it
could not have crossed to the Okou bundle anyway. Both retired lines answer
`404` on their explicit `:product` routes, and the unqualified
`RELEASES.json` route — the only route that ever resolved to Zero — is gone.
Only the unqualified `release` and `dmg` routes remain unqualified, and both
resolve to Okou.

The API now accepts only the Okou callback schemes (`ai.okou.desktop` and
`ai.okou.desktop.dev`); the Zero schemes were retired once the `hard` migration
policy made the sign-in path unreachable from an installed Zero build, which
offers only `Download Okou` or `Quit Zero`. A handoff request carrying a Zero
scheme is now rejected with `400`. Desktop builds select exactly one product
feed and one callback scheme from their packaged identity; they do not discover
or switch products at runtime.

Current Desktop builds support only Okou. `OKOU_DESKTOP_PRODUCT` and the
runtime configuration's optional `product` field accept `okou`; unsupported
products fail validation. An unconfigured local or CI build produces
`Okou.app`, while staging and local origins select `Okou Dev.app` with its
existing `Okou Dev` profile. Okou production builds package a runtime
configuration containing
`product: okou` and `https://app.okou.ai`. That app origin routes API calls to
`api.okou.ai`, while Clerk and OAuth web flows use `app.okou.ai`.

Okou is a separate macOS application identity. It can be installed beside
Zero, stores Electron data under its explicit `Okou` data directory, and gets a
new installation ID. It does not read or migrate the pre-adoption Okou profile
or Zero's Chromium profile. Users sign in again and grant Accessibility, Screen
Recording, and browser Automation permissions again because macOS TCC
associates those permissions with the application identity. The current
release promotion signs and notarizes only Okou, publishing under its existing
release tag and update manifest identities. The local manifest writer requires
existing manifests to identify `product: okou`; it rejects missing or conflicting
product values instead of relabeling historical artifacts.

### Final Zero bridge release

The Zero migration bridge shipped, reached its `hard` stop, and has been removed
from this source tree. It no longer exists in any build produced from `main`.

Production Zero builds at version `0.34.0` or newer carry the bridge compiled
in. They poll `/api/desktop/migration-policy` every five minutes and, on `hard`,
finish the active Computer Use command, stop the Zero host, and offer only
`Download Okou` or `Quit Zero`. `hard` went live on 2026-08-31 and Zero Computer
Use traffic reached zero within about half an hour.

Because that behaviour lives in already-installed builds rather than here,
removing the source does not weaken it — but two server-side pieces must keep
working for those builds:

- **`/api/desktop/migration-policy` must keep answering `hard`.** The installed
  bridge falls back to `soft` on any request failure, so deleting or breaking
  the endpoint would silently release users the hard stop is holding.
- **The Okou DMG route must keep resolving.** `Download Okou` opens
  `https://api.vm0.ai/api/desktop/updates/stable/darwin/arm64/dmg`. Installed
  Zero migration bridges poll this neutral route after the policy goes `hard`,
  so it must continue returning the current Okou installer. #26364 tracks the
  Zero install base itself.

This does not submit or publish the app to the Mac App Store. The App Store
Connect API key is only used as notarytool authentication for Apple's
notarization service.

The release job requires these GitHub secrets:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_KEYCHAIN_PASSWORD`
- `APP_STORE_CONNECT_API_KEY_BASE64`
- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_API_ISSUER_ID`

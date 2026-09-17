# Okou for iOS

Native SwiftUI MVP for iPhone in portrait orientation, targeting iOS 26 or later.
This folder is a standalone Xcode project inside the Okou monorepo. It does not
require XcodeGen, CocoaPods, or a pnpm workspace wrapper.

## MVP behavior

The app uses existing production APIs for native authentication, workspace
selection, chat lists, conversation history, creating chats, sending text,
retrying uncertain sends, and stopping work. New chats use the workspace's
default agent and the existing saved model preference. Workspace setup and
account management remain on the web.

Conversation history renders durable user messages and assistant results using
Textual 0.5.0. The renderer supports Markdown headings, lists, quotes, tables,
links, images, and code blocks, with text selection, code copying, and horizontal
overflow for wide tables and code. Ably notifications trigger fresh API reads;
transient token output and tool cards are not rendered. Sharing, Cloud Browser,
Computer Use, artifact controls, attachment input, model selection, and connector
selection are outside this local UI. The composer uses a combined send/stop
control: a nonempty draft can be sent while work is active, and the empty-draft
control can stop active work.

Before sending in an existing conversation, the app clears thread-level connector
overrides and disables Cloud Browser and Computer Use through existing APIs,
then reads the settings back. These are shared conversation settings: the same
conversation on the web will also reflect the changes. The agent's default
connectors remain in use.

## Local setup

Use Xcode 26.3 or a newer version supported by the host Mac, with an installed
iOS 26 simulator runtime. Open `ios/Okou.xcodeproj` and select the shared `Okou`
scheme and an iPhone simulator. Xcode resolves the pinned Clerk, Ably, and Textual
Swift packages on first use. Keep
`Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` with the
project when dependency versions change.

The checked-in configuration uses the production services:

- API: `https://api.okou.ai`
- Web: `https://app.okou.ai`
- Clerk: the production publishable key in `Config/Shared.xcconfig`

A Clerk publishable key is public client configuration; no Clerk secret key or
Apple credential belongs in this project. Optional local build overrides belong
in ignored `Config/Local.xcconfig`. The Info.plist keys consumed by the app are
`APIBaseURL`, `WebBaseURL`, and `ClerkPublishableKey`.

From the repository root, list the available simulators, then use a device ID:

```sh
xcrun simctl list devices available
xcodebuild -list -project ios/Okou.xcodeproj
xcodebuild -project ios/Okou.xcodeproj -scheme Okou \
  -configuration Debug -destination 'platform=iOS Simulator,id=<DEVICE_ID>' \
  -derivedDataPath /tmp/okou-ios-derived build \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES
xcodebuild -project ios/Okou.xcodeproj -scheme Okou \
  -configuration Debug -destination 'platform=iOS Simulator,id=<DEVICE_ID>' \
  -derivedDataPath /tmp/okou-ios-derived test \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES
xcrun simctl install <DEVICE_ID> /tmp/okou-ios-derived/Build/Products/Debug-iphonesimulator/Okou.app
xcrun simctl launch <DEVICE_ID> ai.okou.ios
```

Keep simulator code signing enabled. An unsigned simulator build compiled but
crashed at launch when Clerk accessed Keychain, reporting OSStatus `-34018`.
The ad-hoc signature selected by `CODE_SIGN_IDENTITY=-` allowed the app to launch.
This does not require a distribution certificate or device provisioning profile.
Normal simulator signing through Xcode is also appropriate; do not use
`CODE_SIGNING_ALLOWED=NO` for a runnable build.

The project uses synchronized folders: adding Swift files beneath `Okou/` or
`OkouTests/` adds them to the corresponding target. `Resources/Info.plist` is
excluded from resource copying and used as the app's build-time Info.plist.

## Authentication setup and distribution limits

During local acceptance on September 17, 2026, production Clerk initially rejected
native requests because the Native API was disabled. It was enabled with explicit
authorization and independently reloaded to verify the setting. The production
Google/OAuth callback allowlist entry `ai.okou.ios://callback` was also added with
explicit authorization and verified in the saved redirect list. The app registers
the `ai.okou.ios` URL scheme and passes incoming URLs to Clerk. Google sign-in,
session restoration, and authenticated chat access have since been exercised
successfully in the installed app.

`ai.okou.ios` is a provisional local Bundle ID. It has not been registered in
Apple Developer, App Store Connect, or Clerk's native application settings.
Associated-domain setup remains outstanding. Team `C5UWSXYB67` is configured for
a later device build. Device signing, provisioning, and TestFlight distribution
have not been validated.

This local implementation does not add release CI, TestFlight groups, an
App Store Connect app record, or an independent iOS minimum-build gate. Existing
HTTP 426 responses show a blocking update screen, but enforcing an iOS build
floor requires the separately planned API middleware change. Old API-version
compatibility and the future OpenAPI v1 migration are outside this MVP.

The iOS icon retains the Desktop flower geometry from
`turbo/apps/desktop/assets/icon.svg`. Its source is `Assets/AppIcon.svg`, with a
full opaque background because iOS supplies the outer icon mask. The 1024-pixel
PNG is RGB without alpha; it removes the transparent Desktop padding that
appeared as a black border on the simulator. The SVG was exported using
`@resvg/resvg-js` 2.6.2 and encoded as RGB PNG using `pngjs` 7.0.0.

## Simulator Emoji issue

The current local host runs macOS 15.6 with Xcode 26.3. On its iOS 26.3.1 runtime
(build `23D8133`), conversation-title Emoji can appear as question-mark boxes
while accessibility text preserves the original characters. The app uses the
system font and preserves the title unchanged. Apple has acknowledged this
runtime Emoji-rendering bug; the forum reports iOS 26.1 as a working fallback
and iOS 26.4 as a fix. See the
[Apple developer discussion](https://developer.apple.com/forums/thread/817957).

For this host, a separate iOS 26.1 simulator is the current acceptance fallback.
Its approximately 8.3 GB runtime download was in progress at the verification
checkpoint below; installation and visual verification on that runtime were not
yet complete. The existing iOS 26.3.1 device and its login state are retained.
To install the fallback runtime through Xcode's supported command-line path:

```sh
xcodebuild -downloadPlatform iOS -buildVersion 26.1 -architectureVariant arm64
```

Create a separate simulator using that runtime, install the app, and sign in
again. Do not replace title Emoji in app code to mask this runtime issue.
Xcode 26.4 requires macOS 26.2 or later; no host OS upgrade is part of this work.
See Apple's [Xcode compatibility table](https://developer.apple.com/xcode/system-requirements)
and [component installation guide](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

## Verification checkpoint

On September 17, 2026:

- The signed simulator app built, installed, and launched on iPhone 17 Pro.
- Google login and session restoration worked. Real chat lists, existing history,
  new-chat creation, message delivery, and assistant results were confirmed in
  interactive acceptance.
- The date parser was corrected for the API's SQL-style UTC timestamps.
- Sending a follow-up while work was active, then backgrounding and returning,
  displayed the durable result `IOS_STEER_OK`.
- Fifteen simulator tests passed using the CI script from a fresh build directory.
  Fourteen
  use a `URLProtocol` HTTP-boundary fixture, keeping the client request,
  decoding, projection, and state code real. One uses an actual loopback HTTP
  server to verify gzip decoding. None requires production or preview services.
- Markdown headings, bold/italic text, lists, blockquotes, a table, syntax-colored
  code, and the code-copy action were verified in the installed app. Copying the
  sample produced `print("OK")` in a draft, which was then cleared without sending.
- The combined control showed a square stop icon during active work with an
  empty draft. Stopping produced `Task stopped.` and restored the send arrow.
- The list's decorative chat-bubble icons were removed. The installed app's
  home-screen icon no longer showed the black border.
- A persisted conversation containing an approximately 600-word reply reproduced
  a main-thread SwiftUI layout hang near 99% CPU with `LazyVStack`. Restricting the
  default scroll anchor to initial positioning did not resolve it. Replacing
  `LazyVStack` with `VStack` made the same conversation responsive, with an observed
  CPU sample of 2.2%. This does not establish a general performance bound.

Wide-code/table scrolling, link opening, image rendering, and further
long-history performance checks remain outside the completed interactive sample.
The conversation stack currently lays out all loaded messages eagerly.

Also verify uncertain-send recovery, signing out or switching workspaces clears
the previous workspace's chats and drafts, and Emoji render on the replacement
runtime. Record these outcomes separately from compilation and automated tests.
Physical-device acceptance, independent build enforcement, and TestFlight release
remain outstanding.

## CI

`.github/workflows/ios.yml` runs on pull requests, merge groups, pushes to main,
and manual dispatch. A lightweight Linux job tests change detection and gate
behavior on every run. Changes to `ios/`, the iOS workflow, or the shared
changed-base helper trigger Swift formatting, property-list validation, an app
build, and the simulator tests on macOS 26 with Xcode 26.3 and iOS 26.2. Swift
packages must match `Package.resolved`; CI checks that it remains unchanged.

The `ci-gate-ios` check succeeds only after the required build/tests pass, or
after change detection confirms they are unnecessary. Detection failures,
cancelled builds, and unexpectedly skipped builds fail the gate. Register this
check alongside the existing required checks after the workflow is on main.
Turbo and Desktop workflow behavior is unchanged.

Tests use HTTP-boundary fixtures and a loopback server. The CI build also clears
the Clerk key and overrides service origins with reserved `.invalid` domains.
Production services, PR preview provisioning, and deployed end-to-end tests are
outside this scope. These tests do not constitute page-level UI acceptance or
server contract verification. To run the same CI build locally:

```sh
RUNNER_TEMP="$(mktemp -d)" \
  IOS_TEST_DESTINATION='platform=iOS Simulator,id=<DEVICE_ID>' \
  bash ios/scripts/ci-test.sh
```

iOS is not registered with release-please and has no automated publishing job.
The existing release-PR gate helper reports `ci-gate-ios` success only when an
unrelated release PR changes no iOS inputs, so adding the required check does
not block release-please's bot-created commits. It rejects iOS changes instead
of granting them an untested pass.

# Okou for iOS

Native SwiftUI MVP for iPhone in portrait orientation, targeting iOS 26 or later.
This folder is a standalone Xcode project inside the Okou monorepo. It does not
require XcodeGen, CocoaPods, or a pnpm workspace wrapper.

## MVP behavior

The app uses existing production APIs for native authentication, workspace
selection, chat lists, conversation history, creating chats, sending text,
retrying uncertain sends, and stopping work. The composer supports system image
paste in new and existing chats alongside native photo, video and file selection, with
local previews, upload progress, removal and retry. Uploads use the existing
direct-to-storage API and its 1 GB limit; files of 5 MB or more use multipart
uploads. A message can contain files with or without text. Selected files and
uploads belong to their workspace and draft. Draft text, canonical message context
and completed-upload metadata persist per API origin, user, workspace and
Agent/thread, and synchronize through the existing draft APIs. New-chat drafts
belong to their Agent without creating a thread. Local file copies are removed
when removed from a draft or sent; closing retains recovery metadata. File bytes
remain temporary: interrupted uploads require explicit retry through the existing
uploader, and purged copies require reselection. Restored uploads are checked
against the file authority before sending. Its home screen follows the mobile
web agent-chat structure with an agent avatar, greeting, and composer; focusing
the compact composer animates it into a multiline field. The ChatGPT-style
sliding sidebar contains pinned agents and recent chats scoped to the selected
agent, with workspace switching at the top and a bottom new-chat action. Its
settings menu provides account actions. Native list actions support pinning,
archiving, and renaming chats. The chat header's native More menu also supports
muting. Archive and mute controls follow the existing `chatThreadArchiving` and
`chatThreadMuting` feature switches; muted chats can still be unmuted after the
muting switch is turned off. Opening a new chat is local and immediate;
the thread is created when the first message is sent. New chats use the selected
agent and the existing saved model preference. A native model sheet supports
chat-specific choices and personal subscription account management.
Workspace setup and Okou account management remain on the web.

Conversation history renders durable user messages and assistant results using
Textual 0.5.0. The renderer supports Markdown headings, lists, quotes, tables,
links, images, and code blocks, with text selection, code copying, and horizontal
overflow for wide tables and code. Ably notifications trigger fresh API reads;
transient token output is not rendered. Conversation sharing, Cloud Browser,
Computer Use, artifact publishing, and the global connector picker are outside this local UI.
Generated results retain inline link labels and show native cards for Markdown image
embeds. Images support enlarged system viewing and navigation within their transcript
group. Video/audio use system playback; PDF and supported Office files use Quick Look.
Markdown, text, JSON and CSV have in-app readers, while generated HTML runs its actual
content in an isolated WebKit session. Authorized downloads can be shared or saved to
Files through the native share sheet, including formats without a system preview.
Resource identities remain stable; access URLs are resolved for the current scope and
never persisted in the chat cache. Closing the detail cancels result work and releases
its temporary files.

Trusted connector and permission action links in assistant messages render as native cards,
including exact-account reconnect, conversation account confirmation, and permission decisions.
Permission details and confirmation use a native sheet. Credential forms remain
native; external authorization uses system Safari and verifies owned server receipts
before continuing the conversation. The composer uses a combined send/stop
control: a nonempty draft can be sent while work is active, and the empty-draft
control can stop active work.

Before sending in an existing conversation, the app preserves confirmed connector
account selections and disables Cloud Browser and Computer Use through existing APIs,
then reads the settings back. These are shared conversation settings: the same
conversation on the web will also reflect the changes. Existing Agent connector
authorizations and confirmed chat account choices remain in use.

## Local setup

Use Xcode 27.1 (build `27A9275`, iOS 27.1 SDK) on macOS 26.6 or later, with an
installed iOS 27 simulator runtime. Open `ios/Okou.xcodeproj` and select the shared `Okou`
scheme and an iPhone simulator. Xcode resolves the pinned Clerk, Ably, and Textual
Swift packages on first use. Keep
`Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` with the
project when dependency versions change.

The app's minimum deployment target remains iOS 26.0. Validate UI changes on
both iOS 26 and iOS 27: the build SDK and device runtime independently affect
native presentation, including scroll-edge effects. An iOS 26 simulator preview
does not establish iOS 27 device behavior.

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
xcrun simctl install <DEVICE_ID> /tmp/okou-ios-derived/Build/Products/Debug-iphonesimulator/Okou.app
xcrun simctl launch <DEVICE_ID> ai.okou.ios
```

Keep simulator code signing enabled. An unsigned simulator build compiled but
crashed at launch when Clerk accessed Keychain, reporting OSStatus `-34018`.
The ad-hoc signature selected by `CODE_SIGN_IDENTITY=-` allowed the app to launch.
This does not require a distribution certificate or device provisioning profile.
Normal simulator signing through Xcode is also appropriate; do not use
`CODE_SIGNING_ALLOWED=NO` for a runnable build.

The local [ChatDomain package](Packages/ChatDomain/Package.swift) contains pure
chat models, event projection, and thread replay. It depends only on Foundation;
the App explicitly imports its public API. Run its tests without launching an
app or simulator:

```sh
swift test --package-path ios/Packages/ChatDomain
```

Domain tests construct domain values directly. The local
[ChatData package](Packages/ChatData/Package.swift) owns API requests and DTOs,
synchronization, commands, model selection, and SQLite storage. It depends on
ChatDomain and Apple system frameworks; authentication/realtime SDK adapters,
feature stores, Markdown rendering, and native UI remain in the App.

Run the data tests independently:

```sh
swift test --package-path ios/Packages/ChatData
```

They retain real HTTP decoding, loopback snapshot transfers, and temporary SQLite
files. ChatDataTestSupport shares strict external HTTP fixtures across the
package and App targets. Required CI runs both package suites and the in-process
`OkouTests` target. It prioritizes business and protocol contracts, minimizes UI
coverage, and has a 12-minute complete-workflow budget. Visual and system
interaction changes receive explicit on-demand native acceptance.

Read the [iOS testing standard](../docs/ios/ios-testing.md) before adding or
reviewing tests. It defines real entry points, observable assertions, native
layout synchronization, fixture isolation, cleanup, and acceptance limits. Use
the [CI test command](#ci) for the App suite: it supplies isolated service
configuration instead of the normal production app configuration. Test totals
come from the selected revision and runner output, not a fixed count in this guide.

The project uses synchronized folders: adding Swift files beneath `Okou/` or
`OkouTests/` adds them to the corresponding target. `Resources/Info.plist` is
excluded from resource copying and used as the app's build-time Info.plist.

## Authentication and distribution

The app registers `ai.okou.ios` and forwards incoming callback URLs to Clerk.
Native API and OAuth callback configuration are external Clerk prerequisites;
verify them in the intended environment when diagnosing login. Keep tests on
fixture-owned identity and HTTP boundaries instead of real account sessions.

Internal TestFlight publication is integrated with release-please and the
production approval environment. See [TestFlight releases](TESTFLIGHT.md) for
App Store Connect, signing, credential setup, and publication verification.
Workflow configuration alone does not establish availability or installation of
a particular release; verify its exact version/build and device behavior.

Every `/api/` request identifies the app with `X-Client-Type: iOS`, an
`X-Client-Version` equal to the marketing version (`CFBundleShortVersionString`,
from `MARKETING_VERSION`), an `X-Client-Session-Id` generated once per API
client, and a per-request `X-Client-Request-Id`. A bundle without a stable
`x.y.z` marketing version fails configuration at launch. Signed snapshot
downloads carry none of these headers. The API can use these values to identify
the client. Builds that predate these headers cannot be identified through them.
The API owns a source-controlled
[iOS compatibility policy](../turbo/apps/api/src/lib/ios-client-compatibility.json)
for the marketing version. A null minimum leaves the floor inactive; changing
it requires the API's review and release process. HTTP 426 responses show a
blocking update screen. Preserve this response handling when changing
authentication, workspace startup, or data loading.

The iOS icon retains the Desktop flower geometry from
`desktop/Resources/symbol.svg`. Its source is `Assets/AppIcon.svg`, with a
full opaque background because iOS supplies the outer icon mask. The 1024-pixel
PNG is RGB without alpha; it removes the transparent Desktop padding that
appeared as a black border on the simulator. The SVG was exported using
`@resvg/resvg-js` 2.6.2 and encoded as RGB PNG using `pngjs` 7.0.0.

## Native UI verification

Record Xcode/SDK, simulator runtime, device, appearance, and Dynamic Type when
reporting native rendering or interaction results. If title Emoji display
incorrectly while accessibility preserves the original text, compare an isolated
simulator on another supported runtime before changing application text. Keep
the user's existing simulator and login state intact.

Use the [iOS testing standard](../docs/ios/ios-testing.md#native-acceptance-and-ci)
for runtime coverage, native input, accessibility, visual evidence, and measured
device-performance requirements. Record results in the owning PR or issue;
historical test totals and profiling samples do not establish current acceptance.

The transcript uses a native `UICollectionView` cell for each message, with
SwiftUI message content and measured row heights. A bounded batch of temporary
hosts settles Markdown layout before a snapshot is applied. Cell reuse keeps
these heights, and pending content changes wait until scrolling ends. A per-detail
ConversationScrollCoordinator owns latest/history intent and bottom-button policy;
the native collection owns motion and the anchor owns offset correction. Reading
positions update when late message markers become ready, even without a change
to the list's size or offset. Initial
positioning targets the latest prepared messages; starting a manual scroll stops
automatic following. Incoming messages preserve the reading position, while a
local send or the bottom button requests bottom positioning. Keep these behaviors
in local acceptance when changing the container. See
[Chat UI architecture](CHAT_UI_ARCHITECTURE.md) for the Telegram reference and
the presentation pipeline.

Also verify uncertain-send recovery and that signing out or switching workspaces
clears the previous workspace's chats and drafts. Record observed outcomes
separately from compilation, automated tests, and release publication.

## CI

`.github/workflows/ios.yml` runs on pull requests, merge groups, pushes to main,
and manual dispatch. Lightweight Linux jobs detect changes and test CI contracts
on every run. Native jobs start after change detection while script checks run
in parallel; archive publication and the required gate both require those checks.
On pull requests, merge groups, and manual dispatch, changes selected by
`ios/scripts/ci-changed.sh` trigger Swift formatting, property-list validation,
an app build, standalone ChatDomain/ChatData tests, and simulator tests on the
`xcode-27` runner with Xcode 27.1 and iOS 27.0 on iPhone 18 Pro. Native build/test
jobs do not rerun on main pushes; release publication consumes verified archive
evidence. The workflow owns the pinned toolchain and simulator configuration.
Device archive builds, the optional archive proof, and TestFlight signing/export
select the same Xcode version. Toolchain changes invalidate prior archive and
test fingerprints, so the merge group must produce fresh matching evidence.
The App build uses the system Git provider for locked package resolution and
reports build timings. Formatting includes both package manifests, sources,
and tests. Swift packages must match `Package.resolved`; CI checks that it
remains unchanged. Explicit locked resolution overlaps simulator startup so
Xcode initialization does not wait for the simulator before it can begin. Cache
hits still validate current inputs and never replace test execution.
Standalone package tests run on a separate macOS runner from the App build and
simulator suite. Both package and App results are required by the gate, and the
complete required iOS workflow has a 12-minute budget.
Release-only merge groups can reuse App test evidence only when exact input fingerprints match
the verified prior result; missing evidence and mixed groups run the tests.
See [archive promotion](ARCHIVE_PROMOTION.md).

`ios-build-cache.yml` refreshes shared caches after iOS changes reach main and
after a same-repository iOS workflow actually starts its native `build-test`
job, including failed or cancelled builds. A Linux check filters out workflows
whose native job was skipped. Cache writers always check out the trusted main
revision; they do not use PR code or artifacts. One Mac restores both caches,
prepares dependencies before starting the simulator, and saves only missing
entries. Exact hits skip rebuilding. Active writers finish before a newer
request starts. Manual dispatch on main remains available for recovery.

The `ci-gate-ios` check succeeds only after the required build/tests pass, or
after change detection confirms they are unnecessary. Detection failures,
cancelled jobs, and unexpectedly skipped jobs fail the gate. Preserve this
required check and its change-detection contract.

Pure `ios/` pull requests and merge groups skip Turbo TypeScript lint, types,
formatting, Knip, App/API/CLI and other JavaScript tests, benchmarks, and App/CLI
preview artifacts, along with the runtime API schema report. Existing
crates-only TypeScript exemptions remain in place.
Mixed changes, root files, and workflow changes do not receive this exemption;
main still builds release artifacts and runs the normal checks. E2E selection
continues to use Turbo package hashes and CI input detection.

The repository Security workflow also skips its JavaScript/TypeScript CodeQL
scan and pnpm audit for pure iOS changes. Semgrep, secret scanning, workflow
validation, and PR-title checks remain enabled. GitHub-managed Code Quality is
configured separately and is not controlled by these workflow conditions.
Detection must succeed before skipped jobs can pass a required gate; failed or
cancelled jobs remain failures. Desktop and Rust retain their own input filters.

Tests use HTTP-boundary fixtures and a loopback server. The CI build also clears
the Clerk key and overrides service origins with reserved `.invalid` domains.
Authentication tests use the real SDK with a fixture-owned identity service.
API fixtures provide isolated sessions and origins; unconfigured requests fail
with their method and URL. Fixture sessions reject
unknown HTTP origins locally instead of falling through to DNS, while preserving
the loopback HTTP servers used by attachment integration tests.
Production services, PR preview provisioning, and deployed end-to-end tests are
outside this scope. Passing suites do not establish live-server contracts or
physical-device visual acceptance. CI starts its configured simulator while resolving
locked dependencies, then waits for system boot readiness before asset and App
compilation. This keeps cold system-service startup out of asset-tool discovery.
When App test execution is required, `build-for-testing` produces the test
specification and `test-without-building` runs the complete in-process App suite.
Package suites execute separately. Test results and attachments remain in
`Tests.xcresult`; automatic simulator sysdiagnose collection is disabled so it
cannot delay the failure verdict. Native prerequisite waits throw after
recording a failed assertion, stopping dependent actions. Failed or cancelled
preparation still blocks the required gate. The standalone command
builds and runs every suite sequentially with an explicit local simulator:

```sh
RUNNER_TEMP="$(mktemp -d)" \
  IOS_TEST_DESTINATION='platform=iOS Simulator,id=<DEVICE_ID>' \
  bash ios/scripts/ci-test.sh
```

iOS is registered as a release-please component. Its release job in
`.github/workflows/release-please.yml` consumes the verified unsigned archive,
signs and exports it, uploads to App Store Connect, and verifies availability in
the configured internal testing group. It does not rebuild the release source.
Follow [TestFlight releases](TESTFLIGHT.md) and
[archive promotion](ARCHIVE_PROMOTION.md) for signing, exact-input evidence,
and failure recovery; a successful merge is separate from distribution.

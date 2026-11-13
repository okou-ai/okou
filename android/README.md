# Okou for Android

Native Kotlin/Jetpack Compose client shell inside the Okou monorepo. Open this
directory in Android Studio, or use the checked-in Gradle Wrapper. No pnpm,
database, API service, account credentials, or local Web server is needed.

Signed-out launches open the native Clerk login page. After authoritative
membership and workspace bootstrap, the application provides **Home and Settings** destinations,
the native chat list, and device-local Light/Dark/Follow system
appearance. Compact windows use bottom navigation; wider windows use a rail.
Home remains usable while Preferences DataStore loads or reports an IO error;
Settings exposes loading, saving and retry states. Appearance is confirmed from
the stored data stream and restored across relaunch/configuration changes.
Owned UI resources cover the twelve current Web locales, with distinct
Simplified/Traditional Chinese resources. Workspace settings select the eight
Web color palettes and the languages allowed by canonical `supportedLocales`.
Palette/language preferences synchronize through the member/workspace API;
Light/Dark/Follow system remains device-local and independent.

The workspace presentation owner retains chat-list state across navigation and
configuration changes. Switching account/workspace or signing out retires that owner.
Authentication and canonical preferences/member-memory bootstrap use production
by default; see [native authentication](AUTHENTICATION.md)
for public staging overrides, provider setup and verification boundaries. Chat
Send, push registration and store publication remain later delivery. Debug uses
`ai.okou.android.debug`; the application namespace is `ai.okou.android`.

Confirmed chat and Project navigation follows Web's snapshot/event-log model using an
application-owned Room/SQLite database under `noBackupFilesDir/chat-list`, excluded
from backups. AndroidX's bundled SQLite driver avoids CursorWindow's single-row
limit. Chat threads and Projects have independent snapshots, event tails and
cursors. Snapshots are stored per entity, and confirmed tail events append through
transactions with their synchronization position. Changed network datasets await
persistence and readback before publication. Unchanged catch-up reuses the confirmed
dataset without another disk transaction; changed Agent/settings references still
persist independently. A storage failure leaves the network result usable with a
visible cache warning, and a later refresh retries unsaved data.
Data is scoped to API origin/user/workspace and the current authorization snapshot;
an older synchronization cannot replace a newer persisted tail. Last-confirmed
Agent/Project references keep the scoped list usable after a process restart while
their network reads are unavailable. Cache display precedes network catch-up;
chat tails over 100 events attempt a server-snapshot rebase after catch-up, with
optional rebase server failures preserving the synchronized result, as on Web.
Project tails retain their event identities. Chat's absent cursor refreshes its
snapshot; Project's valid zero cursor continues through events. An expired cursor
rebuilds from the server and resumes catch-up. A freshly loaded
snapshot that immediately expires or a page that makes no progress fails the read.
There are no fixed response-byte, row-count, page-count or per-scope disk limits.
JSON decoding and Room work run off Main; canonical responses and signed archives
are decoded from streams without a full response byte-array/String copy.
The versioned database contains only rebuildable server-confirmed data;
unsupported local schemas may be recreated, never migrated together with drafts
or credentials. Room exports its schema under `app/schemas` through its Gradle/KSP
integration. A saved list and the last status refresh do not establish current
network freshness. Signed archive URLs, credentials and transient indicators are
not persisted. No local message history or durable draft store is introduced.

## Prerequisites and Setup

Use JDK 21, Python 3.9+, curl and unzip on Linux/macOS. The build targets JVM 17.
Versions are pinned in `gradle/libs.versions.toml` and
`gradle/wrapper/gradle-wrapper.properties`: Gradle 9.8.2, Kotlin/Compose compiler
2.4.21, AGP 9.5.0 with built-in Kotlin, Compose BOM 2026.06.01 and Clerk 1.4.1.
Compile SDK/build tools are 36; targetSdk remains 35 and minSdk remains 24
(Android 7.0). Java 21 runs the build; app bytecode targets JVM 17.
These pins align with the Clerk SDK release and are validated together.

From the repository root:

```bash
# Review/accept the Android SDK terms through sdkmanager interactively:
bash android/scripts/setup-sdk.sh

# Or explicitly authorize non-interactive license acceptance:
bash android/scripts/setup-sdk.sh --accept-licenses
```

The script downloads checksum-verified command-line tools `13114758` and installs
`platforms;android-36`, `build-tools;36.0.0`, and platform-tools. It installs no
emulator, system image, NDK, IDE, Java, or global shell-profile changes. Set
`ANDROID_HOME` for an existing/custom SDK; otherwise setup/check default to
`${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk`.

For direct Gradle and adb commands, export that path:

```bash
export ANDROID_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Android Studio's ignored `local.properties` can select another SDK for IDE
builds. Keep SDKs, local paths, keystores, and build outputs out of Git. Windows
users can install the same platform/build-tools through Android Studio and use
`gradlew.bat`; the shell bootstrap is Linux/macOS only.

## Verification

From the repository root:

```bash
bash android/scripts/check.sh
```

This audits source-manifest entry points, generated colors, Kotlin/Gradle formatting,
state-holder tests, Robolectric Compose/lifecycle interactions, Android lint, and debug APK
assembly. It uses two Gradle workers, a 1536 MB build heap and in-process Kotlin
compilation by default for small sandboxes.

Run the app's local JVM tests through Android Gradle Plugin with the configured
Android SDK; no emulator is needed:

```bash
cd android
./gradlew :app:testDebugUnitTest --no-daemon
```

The chat suites exercise real disk reopening, the generated canonical HTTP/codec
boundary, cursor/replay recovery and retired-owner publication. `ChatListRootTest`
holds real HTTP responses while exercising native navigation. `NativeChatListTest`
runs the list/Settings/recreation journey on the existing API 35 managed device.

The plain Kotlin state-holder tests do not themselves use Android APIs. An
independent Kotlin/JVM test entry could compile those same sources without an
SDK, without splitting production modules. The command above uses the app's
standard Android build configuration; the project maintains one test entry.

Other focused commands, from `android/`:

```bash
./gradlew spotlessApply
./gradlew :app:lintDebug :app:assembleDebug
python3 scripts/sync-design-tokens.py --check
python3 scripts/ci-changed.test.py
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. Install and launch on an
authorized connected device or emulator:

```bash
adb devices
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ai.okou.android.debug/ai.okou.android.MainActivity
```

Check the intended device before installing; select it with `adb -s <serial>`
when several are connected. Device appearance, keyboard/IME, accessibility,
system back, background execution, performance and actual installation require
native acceptance. Robolectric exercises host-side Compose interactions and
does not establish those device properties. Linux sandboxes without `/dev/kvm`
are useful for compilation/tests but do not provide accelerated emulator evidence.

### Instrumented Android Tests

The `androidTest` suite launches the real Activity and uses UI Automator to
exercise chat-list navigation and Back, appearance restoration with a new Activity
owner, native system bars and live platform night-mode changes, plus palette/language
changes through native app-language recreation. The existing JVM/Robolectric tests retain the
broader state/error/localization matrix.

On a Linux x64 host with readable/writable `/dev/kvm`, run from `android/`:

```bash
./gradlew :app:pixel2Api35DebugAndroidTest \
  -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect \
  --no-daemon
```

AGP manages one Pixel 2, API 35, 64-bit AOSP device: emulator/image provisioning,
snapshots, installation, test execution and teardown. Accept the SDK licenses
using the setup procedure above before provisioning. Initial downloads take
additional time and disk space. Software GPU rendering supports headless CI;
CPU virtualization still requires KVM on Linux. This configuration targets the
CI phone cohort, not a measured performance or physical-device matrix.

Compile/package the suite without starting a device:

```bash
./gradlew :app:assembleDebugAndroidTest --no-daemon
```

Use an isolated test emulator. The fixture snapshots/restores app preferences,
platform night mode, app locale, fixture API preferences and chat-list cache,
scopes its UI Automation shell permissions, and closes its Activity owners on
success and failure. Fixtures use a local HTTP server or external-service adapters
without contacting a live backend. A new Activity owner is not a process-death
restoration test.

Managed-device HTML reports are under `app/build/reports/androidTests/`, with
JUnit results/logcat under `app/build/outputs/androidTest-results/`. Official
Test Storage retrieves failure screenshots and accessibility hierarchies under
`app/build/outputs/managed_device_android_test_additional_output/` before device
teardown. These images are diagnostics, not screenshot-golden assertions.
CI retains these outputs and the Gradle execution log for seven days in
`android-instrumentation-api35-<revision>` artifacts.

## Components and Authority

- `app`: native Activity, Home/Settings routes, retained presentation owners,
  confirmed chat-list storage, local preferences and the shared native theme.
  Plain business logic can stay
  free of Android UI types without needing a separate Gradle module.
- `scripts`: SDK setup, verification, shared-token synchronization and CI selection.

[CCState principles on Android](../docs/android/android-ccstate.md) covers
single sources of truth, derivation, semantic actions and async ownership using
native Kotlin/Jetpack APIs. TS runtime/API parity is not required. The app uses
ordinary ViewModel actions and collectAsStateWithLifecycle rather than a custom
Store, dependency graph, command visitor or cancellation signal.
AppearanceModelTest exercises real presentation/decoding against the
DataStore IO boundary, including read/write recovery, confirmation ordering,
cancellation and actual file-backed reopen. OkouAppTest and MainActivityTest
exercise real routes, chat filters, back/configuration retention,
appearance and adaptive navigation. LocalizedResourcesTest verifies native
locale/script matching on APIs 24 and 35. These are local tests; they do not
establish physical-device IME/rendering or startup budgets.
MemberPreferencesModelTest covers confirmed versus pending selections, failed
saves/retry/readback and retired work. PaletteColorsTest resolves all sixteen
mode/palette combinations from generated resources; LegacyLanguageSettingsTest
exercises pre-Android13 app-language changes through the real Activity.
Add modules/shared helpers only for actual application boundaries. Preferences
DataStore has one lazy process owner; its observation starts asynchronously at
the retained presentation owner and does not gate Home on disk IO.
Shared font bytes/licenses are sourced from `ios/Okou/Resources/Fonts` during
the build; the app does not keep a second font copy in source. Its launcher
vector retains the geometry from `ios/Assets/AppIcon.svg`. Native navigation
vectors use Lucide geometry; its shared license is also packaged under
`assets/licenses`. No runtime font or icon download is needed.

## CI and Distribution

`.github/workflows/android.yml` checks PRs, merge groups, main pushes and manual
runs. Selection includes Android sources/docs, CI inputs, Web semantic colors,
and shared font/color-evaluator assets. One native job runs all local tests,
lints, assembles, and uploads the debug APK for seven days.
A separate Linux/KVM job runs the instrumented suite on the managed API 35
phone. The final `ci-gate-android` check always reports an aggregate result. It
requires successful detection and both selected JVM/build and instrumentation
jobs to succeed; only explicit unselected results permit skipped native checks.
Cancellation, failure or an unexpected skip fails the gate. Emulator functional
evidence does not establish OEM input-method behavior or physical-device startup
budgets.

The shared security workflow retains Semgrep scanning. Its result handler
recognizes the intentionally public MAIN/LAUNCHER only after the strict source
manifest audit; this is a location/contract exception, not a rule-wide exclusion
or increased count baseline. See [public entry points](../docs/android/android-development.md#public-android-entry-points)
before adding exported components, deep links or external Intent handling.

The validation workflow builds and tests the application; it does not publish
releases or configure FCM credentials.

## GitHub Releases

Release Please manages the independent `android` component through
`version.txt` and `.release-please-manifest.json`. Gradle reads `version.txt` for
`versionName` and derives a monotonic `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`; minor and patch must be below 1,000
and the result must fit a positive Android integer.

When the normal release PR is merged, `release-please.yml` creates the
`android-vX.Y.Z` release. Its single `publish-android` job checks out the exact
release target, builds an unsigned APK, signs and verifies it, then uploads
`okou-android-X.Y.Z.apk` to that release. The compatibility gate recognizes
publication only after the APK upload completes. Store processing is not part
of this distribution path.

### Release Signing

Configure exactly these three entries in **Settings → Environments → production**:

| Type     | Name                                | Content                                             |
| -------- | ----------------------------------- | --------------------------------------------------- |
| Secret   | `ANDROID_RELEASE_KEYSTORE_BASE64`   | Complete password-encrypted PKCS12 keystore, Base64 |
| Secret   | `ANDROID_RELEASE_KEYSTORE_PASSWORD` | Shared keystore/private-key password                |
| Variable | `ANDROID_RELEASE_KEY_ALIAS`         | The signing key's alias inside the keystore         |

An administrator provisions the values through the secure GitHub UI or stdin,
never command-line password arguments, chat or source. Base64 is an encoding;
retain the keystore's password encryption. Encoded content must fit GitHub's
48 KB Secret limit. Do not add duplicate repository/organization values or an
expected-certificate, owner or backup-date Variable.

Reuse the same durable key for future releases. New production keys should
have long-lived certificates (Android recommends at least 25 years). Keep a
secure recoverable original of the keystore and password outside the repository;
GitHub's Secret API cannot export them. A password/container change must preserve
the private key and certificate and update that recovery copy. Do not generate
a replacement key to fix a lost password or file. A genuine key change requires
an explicit migration decision.

Build, signing and upload use runner-local files in the same production job;
there is no Actions artifact transfer. The signing values are injected only
into the signing step. Gradle/plugins and any other process on that runner are
still trusted production code: step-scoped environment injection does not
isolate earlier build processes from signing. Existing production environment
reviewer/branch rules apply; there is no additional approval gate.

The signing script decodes the key in a private temporary directory, supplies
the password through environment-based tool options and deletes private files
on exit or handled cancellation. Missing/malformed inputs, wrong password/alias,
APK package/version mismatch and invalid signatures fail before upload, without
temporary/debug fallback. It verifies the actual signer certificate against the
selected keystore alias and preserves 16 KiB ZIP alignment. The logged SHA-256
is derived public certificate information; it cannot independently detect an
unintentionally replaced, otherwise valid keystore. Public certificates and
fingerprints can be inspected from the keystore or APK when needed.

Publication verifies the release tag's resolved commit against the exact
checkout. Upload never overwrites an existing asset. Historical releases signed
with disposable keys keep their warnings; new durable-signed releases do not
receive that warning. Users of an old disposable-key APK can need to uninstall
and reinstall once, losing local app data. Stable update identity begins with
the first APK signed by the durable key.

### Signing And Upgrade Verification

Run the fixture suite with JDK 21 and the pinned SDK installed:

```bash
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
python3 android/scripts/release-signing.test.py
```

The normal Android checks include this suite. It uses an ephemeral test-only
PKCS12 and real signing tools to verify increasing versions retain one signer,
invalid configuration/signature rejection, cleanup and refusal to overwrite.
Its manifest-only APK fixtures do not prove installation or production-key access.

For protected acceptance, use the configured durable key to sign two builds
of the real application with increasing `versionCode`, without publishing test
versions. Install the first, open Settings and save an appearance preference:

```bash
adb install first.apk
# Open the app and change its saved appearance in Settings.
adb install -r second.apk
adb shell am force-stop ai.okou.android
adb shell am start -n ai.okou.android/.MainActivity
```

Confirm the upgraded package version and the saved appearance after relaunch.
Inspect each APK with `apksigner verify --verbose --print-certs` and compare its
certificate with the previously distributed durable-signed APK when available.
The first durable release bootstraps that identity. Report fixture tests, real
production signing, device upgrade/data retention and Release publication as
separate evidence; a configured Secret name proves only its presence.

## Canonical API Bindings And Transport

Selected TypeScript/Zod contracts in
`turbo/packages/api-contracts/src/kotlin-bindings/bindings.ts` generate the
Kotlin serialization models, Retrofit suspend declarations and client constants
in `app/src/main/kotlin/ai/okou/android/api/generated`. The same route references
register Android's installed-reader inventory, including error responses.
Add only contracts a native consumer actually needs. Unsupported schema shapes
fail generation; do not replace them with untyped JSON or parallel handwritten DTOs.

The selected emitter supports string-keyed records, root array/map aliases and
typed object unions with disjoint string tags, unique required wire keys,
required null/non-null selectors or forbidden/required key pairs.
Union selection rejects unknown or ambiguous variants and preserves the original
wire object without inserting a discriminator wrapper. Nullable/optional fields,
combined string-enum vocabularies, explicit nulls and empty tuples retain their
wire representation. Unsupported mixed/ambiguous unions, arbitrary tuples and
unrepresented values still fail generation. Canonical numeric literal zero has
an explicit wire representation. Optional never fields are omitted and rejected
when present. Only deliberately unconstrained canonical JSON leaves become
`JsonElement`; optional leaves preserve absence separately from explicit JSON null.
This is a typed reader boundary,
not a second implementation of Zod's complete validation/transform runtime.

Retrofit query support is limited to canonical scalar fields; omitted optional
values stay absent from the URL. Server-defaulted scalars use explicit arguments.
Required string path parameters retain Retrofit's normal segment escaping.
Supported scalar object-union queries generate typed alternatives and an extension
method that validates the canonical branch constraints before invoking the wire
method. Unsupported or ambiguous compositions still fail generation. Non-200
success bindings require a future actual consumer before expansion.

Regenerate from the repository root with the Turbo workspace dependencies installed:

```bash
cd turbo
pnpm -F @okouai/api-contracts generate:kotlin
cd ../android
./gradlew spotlessApply
```

The generated source is committed, so ordinary Android builds need no Node/pnpm.
To verify it against the current canonical contracts, from `turbo/`:

```bash
pnpm -F @okouai/api-contracts check:kotlin
pnpm -F @okouai/api-contracts lint-android-api-consumption
```

Generation/checking also owns test-only chat read fixtures under
`app/src/test/kotlin/ai/okou/android/api/fixtures` and
`app/src/test/resources/api-bindings`. They are derived from the real canonical
snapshot, lifecycle, indicator, agent, project and persisted-archive schemas.
`ChatReadBindingsTest` compiles/decodes those generated types with the existing
kotlinx.serialization and Retrofit/MockWebServer setup, including branch rejection,
nullable/empty values and optional query construction. The archive fixture uses
the validator's input representation for documented historical/default values;
semantic normalization remains the consuming domain's responsibility.

The separate `historyfixtures` test namespace and `ChatHistoryBindingsTest` prove
canonical event snapshots, raw-row pages, paired cold/warm cursors, thread detail
and the no-body mark-read POST. Real Kotlin codecs and Retrofit/MockWebServer verify
raw event variants, opaque structured payloads, optional JSON nulls, forbidden
fields, path escaping and query validation. History routes remain outside the
installed reader inventory until the runtime history consumer is integrated.

These test-only fixtures prove compilation/decoding and do not register installed
consumers. The native chat list uses the production bindings and route inventory
selected in `bindings.ts`. `check:kotlin` and the focused generator tests detect
fixture drift; consumption lint checks the production generated-client boundary.
Run the reader proof from `android/`, with the SDK configured as above:

```bash
./gradlew :app:testDebugUnitTest --tests ai.okou.android.api.ChatReadBindingsTest --no-daemon
```

Drift comparison ignores comments, whitespace and optional trailing commas;
Android Spotless owns formatting. Type/method/path changes still fail. Production
Retrofit declarations belong in the generated boundary; the consumption check
rejects manual `retrofit2.http` declarations/imports and raw API path literals
elsewhere, including aliased/qualified declarations. First-party calls use this
service; direct arbitrary HTTP in features is outside the transport contract.

`ApiClient` binds an HTTPS origin, installed `BuildConfig.VERSION_NAME`, session
identity and a suspending `WorkspaceTokenProvider` resolved for each request.
The provider may reuse an unexpired token and refresh it when needed. Its ordinary methods
cover workspace/member preferences and the native chat-list reads. The authentication
owner captures the right origin/user/workspace, cancels retired consumers and
closes their client; token renewal itself does not replace durable identity.
Construction starts no token resolution or network work. The authenticated root
owns workspace bootstrap, and the retained chat-list owner starts its independent
reads after authorization. Native UI renders while responses remain pending;
protected data/actions stay behind their actual prerequisites.

The client returns typed HTTP/network/incompatible-response failures, propagates
coroutine cancellation, streams successful JSON responses without an application
size cutoff, limits error envelopes to 64 KiB after gzip decompression, and closes
responses. Error status remains
available when its envelope is malformed/oversized. Unknown fields permit additive
responses; required nullable fields and enum values retain the generated reader's contract.
JSON field types follow Kotlin serialization semantics rather than recreating
Zod's complete validation runtime. Decode failures expose a typed incompatible
response error without serializer messages/input snippets that could disclose
response data through exception reporting.

Both clients accept a finite `callTimeout` for the owner's HTTP budget, with a
30-second default. A deadline while consuming an incomplete error body preserves
the already received HTTP status, including the blocking 426 state; the absent
envelope metadata remains unknown. Coroutine cancellation still propagates.

HTTP 426 retains a read-only `updateRequired` state and blocks further calls
from that client; a malformed envelope keeps the minimum version unknown.
The authenticated root observes this state and presents its native blocking
update destination. No self-clear/retry is provided for an installed
version that needs an update. The backend Android floor starts unset; see
[Android compatibility](../docs/deployment-compatibility.md#android-contract-gate).

GitHub Release is the Android distribution source for the compatibility gate.
Publish the packaged APK as a nonempty `.apk` asset on a non-draft, non-prerelease
`android-vX.Y.Z` release, with the tag matching the APK's `versionName`. CI reads
release metadata and uses the highest qualifying version among the 20 highest
stable Android tags; it does not require an app-store availability check. The
publisher owns APK signing, the packaged version and installability. A local
build or an Actions artifact alone is not publication. The [release pipeline](#github-releases)
owns packaging and upload; a floor raise still requires a reviewed policy change
after the compatible build is available.

API requests do not follow redirects or automatically retry connection/status
failures, including `503 Retry-After: 0`. A lost response is not remote rollback;
operation owners decide retry/readback. `SignedTransferClient` owns a separate
HTTP client without the token provider, cookies or API/client headers. It accepts
signed HTTPS download/upload URLs, rejects credential-header injection and
redirects, and supports both explicit-limit byte downloads and stream consumers.
The chat/Project archive readers use streaming JSON. File/resume owners should add
their own file APIs with the actual feature.

Release network policy requires HTTPS. Debug permits cleartext only for
`localhost`, `127.0.0.1` and `::1`, for local transport fixtures/development.
This does not enable cleartext production endpoints or trust arbitrary certificates.

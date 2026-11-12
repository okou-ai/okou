# Okou for Android

Native Kotlin/Jetpack Compose client shell inside the Okou monorepo. Open this
directory in Android Studio, or use the checked-in Gradle Wrapper. No pnpm,
database, API service, account credentials, or local Web server is needed.

The application currently provides native **Home and Settings** destinations,
an editable local draft preview, and device-local Light/Dark/Follow system
appearance. Compact windows use bottom navigation; wider windows use a rail.
Home remains usable while Preferences DataStore loads or reports an IO error;
Settings exposes loading, saving and retry states. Appearance is confirmed from
the stored data stream and restored across relaunch/configuration changes.
Owned UI resources cover the twelve current Web locales, following the device
language with distinct Simplified/Traditional Chinese resources. Account-backed
palette/language selection is separate future work.

The Activity retains native text, selection and IME state across navigation
and configuration changes; previews are independent immutable text snapshots.
It does not authenticate, send chats, contact
production, register push, or publish to a store. Debug uses
`ai.okou.android.debug`; the application namespace is `ai.okou.android`.

## Prerequisites and Setup

Use JDK 21, Python 3.9+, curl and unzip on Linux/macOS. The build targets JVM 17.
Versions are pinned in `gradle/libs.versions.toml` and
`gradle/wrapper/gradle-wrapper.properties`: Gradle 8.11.1, Kotlin 2.1.20,
AGP 8.9.2, Compose BOM 2025.04.01, compile/target SDK 35, minSdk 24.
These are a verified foundation toolchain, not a claim to be the latest releases.

From the repository root:

```bash
# Review/accept the Android SDK terms through sdkmanager interactively:
bash android/scripts/setup-sdk.sh

# Or explicitly authorize non-interactive license acceptance:
bash android/scripts/setup-sdk.sh --accept-licenses
```

The script downloads checksum-verified command-line tools `13114758` and installs
`platforms;android-35`, `build-tools;35.0.0`, and platform-tools. It installs no
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
exercise platform keyboard/insets and Back, retained editor/caret state,
appearance restoration with a new Activity owner, native system bars and live
platform night-mode changes. The existing JVM/Robolectric tests retain the
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
platform night mode and keyboard settings, scopes its UI Automation shell
permissions, and closes its Activity owners on success and failure. It does not
contact a backend. A new Activity owner is not a process-death restoration test.

Managed-device HTML reports are under `app/build/reports/androidTests/`, with
JUnit results/logcat under `app/build/outputs/androidTest-results/`. Official
Test Storage retrieves failure screenshots and accessibility hierarchies under
`app/build/outputs/managed_device_android_test_additional_output/` before device
teardown. These images are diagnostics, not screenshot-golden assertions.
CI retains these outputs and the Gradle execution log for seven days in
`android-instrumentation-api35-<revision>` artifacts.

## Components and Authority

- `app`: native Activity, Home/Settings routes, retained presentation owners,
  pure preview snapshots, local preference storage and the shared native theme.
  Plain business logic can stay
  free of Android UI types without needing a separate Gradle module.
- `scripts`: SDK setup, verification, shared-token synchronization and CI selection.

[CCState principles on Android](../docs/android/android-ccstate.md) covers
single sources of truth, derivation, semantic actions and async ownership using
native Kotlin/Jetpack APIs. TS runtime/API parity is not required. The app uses
ordinary ViewModel actions and collectAsStateWithLifecycle rather than a custom
Store, dependency graph, command visitor or cancellation signal.
DraftPreviewStateHolderTest covers validation, verbatim snapshots and owner
isolation. AppearanceModelTest exercises real presentation/decoding against the
DataStore IO boundary, including read/write recovery, confirmation ordering,
cancellation and actual file-backed reopen. OkouAppTest and MainActivityTest
exercise real routes, native editor selection, back/configuration retention,
appearance and adaptive navigation. LocalizedResourcesTest verifies native
locale/script matching on APIs 24 and 35. These are local tests; they do not
establish physical-device IME/rendering or startup budgets.
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

The validation workflow does not publish releases. FCM credentials are not
configured. The transport below is available to feature owners; the local shell
still makes no authenticated API requests.

## GitHub Releases

Release Please manages the independent `android` component through
`version.txt` and `.release-please-manifest.json`. Gradle reads `version.txt` for
`versionName` and derives a monotonic `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`; minor and patch must be below 1,000
and the result must fit a positive Android integer.

When the normal release PR is merged, `release-please.yml` creates the
`android-vX.Y.Z` release. Its `publish-android` job checks out the exact release
target, builds the release APK, signs and verifies it, then uploads
`okou-android-X.Y.Z.apk` to that release. The compatibility gate recognizes
publication only after the APK upload completes. Store processing is not part
of this distribution path.

Signing is temporarily disposable: the build creates a fresh keystore, keeps
its password in the signing tools' environment, and deletes the key on exit.
Different releases therefore do not promise in-place upgrades. A user may need
to uninstall an earlier APK, which removes local application data. The Release
notes carry this limitation. Stable production signing is separate follow-up
work before relying on upgrade continuity.

## Canonical API Bindings And Transport

Selected TypeScript/Zod contracts in
`turbo/packages/api-contracts/src/kotlin-bindings/bindings.ts` generate the
Kotlin serialization models, Retrofit suspend declarations and client constants
in `app/src/main/kotlin/ai/okou/android/api/generated`. The same route references
register Android's installed-reader inventory, including error responses.
Add only contracts a native consumer actually needs. Unsupported schema shapes
fail generation; do not replace them with untyped JSON or parallel handwritten DTOs.

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

Drift comparison ignores comments, whitespace and optional trailing commas;
Android Spotless owns formatting. Type/method/path changes still fail. Production
Retrofit declarations belong in the generated boundary; the consumption check
rejects manual `retrofit2.http` declarations/imports and raw API path literals
elsewhere, including aliased/qualified declarations. First-party calls use this
service; direct arbitrary HTTP in features is outside the transport contract.

`ApiClient` binds an HTTPS origin, installed `BuildConfig.VERSION_NAME`, session
identity and a suspending `WorkspaceTokenProvider` resolved for each request.
The provider may reuse an unexpired token and refresh it when needed. Its ordinary methods
cover current workspace and member preference bootstrap. The authentication
owner captures the right origin/user/workspace, cancels retired consumers and
closes their client; token renewal itself does not replace durable identity.
Construction starts no token resolution or network work and is not wired into
the local shell. A real bootstrap must render native UI while responses remain
pending and keep protected data/actions behind their actual prerequisites.

The client returns typed HTTP/network/incompatible-response failures, propagates
coroutine cancellation, limits success bodies to 1 MiB and error envelopes to
64 KiB after gzip decompression, and closes responses. Error status remains
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
The real authenticated root must observe this state and present its native
blocking update destination. No self-clear/retry is provided for an installed
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
redirects, and requires a download byte limit. Large file/streaming/resume owners
should add their own bounded file APIs with the actual feature.

Release network policy requires HTTPS. Debug permits cleartext only for
`localhost`, `127.0.0.1` and `::1`, for local transport fixtures/development.
This does not enable cleartext production endpoints or trust arbitrary certificates.

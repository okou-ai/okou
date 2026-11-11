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
The final `ci-gate-android` check always reports an aggregate result. It requires
successful detection and every selected job to succeed; only an explicit
unselected result permits skipped native checks.

The shared security workflow retains Semgrep scanning. Its result handler
recognizes the intentionally public MAIN/LAUNCHER only after the strict source
manifest audit; this is a location/contract exception, not a rule-wide exclusion
or increased count baseline. See [public entry points](../docs/android/android-development.md#public-android-entry-points)
before adding exported components, deep links or external Intent handling.

This workflow is not a signing or store-publication pipeline. No release-please
component, backend client header/floor, Android API consumption inventory, or
FCM credentials are configured. Those boundaries must be implemented with the
features that consume them; this scaffold makes no authenticated API requests.

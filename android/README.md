# Okou for Android

Native Kotlin/Jetpack Compose foundation inside the Okou monorepo. Open this
directory in Android Studio, or use the checked-in Gradle Wrapper. No pnpm,
database, API service, account credentials, or local Web server is needed.

The application currently provides an editable **local draft preview** backed
by the real Kotlin CCState graph. It does not authenticate, send chats, contact
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

This audits source-manifest entry points, generated colors, Kotlin/Gradle formatting, core tests, native
observer tests, a Robolectric Compose interaction, Android lint, and debug APK
assembly. It uses two Gradle workers, a 1536 MB build heap and in-process Kotlin
compilation by default for small sandboxes.

The core can be tested without configuring Android projects or an SDK:

```bash
cd android
./gradlew --settings-file core.settings.gradle.kts :ccstate:test spotlessCheck --no-daemon
```

The alternate settings flag is supported by pinned Gradle 8.11.1 and emits a
Gradle 9 deprecation warning. Update that entry point when upgrading Gradle;
do not remove SDK-independent verification.

Other focused commands, from `android/`:

```bash
./gradlew spotlessApply
./gradlew :ccstate-compose:testDebugUnitTest :app:testDebugUnitTest
./gradlew :ccstate-compose:lintDebug :app:lintDebug :app:assembleDebug
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

- `ccstate`: Kotlin/JVM graph, independent of Android and coroutines libraries.
- `ccstate-compose`: Compose provider, observation/loadable and command adapters;
  Deferred resolution uses a caller-owned coroutine scope.
- `app`: native Activity, ViewModel owner, reusable theme, local draft surface.
- `scripts`: SDK setup, verification, shared-token synchronization and CI selection.

[Kotlin CCState](../docs/android/android-ccstate.md) records the pinned TS
contract and intentional Kotlin/JVM differences. Preserve the upstream MIT
notice in [ccstate/THIRD_PARTY_NOTICES.md](ccstate/THIRD_PARTY_NOTICES.md).
The [CCState test map](ccstate/TESTING.md) links upstream scenarios to the
core/adapter suites and records native-only coverage and intentional exclusions.
Compose adapter integration tests belong to `ccstate-compose`; the app's
own test covers the consuming draft screen.
Shared font bytes/licenses are sourced from `ios/Okou/Resources/Fonts` during
the build; the app does not keep a second font copy in source. Its launcher
vector retains the geometry from `ios/Assets/AppIcon.svg`.

## CI and Distribution

`.github/workflows/android.yml` checks PRs, merge groups, main pushes and manual
runs. Selection includes Android sources/docs, CI inputs, Web semantic colors,
and shared font/color-evaluator assets. Core verification has no SDK setup;
the native job tests, lints, assembles, and uploads the debug APK for seven days.
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

# Okou for Android

Native Kotlin/Jetpack Compose client shell inside the Okou monorepo. Open this
directory in Android Studio, or use the checked-in Gradle Wrapper. No pnpm,
database, API service, account credentials, or local Web server is needed.

Signed-out launches open the native Clerk login page. After authoritative
membership and workspace bootstrap, the application provides a native conversation
list and history reader. Projects expand directly in the conversation sidebar;
selecting a conversation opens its history, Back returns to the retained list
position, and the avatar opens Settings. Settings provides device-local
Light/Dark/Follow system appearance. The conversation list remains usable while
Preferences DataStore loads or reports an IO error;
Settings exposes loading, saving and retry states. Appearance is confirmed from
the stored data stream and restored across relaunch/configuration changes.
Owned UI resources cover the twelve current Web locales, with distinct
Simplified/Traditional Chinese resources. Workspace settings select the eight
Web color palettes and the languages allowed by canonical `supportedLocales`.
Palette/language preferences synchronize through the member/workspace API;
Light/Dark/Follow system remains device-local and independent.

My Okou in Settings reads and edits the signed-in user's personal Instructions
for the selected workspace. It uses the existing `singleAgent` availability and
canonical Instructions API without blocking chat or Appearance while loading.
Saves always carry the displayed base version; a concurrent Web edit preserves
the local draft and requires explicitly loading the latest version. Clearing the
field and saving clears Instructions. A lost save response reads the server back;
an unresolved attempt stays frozen until that read or an explicit retry with the
same version resolves it.

Activities for the same API origin/user/workspace share one editing transaction
while retaining their own native selection and session authorization. Request
progress, read failures and persisted intent are separate facts. Preparation
must acknowledge that exact frozen intent before HTTP; a superseded queued write
is not a durability receipt. Cancelling or failing preparation restores the
editable intent, while cancellation after dispatch preserves the unknown attempt.
Settlement only replaces its captured local revision. Retiring a controller
cancels its own network work; the shared editor is released after the last
controller detaches, and accepted local IO remains application-owned.

Unsaved text and unresolved save attempts live in a separate application-owned,
versioned AtomicFile store under `noBackupFilesDir/personal-instructions`.
Format 1 contains content, the base response and attempt state, scoped by normalized
API origin/user/workspace. It contains no credentials and survives editor retirement
and process restart independently of the rebuildable chat cache. Disk errors retain
accepted edits in memory and expose retry; malformed files are never silently reset.
Activity saved state carries only the native selection, keeping large text out of
the size-limited Binder bundle.
Feature-local 403/404 does not sign out the workspace. Visible/foreground/manual
refresh checks other clients; automatic live Instructions updates remain later work.

The workspace presentation owner retains chat-list state across navigation and
configuration changes. Switching account/workspace or signing out retires that owner.
Authentication and canonical preferences/member-memory bootstrap use production
by default; see [native authentication](AUTHENTICATION.md)
for public staging overrides, provider setup and verification boundaries.
Push registration and store publication remain later delivery. Debug uses
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
not persisted in the chat cache. Personal Instructions drafts use the separate
intent store described above.

Conversation history shares this cache and its workspace authorization lease.
Room schema v2 adds `history_scopes` (thread, authorization, canonical event format,
paired cursor and confirmation time) and `history_events` (lossless raw event JSON,
identity and sequence). Rebuildable v1 databases are recreated; there is no draft
or credential migration. Snapshot replacement and tail appends commit atomically,
and disk readback precedes publication when storage succeeds. A failed write keeps
the confirmed network result available and retries it on refresh. Thread-local
403/404 clears that history without retiring the workspace.

The reader streams gzip NDJSON snapshots and follows canonical paired-cursor raw
rows, including valid zero cold start, missing snapshot fallback, gap-tolerant
sequences, an extra cold confirmation page and expired-cursor rebuild. Malformed
or truncated data never publishes a partial checkpoint. Projection preserves
revocation/rejection and queued/running/stopped/failure facts. CommonMark 0.24.0
renders selectable native text/code; references and unsupported structured parts
remain explicit with their original JSON. HTML remains literal text, and reading
does not automatically download attachments or open links. Interactive viewers
remain later work.

An authorized, resumed, visible conversation marks read only after successful
network confirmation and display. This calls the existing server mark-read POST
and refreshes independent indicators; cached display, hidden navigation and held
requests do not mark read. Local caches never establish server freshness.
The workspace retains synchronization and confirmed content. Each visible visit
owns a separate read session, including request cancellation, read errors and
within-visit deduplication. Hiding the reader, backgrounding or changing selection
ends that session; reopening creates a fresh one even when event rows are unchanged.
Display acknowledgments identify a captured network confirmation, not whatever
state is newest when an effect runs. The existing server API selects its current
run-finish watermark; it does not accept a displayed event cursor.

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
runs list → history → Back, Settings and recreation on the existing API 35 managed
device. History tests cover real gzip transport, malformed archives, paired
cursors, disk reopen, dirty retry, retired results and visible read confirmation.

Instructions suites exercise conditional HTTP saves, owner validation, durable
draft reopening/isolation, local IO failures and uncertain-write reconciliation.
They also cover shared controllers, superseded preparation receipts and retirement
before dispatch without incorrectly freezing an editable draft.
`PersonalInstructionsSettingsTest` holds the actual HTTP read while Settings stays
usable and checks native selection through conflicts. `NativeInstructionsTest`
uses the API 35 device for multiline input, IME/system Back, Activity recreation,
save and external-version conflict. These tests use isolated fake server content;
they do not modify production Instructions or establish OEM keyboard coverage.

The plain Kotlin state-holder tests do not themselves use Android APIs. An
independent Kotlin/JVM test entry could compile those same sources without an
SDK, without splitting production modules. The command above uses the app's
standard Android build configuration; the project maintains one test entry.

Text composer suites exercise the real private journal, shared controllers, frozen
submission identity, duplicate taps, newer edits, disconnected acceptance and
explicit original-ID recovery. `ChatComposerApiTest` uses the installed generated
201 methods and bounded input-status read; `ChatComposerRootTest` holds default
availability and write responses through the actual native route.
`NativeTextSendTest` covers new/existing sends, IME/Back and Activity recreation
on API 35. Its synthetic HTTP content and private temporary journal do not use
production credentials or establish physical/OEM keyboard coverage.

`RealtimeApiTest` verifies the installed token POST and actual SDK token bridge;
`AblyRealtimeConnectionTest` starts/closes the real Android SDK with held or
failed authentication. `RealtimeCatchUpTest` keeps canonical history held while
list changes and status failures remain independent. `NativeRealtimeTest` covers
the real native route's connecting first display, cross-client confirmed changes,
disconnect/reconnect and foreground restoration while retaining a typed draft.
The same foreground SDK connection carries the visible conversation's confirmed active-run
output channel. `RunOutputModelTest` covers Web-compatible transient output, ownership,
retention and persisted-ID replacement; real-SDK protocol tests cover decoding and run-channel
cleanup. The native realtime journey displays streamed text, preserves it through a gap and
reconnect, then replaces it with canonical saved text while retaining the draft. Chunks never
enter the durable cache. Chunk zero starts a block, later payloads append in arrival order,
and a missing first chunk waits for canonical history. Cached active runs can subscribe before
HTTP catch-up; reconnects and thread navigation preserve received blocks. Native output adds no
message, character or callback-queue limits that would discard data Web accepts. Persistence
reconciles matching IDs, and the workspace owner releases remaining transient text on close.
Its external SDK observations are controlled; this is not provider-live evidence.

Meaningful drafts and pending text operations live in `noBackupFilesDir/chat-input`,
scoped by origin/user/workspace, separately from the rebuildable confirmed cache.
Existing journal files require their stored format header. Unversioned or malformed
files remain untouched and show a storage error with a retry action; a missing file initializes
normally, and a valid empty journal stays usable.
Native selection/composition stay with the text control. Accepted local writes
outlive presentation controllers; dispatch requires a read-back durable copy of
the same frozen operation and current authorization. Missing input observations
do not prove rollback. Recovery reuses the original IDs and payload only after
an explicit action. Draft durability is device-local, without cross-client sync.
Unacknowledged new-chat creation results remain with their original draft target
until native navigation opens the authoritative thread. Parallel targets cannot
replace each other's handoff; late text before that handoff follows its created
thread instead of becoming an unrelated new-chat draft.

### Saved-state policy

`state/SavedUiState.kt` owns first-party Bundle metadata and both journal-backed
editor adapters. Text stays in its existing private journal; native selection is
restored only after that body is available. Raw saveable APIs and provider writes
outside this boundary fail `scripts/check-saved-state.py`, including handle
creation factories, aliases and qualified references. This source-policy check
does not infer arbitrary Kotlin data flow or inspect dependencies' internal providers.

`MainActivity` checks the entire app-owned saved Bundle after its superclass
collects Jetpack providers on every Debug save. The shared budget is **less than
50,000 bytes**, following Android's below-50-KB guidance, with room below the
process-shared Binder buffer. This is not a platform success guarantee or a
document-size limit. Release performs no additional serialization; excess Debug
state reports byte counts and never discards data.

Presentation restoration retains the **32 most recently opened conversations'**
native scroll states and the **64 most recently collapsed Projects**. Reopening
a retained target refreshes its recency. Older scroll/expansion choices return
to their native defaults; draft text, pending sends and confirmed history are
independent and are not evicted by this policy.

`SavedStateBudgetTest` covers provider collection/restoration on host APIs 24 and 35. `SavedUiStateTest` covers delayed journal hydration, recent/evicted scroll
restoration and thousands of Project presentation choices. Existing long-text
Activity recreation cases run the same Debug budget check; there is no separate
64-KiB assertion per feature.

### Other focused commands

From `android/`:

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

For commit-addressed, PR-specific screenshot acceptance, see
[feature screenshot recipes](screenshots/README.md). Temporary recipes are selected manually
and removed in the same PR before merge; shared capture support stays available.

The `androidTest` suite launches the real Activity and uses UI Automator to
exercise chat-list navigation and Back, appearance restoration with a new Activity
owner, native system bars and live platform night-mode changes, plus palette/language
changes through native app-language recreation. The existing JVM/Robolectric tests retain the
broader state/error/localization matrix.

On a Linux x64 host with readable/writable `/dev/kvm`, run from `android/`:

```bash
bash scripts/test-release.sh \
  -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect
```

AGP manages one Pixel 2, API 35, 64-bit AOSP device: emulator/image provisioning,
snapshots, installation, test execution and teardown. Accept the SDK licenses
using the setup procedure above before provisioning. Initial downloads take
additional time and disk space. Software GPU rendering supports headless CI;
CPU virtualization still requires KVM on Linux. This configuration targets the
CI phone cohort, not a measured performance or physical-device matrix.

Compile/package the suite without starting a device:

```bash
./gradlew :app:assembleReleaseAndroidTest --no-daemon
```

The existing native suite targets the optimized, non-debuggable Release APK.
It retains its test Application and external-service fixtures; it does not
establish a real Clerk or Ably provider session. JVM/Robolectric tests continue
to use Debug resources; they execute JVM classes rather than APK DEX.

The helper creates a fresh PKCS12 test key for each invocation and removes it on
exit. It owns the signing location independently of the runner's Android home.
Normal Release builds remain unsigned until the production signing step. The
helper first checks the native ABI rules, retains an unsigned APK and compressed
mapping with the production build script, then assembles the signed app/driver.
It verifies that the signed app's DEX, resources and manifest and its mapping
match the unsigned production build, both before and after running the suite.
Its artifacts live under `build/reports/release/` and `app/build/` and are retained
with the instrumentation artifact. The test APK is rewritten with AGP's app
mapping. The checked-in `app/src/main/keepRules/native-instrumentation.keep` is
generated by AGP's R8 TraceReferences from the test classes and test-only runtime
dependencies to the unoptimized app and its libraries. It preserves concrete
referenced members, including shared Kotlin/coroutines/OkHttp APIs, rather than
all public members of application types or entire SDK packages.
Tracing includes incoming virtual overrides and SAM callbacks as well as outgoing
calls. Its library path contains only the SDK and compile-only annotations;
compile API stubs would shadow the runtime targets and hide their virtual methods.
This follows [Keeper's runtime-classpath approach](https://github.com/usefulness/keeper).
`native-fixtures.keep` additionally preserves the coroutine probe name used by
R8's generated test calls. Both apply unchanged
to published Release builds; unrelated code remains eligible for optimization.

After changing native tests or dependencies, regenerate and review the ABI:

```bash
./gradlew :app:generateNativeTestKeepRules --no-daemon
cp app/build/generated/native-test.keep app/src/main/keepRules/native-instrumentation.keep
```

Tracing reports missing legacy/hidden platform adapters in test libraries as
warnings because the public SDK stubs cannot resolve them. It does not replace
device execution. The helper rejects stale rules when changing fixture extension
points or dependencies.
Screenshot recipes use this same production ABI. The baseline check excludes
their temporary driver overlay; recipes must use the existing exported fixture
interfaces and UI controls rather than relying on unexported app internals.
HTTP fixtures use TLS with a test-process trust provider instead of changing the
Release HTTPS policy. The provider is removed when its last fixture closes.

Use an isolated test emulator. The fixture snapshots/restores app preferences,
platform night mode, app locale, fixture API preferences and chat-list cache,
scopes its UI Automation shell permissions, and closes its Activity owners on
success and failure. Fixtures use a local HTTPS server or external-service adapters
without contacting a live backend. A new Activity owner is not a process-death
restoration test.

Managed-device HTML reports are under `app/build/reports/androidTests/`, with
JUnit results/logcat under `app/build/outputs/androidTest-results/`. Official
Test Storage retrieves failure screenshots and accessibility hierarchies under
`app/build/outputs/managed_device_android_test_additional_output/` before device
teardown. These images are diagnostics, not screenshot-golden assertions.
The wrapper streams emulator logcat to `build/reports/instrumentation/logcat/`
while Gradle owns the device. It gives the native command a 15-minute deadline
within a 20-minute test step and 25-minute job budget so timeout diagnostics can finish before job
termination. Nonzero exits, timeout and cancellation remain failures. CI also
requires all nine distinct native cases with no failures, errors or skips.
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
runs. Like Turbo and Crates, release-please PRs, queued release PRs and release
commits skip Android validation after release-context detection succeeds. The
production release job independently builds, signs and verifies its exact-target
APK; it does not consume validation artifacts. Ordinary change selection includes
Android sources/docs, CI inputs, Web semantic colors,
and shared font/color-evaluator assets. One native job runs all local tests,
lints, assembles, and uploads the debug APK plus the optimized unsigned Release
APK and compressed R8 map for seven days. CI uses the production unsigned-build
script, including metadata/alignment checks and mapping retention.
A separate Linux/KVM job runs the existing instrumented suite against Release on the managed API 35
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
`versionName`. The APK's internal `versionCode` is the number of commits reachable
from its source (`git rev-list --count HEAD`), generated by
`scripts/version-code.sh`. Tasks that consume version metadata, including manifest
and BuildConfig generation, require complete Git history (`git fetch --unshallow`
for a shallow clone). Configuration and dependency-only queries do not calculate
the version code. Release sources advance along `main` without
rewriting history so subsequent APK codes increase; rebuilding the same commit
keeps the same code. Upgrade policy compares numeric components of `version`,
independently of this Android installation identifier.

Release enables AGP's `optimization` pipeline: R8 removes unused code, optimizes
and shortens identifiers, and shrinks resources using the default Android rules
and dependency-provided consumer rules. Debug stays unoptimized. Run
`./gradlew :app:assembleRelease` to build the optimized APK. The matching
`app/build/outputs/mapping/release/mapping.txt` is required to retrace obfuscated
stack traces; the release job publishes a versioned `.txt.gz` copy alongside the
APK. Decompress that file with `gzip -d` before retracing a production stack trace.
Add narrowly scoped rules under `app/src/main/keepRules/*.keep` only when an
actual reflection/JNI or separately loaded instrumentation boundary requires them.

When native Release tests fail or are cancelled, CI retains their original diagnostics and runs
the matching AGP Retrace against both app and test-driver logs. It validates the
actual signed tested APK's R8 marker against the compressed mapping's compiler version and map ID,
and verifies the mapping hash before restoring frames. Restored logs and byte
identity receipts live under `build/reports/retraced/`. For a downloaded crash:

```bash
python3 scripts/retrace-release.py app.apk version-mapping.txt.gz crash.txt retraced
```

Use the APK and mapping from the same build. The command uses the R8 bundled
with this checkout's AGP, rejects mismatches and preserves the original input.

When the normal release PR is merged, `release-please.yml` creates the
`android-vX.Y.Z` release. Its single `publish-android` job checks out the exact
release target, builds an unsigned APK, signs and verifies it, and archives the
versioned gzip mapping in the GitHub Release before publishing the update to R2.
The archive step verifies GitHub's SHA-256 asset digest, accepts an identical
existing map, and reads back uncertain uploads without repeating them. Missing
or conflicting mappings block update discovery. The job then uploads
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

The direct-APK updater reads the public `GET /api/android/updates` contract,
independently of authentication and the retained business-API 426 state. The
API combines the source-owned compatibility floor with the published Android
release; only its exact GET recovery path bypasses installed-client exclusion.
The release and `minimumSupportedVersion` use stable `x.y.z` versions, comparing
each numeric component. APK `versionCode` is internal build/installation metadata
and is absent from both the public response and the R2 manifest.
Optional announcements follow available versions and the user's per-release
deferral. Manual and required-update recovery remain available. Automatic checks
run on foreground without holding the first native frame, at most once per day
after success.

Startup revalidates a saved package before offering download or installation
actions. The last successful discovery and its timestamp are restored together.
Each transfer and installer action stays bound to its presented package; a click
during preparation is not queued against a later version or recovery result.

Users initiate credential-free APK downloads inside Okou. The app streams into
private files, validates byte count, SHA-256, package/version and signer, then
offers installation through a narrowly scoped FileProvider and Android's
installer. Android 8+ may require installation-source authorization. Activity
recreation retains work; OS process termination can interrupt it. A later launch
discards partial files and offers explicit retry, or revalidates a completed APK.
No resident service, DownloadManager, silent installation or range resumption is
implied. Installation handoff does not establish package replacement.

After validating the release tag against the checked-out source,
`publish-android-update.py` publishes the verified APK bytes and a conditional,
monotonic manifest through the existing production static R2 configuration.
R2 publication precedes the GitHub APK copy, allowing a rerun to repair discovery
when that copy already exists. The manifest is at
`https://static.okou.io/android-updates/manifest.json`. APK writes are immutable;
same-version conflicts fail, and an older publication cannot replace a newer
manifest. Until the first successful publication, discovery reports unavailable.
Previously installed clients without this updater still need an initial manual
APK update. This feature does not raise the API floor or establish real
production-key/device upgrade acceptance.

Run the fixture suite with JDK 21 and the pinned SDK installed:

```bash
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
python3 android/scripts/release-signing.test.py
```

The normal Android checks include this suite. It uses an ephemeral test-only
PKCS12 and real signing tools to verify different versions retain one signer,
invalid configuration/signature rejection, cleanup and refusal to overwrite.
Its manifest-only APK fixtures do not prove installation or production-key access.

For protected acceptance, use the configured durable key to sign two builds
of the real application from successive `main` commits with increasing
`versionCode`, without publishing test versions. Install the first, open Settings
and save an appearance preference:

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

## Foreground Chat Updates

The authorized workspace owns an Ably device connection while the Activity is
STARTED, including navigation to Settings. STOP and workspace retirement cancel
token renewal and close subscriptions; foreground restoration connects again and
catches up through the existing canonical HTTP list, indicators and selected
history owners. Those reads remain independent of token/attachment readiness and
of one another. Notifications contain no authoritative rows. List changes wake
chat/project navigation; message changes wake the matching selected history;
detail changes refresh only that conversation's detail. Indicator/read-cursor
changes refresh only indicators. Pending SDK
notifications merge resource flags and thread IDs until the observer drains them,
so a conflated wake-up cannot discard a different topic. Initial attachment,
reconnect and continuity loss still request full canonical catch-up.
Each confirmed resource coalesces its own notifications and retains a trailing
read, so held history cannot delay subsequent list or indicator updates. Run-state
indicator refreshes start at least one second apart; read-cursor and local
mark-read changes wake delayed demand immediately. Manual refresh is unthrottled.
Queued history and detail invalidations retain the selected conversation's
generation. Their requests and failure states are independent: a held or failed
detail read cannot delay history or erase its confirmation. Manual refresh and
full resynchronization request both resources.
Drafts and pending sends retain their existing durable journal ownership.

Foreground message/recovery signals also request independent confirmed-history
warming. Detail-only notifications do not request warming. Like Web, the
cohort combines the 100 most recent non-hidden conversations
with indicator thread IDs. The selected conversation keeps its own reader. A
one-second serialized trailing worker reads lightweight Room cursors and uses the
canonical batch catch-up endpoint; missing cursors rebuild through concurrent
snapshot reads, matching Web. A recoverable failure in one snapshot does not
discard successful siblings; authorization/update failures cancel the batch.
Warming never marks content read or drives list loading. Conditional transactions
reject an obsolete baseline or a now-selected target, preserving newer foreground
history. STOP/retirement cancels the worker, and failures remain owned separately
from visible reads. Every conversation remains fully readable on demand regardless
of warming eligibility; the cohort is not a row, content or history-size limit.

`HistoryWarmingTest` exercises actual batch HTTPS/tuple codecs, cursor reuse,
large Unicode rows and disk reopen, concurrent snapshot/missing-thread recovery,
held-background independence, stale foreground/background publication and
stop/restart/retirement. Parallel recovery can increase concurrent network and
memory use; its resource owner still cancels every child on STOP or retirement.

The native connection notice reports connecting or unavailable with explicit
retry; transport attachment is not a claim of confirmed-data freshness. Ordinary
manual refresh/navigation remains available. The generated empty-object
`POST /api/realtime/token` consumer uses the existing authenticated API transport
and required-update handling. SDK callbacks obtain fresh single-use signed token
requests for renewal; no API credentials are sent to Ably.
A failed canonical token request closes that observation and offers explicit
retry; a later transport callback cannot erase its authentication/update failure.

The pinned `io.ably.pubsub:device:2.0.0` supports the API24/JDK17 baseline. Its
unused Firebase Messaging dependency is excluded: this slice registers no push
receiver/provider and does not activate push. Manifest auditing still applies to
the packaged dependency graph. Build/controlled-SDK emulator evidence is separate
from actual provider delivery. Transient active-run output and run controls are
subsequent work, and continuous background delivery is not promised.

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
required null/non-null selectors, compound tags or forbidden/required key pairs.
Nested object unions are flattened only when no extra schema constraint is lost;
joint selectors require every variant pair to be provably disjoint.
Union selection rejects unknown or ambiguous variants and preserves the original
wire object without inserting a discriminator wrapper. Nullable/optional fields,
combined string-enum vocabularies, explicit nulls and empty tuples retain their
wire representation. Fixed-length tuples retain typed positions and serialize as
exact-length JSON arrays, including the installed `historyCatchUp` request.
Unsupported mixed/ambiguous unions, variable-length tuples and
unrepresented values still fail generation. Canonical safe-integer literals have
an exact singleton wire representation, including history's literal zero and
structured messages' version one. Optional nullable outbound request fields preserve omitted,
explicit-null and concrete values through typed `CanonicalOptional` values.
Request ownership comes from the selected route, so archive input decoding keeps
its existing normalized representation.
Optional never fields are omitted and rejected
when present. Only deliberately unconstrained canonical JSON leaves become
`JsonElement`; optional leaves preserve absence separately from explicit JSON null.
This is a typed reader boundary,
not a second implementation of Zod's complete validation/transform runtime.

Retrofit query support is limited to canonical scalar fields; omitted optional
values stay absent from the URL. Server-defaulted scalars use explicit arguments.
Required string path parameters retain Retrofit's normal segment escaping.
Supported scalar object-union queries generate typed alternatives and an extension
method that validates the canonical branch constraints before invoking the wire
method. Unsupported or ambiguous compositions still fail generation. A route must
have exactly one supported body-bearing 2xx success schema, bound to its exact DTO;
Retrofit retains the actual HTTP status separately from the decoded body.

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
fields, path escaping and query validation. The production `historySnapshot`,
`historyRows`, `threadDetail` and `markRead` bindings are installed consumers used
by the native reader. Their canonical raw event model and event schema version
are generated alongside the existing list bindings.

The test-only `commandfixtures` namespace and `ChatCommandBindingsTest` prove
canonical thread creation and input submission, including their 201 receipts,
stable client identities, full command variants, structured multilingual content,
compound source tags and optional/null model choices. A 201 receipt means accepted
input, not a running or completed task. These fixtures do not register installed
write consumers or provide a native composer; those belong to their actual feature.

`HistoryProjectionContractTest` also consumes generated semantic histories.
Their expected visibility, ordering, queue flags and run state are computed by
the canonical functions Web actually uses, including its shared run-state helper.
Every history prefix is checked by the native projector; `check:kotlin` detects
changes to those expected outcomes, and adding an event type requires a scenario.
Native opaque usage references and preserved cancellation details remain explicit
presentation differences. These cases establish executable conformance coverage,
not an exhaustive proof over every possible history.

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
cover workspace/member preferences, native chat-list/history reads, visible read
confirmation, text creation/sending and original-input status observations.
Body-bearing success codes are checked against the consumed canonical contract
(201 for create/send, 200 for reads). The authentication
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

Both clients accept a finite `callTimeout`, with a 30-second default for ordinary
control/mutation calls and explicitly bounded byte transfers. Canonical API reads
(including batch history catch-up) and streamed signed archives have no overall
call deadline, so a progressing read can complete as it does on Web. These read
clients share the owner's dispatcher/pool and retain connect/read-idle timeouts
and coroutine cancellation. Every error body retains both the 64 KiB limit and
the ordinary time budget. A deadline while consuming an incomplete error body
preserves the already received HTTP status, including the blocking 426 state;
the absent envelope metadata remains unknown.

`CanonicalReadTransportTest` exercises progressing history/archive responses past
the control budget, stalled successful bodies, bounded progressing error bodies,
and cancellation during streaming.

HTTP 426 retains a read-only `updateRequired` state and blocks further calls
from that client; a malformed envelope keeps the minimum version unknown.
The authenticated root observes this state and presents its native blocking
update destination. No self-clear/retry is provided for an installed
version that needs an update. The backend Android floor starts unset; see
[Android compatibility](../docs/deployment-compatibility.md#android-contract-gate).

R2 is the release-information authority for the compatibility gate. CI reads
`release.version` through the same public `/api/android/updates` endpoint used
by the installed updater; the API validates the published R2 manifest before
returning it. A GitHub APK copy, a local build or an Actions artifact alone does
not establish that availability. The publisher owns APK signing, the packaged
version and installability. The [release pipeline](#github-releases) owns packaging,
R2 publication and the GitHub copy; a floor raise remains a reviewed source-policy
change after the compatible build is available through discovery. Ordinary
business API requests compare the source floor without querying release storage.

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

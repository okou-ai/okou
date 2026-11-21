# Okou for Android

Native Kotlin/Jetpack Compose client shell inside the Okou monorepo. Open this
directory in Android Studio, or use the checked-in Gradle Wrapper. No pnpm,
database, API service, account credentials, or local Web server is needed.

Signed-out launches open the native Clerk login page. A restored active session
with a selected workspace opens the native conversation list while access is
checked. Once workspace access is confirmed, cached conversations and Projects
can appear while the app refreshes the list and loads member preferences.
The workspace chat list uses single-line rows, indented
Project chats, and separators within groups that have pins and ordinary chats.
Collapsed Projects summarize unread or running chats. Selecting a chat opens
its conversation, and Back restores the same list position, filter
and expanded Projects. Settings opens from the current app bar and returns to
the same list, chat or new-chat draft. Windows at least 840dp wide and 480dp
tall show the same list alongside the current chat or new-chat entry. Resizing
keeps the current destination and the list state. Settings groups the member's
display mode, palette and language in the active workspace. Android and Web
use the same member preference API. Follow system uses each device's system
appearance and is the default when the workspace has no saved mode. Settings
shows saving, refresh and retry states. Workspace settings offer the eight Web
palettes and languages in `supportedLocales`, including distinct
Simplified and Traditional Chinese.

Android reads a private cache of the last confirmed display mode and palette
while the identified workspace loads. The cache is scoped to the API origin,
account and workspace and is read off the main thread. The existing preference
response takes precedence and refreshes the cache. Only the server-confirmed
workspace can open workspace content.

My Okou in Settings reads and edits the signed-in user's personal Instructions
for the selected workspace through the canonical Instructions API. Loading
Instructions leaves chat and Appearance available.
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
transactions with their synchronization position. Changed chat lists await the
write transaction before publication and read back from disk if it kept a newer
checkpoint. Changed Projects await persistence and readback. Unchanged catch-up
reuses the confirmed chat rows without another disk transaction when the cache is
current. Changed Agent/settings references still persist independently. A storage
failure leaves the network result usable with a visible cache warning, and a later
refresh retries unsaved data.
Data is scoped to API origin/user/workspace and the current authorization snapshot;
an older synchronization cannot replace a newer persisted tail. Last-confirmed
Agent/Project references keep the scoped list usable after a process restart while
their network reads are unavailable. Cache display precedes network catch-up;
chat tails over 100 events check the server's snapshot cursor in the background
after publishing the incremental result. An advancing cursor triggers a download
and replay. The workspace list worker applies that snapshot and its tail if a newer
read has not superseded the operation. A pending local edit defers a snapshot
that would cover events Android has yet to read. Server errors during the
optional rebase leave the synchronized result usable.
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
integration. The private chat cache also stores the last confirmed unread map
for each workspace and account, with its authorization scope. After authorized
startup, the unread dots, filter, and collapsed Project counts can use that
snapshot for up to two minutes from confirmation. A successful indicators read
replaces it. Running indicators and run controls still use live responses.
Signed archive URLs are confined to a snapshot fetch, and credentials belong to
the authentication owner. Personal Instructions drafts use the separate intent
store described above.

Pin, pin reorder, rename, mute, archive and delete project their visible result
from memory before the request completes. Definitive refusals remove their
local edits immediately, including any unsent reorder steps. Canonical event
IDs settle submitted changes, including events observed before a snapshot
rebase. Transient list reads retry in the background while the list is visible
in the foreground. If an outcome stays unconfirmed, Refresh chats reads back
the list and clears the unresolved projection once that read succeeds.

Sending a first message adds a provisional inbox row that opens its pending
conversation. The list adopts the confirmed row by thread ID. Sending in an
existing chat updates its visible recency in memory while preserving pin and
Project ordering. The list sort event confirms the move independently of the
message receipt. Foreground reconciliation uses canonical order for completed
attempts whose sort event is unavailable.

Mark read, Mark unread, and Mark all as read immediately update chat list
unread markers, filters, and collapsed Project counts. A pending read hides
unread activity through its observed server watermark. A pending read on a
locally marked unread chat without a server watermark displays as read until
its own readback. The existing read
endpoint still chooses the receipt watermark. Definitive write failures remove
the local intent. A successful indicators read started after the write settles
the current intent, including when the write response was lost. If both fail,
the list keeps the projection until the next successful refresh. Bulk feedback
counts receipts that cover the captured unread watermarks.

Conversation history shares this cache and its workspace authorization lease.
The workspace retains the confirmed checkpoint and projected timeline for the
active conversation and up to three recent inactive conversations. A revisit
can display that timeline before Room or network work. Catch-up uses its
canonical cursor and cached display alone never marks the conversation read.
Room stores thread authorization, event format, paired cursor and confirmation
time in `history_scopes`, and lossless raw event JSON, identity and sequence in
`history_events`. Version 2 caches upgrade in place. Rebuildable v1 databases
are recreated. Snapshot replacement and tail appends commit atomically,
and disk readback precedes publication when storage succeeds. A failed write keeps
the confirmed network result available and retries it on refresh. Thread-local
403/404 clears that history without retiring the workspace.

The reader streams gzip NDJSON snapshots and follows canonical paired-cursor raw
rows, including valid zero cold start, missing snapshot fallback, gap-tolerant
sequences, an extra cold confirmation page and expired-cursor rebuild. Malformed
or truncated data never publishes a partial checkpoint. Projection preserves
revocation/rejection and queued/running/stopped/failure facts. CommonMark
renders selectable native text and code with horizontally scrolling tables.
References and unsupported structured parts
remain explicit with their original JSON. HTML remains literal text, and reading
does not automatically download attachments or open links. Interactive viewers
remain later work.

An authorized, resumed conversation marks read after the latest confirmed content
is visible at the reading edge. This calls the existing server mark-read POST
and refreshes independent indicators; cached display, hidden navigation and held
requests do not mark read. Local caches never establish server freshness.
The workspace retains synchronization and confirmed content. Each visible visit
owns a separate read session, including request cancellation, read errors and
within-visit deduplication. Hiding the reader, backgrounding or changing selection
ends that session; reopening creates a fresh one even when event rows are unchanged.
Display acknowledgments identify a captured network confirmation, not whatever
state is newest when an effect runs. The existing server API selects its current
run-finish watermark; it does not accept a displayed event cursor.
An older reading position is stored as a message identifier and viewport offset
for the local account, workspace and conversation. Returning to the latest
content clears that anchor.

## Prerequisites and Setup

Use JDK 21, Python 3.9+, curl and unzip on Linux/macOS. The build targets JVM 17.
Versions are pinned in `gradle/libs.versions.toml` and
`gradle/wrapper/gradle-wrapper.properties`: Gradle 9.9.2, Kotlin/Compose compiler
2.4.21, AGP 9.5.2 with built-in Kotlin, Compose BOM 2026.11.01 and Clerk 1.5.0.
Compile SDK is 37.2 and build tools are 37.0.0. The app targets API 37 and supports API 24
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
`platforms;android-37.2`, `build-tools;37.0.0`, and platform-tools. It installs no
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
assembly. Android Lint treats warnings as errors and reports newer dependency
and Gradle toolchain versions as informational hints. Verification uses two Gradle
workers, a 1536 MB build heap and in-process Kotlin compilation by default for
small sandboxes.

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

Run controls use the same authenticated event endpoint and generated request union.
Stop freezes the displayed live-run IDs; skipping targets one canonical queued
automation. HTTP acceptance is not completion. The workspace control owner checks
canonical control/target evidence and never retargets an uncertain request.
All current controllers of the same origin/user/workspace attach to one shared
command owner, including target deduplication, phases and journal mutations.
Retiring one controller cancels only its network requests; peers retain unknown
commands and can explicitly check/retry their original identities.
Frozen pending controls live separately in private `noBackupFilesDir/chat-controls`
format-1 journals scoped by API origin, user and workspace. Disk commitment precedes
POST, and restored intent only reads back until an explicit same-request retry.
This adds no confirmed-cache or composer-journal migration and stores no stream text.
Cancellation metadata reuses the conversation history owner's independent detail
request and typed phase. Control outcome reads never take over that request's
loading/completion state or create a second metadata producer.
Both paths fail independently of ordinary history.

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

### Debug Device Integration Tests

The `androidTest` suite runs against Debug. It covers native navigation, the
keyboard and system Back, Activity recreation, appearance, locale, and other
interactions that need a device. The JVM and Robolectric tests cover the broader
state and error matrix. The device suite and the
[PR screenshot recipes](screenshots/README.md) use Debug fixtures, including a
test-process trust provider for the local HTTPS fixtures.

On a Linux x64 host with read/write access to `/dev/kvm`, run from `android/`:

```bash
./gradlew :app:pixel2Api35DebugAndroidTest --no-daemon \
  -Pandroid.testoptions.manageddevices.emulator.gpu=swiftshader_indirect
```

Gradle configures the Pixel 2 API 35 device and owns its lifecycle. Use
`:app:assembleDebugAndroidTest` to compile without starting the device. CI
requires all eleven cases and retains JUnit, Test Storage and logcat diagnostics
in the `android-instrumentation-api35-<revision>` artifact.

### Release Smoke Tests

The smoke test installs the R8-optimized APK signed with a disposable key. The
shared publishing builder supplies the unsigned APK and R8 mapping. The harness
verifies the signed payload and mapping, boots an isolated API 35 emulator and
uses the launcher and platform UI Automator from the host to check initial startup
and relaunch after stopping the process. CI uses the same public Sentry DSN as
publishing. The offline emulator exercises the public unauthenticated surface
with the production Application.

To run the smoke locally on Linux x64, set up the SDK, install the emulator
packages and run the helper from `android/`:

```bash
"$ANDROID_HOME/cmdline-tools/13114758/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
  emulator 'system-images;android-35;default;x86_64'
bash scripts/test-release.sh
```

The emulator requires read/write access to `/dev/kvm` and port 5580. CI retains
the unsigned APK and mapping for seven days. The
`android-release-smoke-api35-<revision>` artifact contains the signed APK,
payload verification receipt, UI hierarchy and emulator diagnostics.

## Components and Authority

- `app`: native Activity, Home/Settings routes, retained presentation owners,
  confirmed chat-list storage, member preferences and the shared native theme.
  Plain business logic can stay
  free of Android UI types without needing a separate Gradle module.
- `scripts`: SDK setup, verification, shared-token synchronization and CI selection.

[CCState principles on Android](../docs/android/android-ccstate.md) covers
single sources of truth, derivation, semantic actions and async ownership using
native Kotlin/Jetpack APIs. TS runtime/API parity is not required. The app uses
ordinary ViewModel actions and collectAsStateWithLifecycle rather than a custom
Store, dependency graph, command visitor or cancellation signal.
OkouAppTest and MainActivityTest
exercise real routes, chat filters, back/configuration retention,
appearance and adaptive navigation. LocalizedResourcesTest verifies native
locale/script matching on APIs 24 and 35. These are local tests; they do not
establish physical-device IME/rendering or startup budgets.
MemberPreferencesModelTest covers shared display mode, confirmed and pending
selections, failed saves, retry, readback and retired work. PaletteColorsTest resolves all sixteen
mode/palette combinations from generated resources; LegacyLanguageSettingsTest
exercises pre-Android13 app-language changes through the real Activity.
Add modules and shared helpers for actual application boundaries.
SessionModelTest also holds the workspace response to exercise cached
appearance, confirmation and account and workspace isolation.
Shared font bytes/licenses are sourced from `ios/Okou/Resources/Fonts` during
the build; the app does not keep a second font copy in source. Its launcher
vector retains the geometry from `ios/Assets/AppIcon.svg`. App controls use
locally packaged [Material Symbols Outlined](../docs/android/android-development.md#interface-icons)
and ship their license under `assets/licenses`.

## CI and Distribution

`.github/workflows/android.yml` checks PRs, merge groups, main pushes and manual
runs. Like Turbo and Crates, release-please PRs, queued release PRs and release
commits skip Android validation after release-context detection succeeds. The
production release job independently builds, signs and verifies its exact-target
APK; it does not consume validation artifacts. Ordinary change selection includes
Android sources/docs, CI inputs, Web semantic colors, and shared font/color-evaluator
assets. One job runs the JVM tests and lint, then uploads the Debug APK for seven
days. Two separate Linux/KVM jobs run the Debug device integration tests and
the Release smoke tests. The Release job uploads the unsigned APK and compressed
R8 map for seven days.
The final `ci-gate-android` check always reports an aggregate result. For
non-release changes it requires successful change detection and all three jobs
to pass when Android checks are selected. Cancellation, failure or an unexpected
skip fails the gate. Emulator functional evidence does not establish OEM
input-method behavior or physical-device startup budgets.

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
the version code. CI checks dependency discovery on a shallow checkout when Gradle,
version inputs, or the selecting workflow and scripts change, and on manual runs.
Release sources advance along `main` without
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
Add narrowly scoped rules under `app/src/main/keepRules/*.keep` only when a
runtime boundary such as reflection or JNI requires them.

The Release smoke artifact keeps separate `cold-start/` and `relaunch/` evidence.
Each directory records the launcher response, latest UI probe and last readable
hierarchy from that launch. On failure CI also attempts to capture foreground
activity state and a screenshot before the emulator stops.

CI retains the original Release smoke diagnostics before starting its separate
retrace job. On failure it extracts app Java crash stacks from logcat and runs the
matching R8 version from Google Maven with a 30-second command budget. It validates
the tested APK's R8 marker and the mapping's version, map ID and content hash.
When a crash stack is available, the separate restored-stack artifact includes
the extracted input, output and identity receipt. The Android gate uses the
original smoke result independently of retrace. A downloaded crash can be
retraced locally with the matching APK and map.

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

### Crash reporting

Provision the Android project `android` in the `okou` Sentry organization and
set the repository variable `SENTRY_DSN_ANDROID` to its public DSN. The production
`SENTRY_AUTH_TOKEN` must have mapping upload access to that project. The signed
APK carries the Sentry mapping UUID. The release job uploads the verified R8 map
under that UUID before publishing the R2 update.

Local Release builds can use the same public DSN through `SENTRY_DSN_ANDROID`.
An unset DSN disables reporting on local builds. Debug and instrumentation test
hosts skip initialization. For one-time acceptance, use a local minified Release
build and upload its matching map with `scripts/upload-sentry-mapping.py`. Trigger
a controlled uncaught exception in the local build, then verify its restored
frames and the version and build in Sentry.

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
run on foreground without holding the first native frame. The first discovery
request in each app process can run even if the saved result is recent. Later
automatic checks in that process reuse successful discovery for 24 hours.

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
`versionCode`, without publishing test versions. Install the first, enter the
test workspace and save its display mode in Settings:

```bash
adb install first.apk
# Open the app and change its saved appearance in Settings.
adb install -r second.apk
adb shell am force-stop ai.okou.android
adb shell am start -n ai.okou.android/.MainActivity
```

Confirm the upgraded package version and the saved display mode after relaunch
in the same test workspace.
Inspect each APK with `apksigner verify --verbose --print-certs` and compare its
certificate with the previously distributed durable-signed APK when available.
The first durable release bootstraps that identity. Report fixture tests, real
production signing, device upgrade/data retention and Release publication as
separate evidence; a configured Secret name proves only its presence.

## Composer Draft Continuity

The native text composer reads and saves the same server draft as Web. Existing
conversations use their thread ID; My Okou and Project new-chat editors share the
default agent draft. Project selection only changes the new conversation context.
Draft GET does not delay the initial screen. Edits persist locally before PATCH,
with Web's 500ms debounce and immediate explicit clears. Requests are serialized
per target, and delayed hydration/save completions cannot replace newer local
input. Independent clients retain Web's existing unconditional last-writer
behavior; no server compare-and-swap or revision protocol is added.

Format 3 separates canonical editable drafts/dirty intent from frozen sends and
recovery records. Existing formats 1/2 migrate without changing request UUIDs.
Divergent legacy Project drafts remain available for explicit restoration into
an empty editor. Failed reads are never interpreted as empty. Rich documents,
attachments or unknown content pause automatic synchronization rather than
publishing a plain-text subset; the full server draft remains available on Web
and local text stays on this device. Retry rechecks the server before saving.
Foreground/manual opening refreshes a clean editor; automatic live draft events
remain later work. Sending and clearing a saved draft are separate operations;
uncertain submissions retain their original identities and never replay on open.

A sent text draft appears in the conversation immediately using its frozen input
ID. The first send opens the timeline with its allocated thread ID while creation
and list catch-up run. The editor keeps its recovery controls until the first send
and chat row are confirmed. Canonical history replaces the local bubble by input
ID, including rejection and revocation. The existing journal restores unresolved
input after recreation. Receipt-backed bubbles stay in workspace memory until
history arrives, with confirmed messages read from canonical history after process
restart.

Focused JVM/controlled HTTPS tests cover Web codec/204 responses, held hydration,
serialized edits/clears, offline store reopening and send/recovery preservation.
The API35 Release journey covers held draft loading, native editing, foreground
Web changes, recreation and clearing. These are controlled service fixtures,
not provider-live, production synchronization or distribution evidence.

## Foreground Chat Updates

Run-failure titles and descriptions use exhaustive switches over the generated
`KnownRunFailureReason` cases from the public contract. History keeps raw reason
tokens, including unknown future values; only presentation/recovery normalizes
them. After changing the public enum, run `generate:kotlin` and update both native
mappings. Generation drift and a missing `when` branch fail CI or compilation.

Assistant failure recovery follows the current canonical failure reason and the
thread's current model route. The card reads model catalog, personal account,
usage windows and reset credits independently of conversation history and draft
editing. Billing and settings failures expose their own guidance. Eligible
failures submit a new literal `continue` through the existing durable composer,
preserving the editable draft and selected-model/priority annotation.

Codex framework usage limits can reset the current personal account with a reset
credit before continuing. The composer saves the exact account, UUID idempotency
key, source failure/model and new input before either write. An uncertain reset
requires an explicit retry with that same key; opening a conversation, reconnecting
or restoring the process never replays a reset or send. Fresh canonical history,
control state and current account checks reject stale recovery; input retries
retain the original event identity and first observe an uncertain send.

Before any input is dispatched, an explicit new choice can add a reset to an
unsent continue or start a new reset after a definitive no-credit result and a
fresh positive balance. Unknown resets always reuse their original key. A
confirmed reset on a replaced account cannot continue automatically; a fresh
displayed account and another explicit action start a separate intent.
The live transaction restores the preceding recovery intent if a newly prepared
reset is cancelled before its network call, including controller retirement.
Failure or cancellation during that call retains the original account and key
as an unknown operation; restoration never assumes an old intent was unsent.

The composer journal reads existing formats 1/2 and upgrades to format 3 for
server-backed editable drafts without dropping pending/recovery requests or IDs.
Older apps reject newer formats visibly instead of overwriting them; downgrade
cannot restore that journal. No server schema or confirmed-history storage format
changes. `AssistantRecoveryModelTest` covers real HTTPS requests,
uncertain resets, stale account/source checks, draft retention and disk failures;
the Release native journey exercises the recovery action and preserved draft.

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
are generated alongside the existing list bindings. Selected raw-row envelopes
use an explicit JSON-object binding representation so transport and cache retain
unknown members unchanged. The native history reader decodes its consumed event
facts and payloads separately; opaque transport data is not a validated business
model. The canonical route schemas and protocol fixture proofs remain typed.

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

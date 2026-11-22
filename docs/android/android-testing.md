# Android Testing

Apply [shared testing](../testing.md). Commands/toolchain setup live in the
[Android README](../../android/README.md).

## Select The Production Boundary

- **Pure Kotlin state/domain owners:** invoke public actions, read the exposed
  immutable state and assert business outcomes, coherent snapshots and owner
  isolation. Use the actual implementation rather than mocking internal state.
- **Streams and suspend operations:** use the real state holder/repository path,
  with external services adapted at their transport/SDK boundary. Assert errors,
  recovery, cancellation and sharing only for behavior the application implements.
- **Compose and lifecycle:** render real native consumers, interact through
  semantics and verify content/enabled behavior. Exercise lifecycle stop/resume,
  owner replacement and teardown when those contracts change.
- **Persistence and services:** test actual decoding, storage and reconciliation
  through public operations when those features exist.

Tests protect the application contract. CCState's source/tests can inspire
scenarios, but TS object identity, exact callback counts, Promise scheduling,
private graph maps and JS garbage collection are not native acceptance criteria.
Remove superseded mechanism tests with that mechanism; retain equivalent
coverage for meaningful current behavior.

## Coroutine And Flow Tests

Use runTest, injected test dispatchers, controlled Deferred gates and explicit
causal completion instead of sleeps, timeout inflation or wall-clock assertions.
Test both current and obsolete work when latest-wins behavior is implemented.
Owned children/resources must be completed, cancelled/joined or released by the
fixture. Propagate CancellationException rather than reporting cancellation as
an ordinary request failure.

StateFlow is conflated. Normally assert its current value after the relevant
action/completion, without requiring every intermediate emission. If observation
order is itself the feature contract, use a controlled collector and explicit
synchronization. stateIn with Lazily/WhileSubscribed needs an active test collector
before upstream-derived values can change.

Native atomicity comes from the owning state transition. Test coupled business
fields together; combine does not promise a multi-flow transaction. Do not
duplicate primitive/framework test suites when a feature outcome is sufficient.

## Test Ownership

Keep state-holder and Compose tests in the owning feature/module's local test
source set. Pure Kotlin logic does not need a separate build module solely to
test it. The standard app Gradle test task requires SDK configuration but runs
without a device; pure Kotlin tests themselves can run in a separate JVM-only
entry without moving the production source into a new module. Add such an entry
only when its value justifies maintaining another build path.
Robolectric tests use API 35, the real Compose route/theme/resources and native
lifecycle collection. They establish host-side behavior, not physical-device
rendering, keyboard accuracy or runtime performance.

Keep formatter/lint evidence separate from behavior checks. Do not weaken a
valid assertion, hide diagnostics or manufacture new production abstractions
just to preserve tests for an obsolete API.

## Saved-State Boundaries

Exercise the actual Activity save path. Debug saves use the shared
`SavedStatePolicy` budget after Jetpack provider collection, so long-editor and
navigation/recreation tests exercise the same check. Do not add independent
per-feature byte thresholds or treat a supported Saver type as proof of size.

Use a real registered saved-state provider to establish that oversized nested
Jetpack payloads reach the checker, and verify a small provider restores normally.
Cover the minimum supported API as well as the standard API 35 host cohort when
changing callback ordering; a post-save callback available only on API 29 cannot
establish behavior on API 24-28. Keep host and device evidence distinct.

Exercise bounded presentation retention through observable scroll/expansion
state and restore recent entries. `StateRestorationTester` is appropriate for
the native UI adapter; it does not establish disk durability or OS process death.
Journal hydration must not consume restored selection against an empty body.
Keep diagnostics to sizes and approved structural metadata, never saved content.

## First Display With Pending API Requests

For new startup API consumers, verify the
[first-display contract](android-development.md#first-display-and-api-loading)
through the real native route and its owners. Hold the external transport/SDK
response incomplete while asserting that the initial native UI is visible with
the appropriate loading or identity-checking state. Release or fail that response
only after the UI assertion, then verify the resulting content or recovery state.
This proves the rendering dependency without arbitrary sleeps or timing thresholds.

Include slow/failing responses and owner replacement where relevant. A visible
first screen must not expose another account's cached content or enable protected
actions before their actual prerequisites are satisfied. Verify that late results
from retired owners cannot replace the current screen's state.

Add this coverage with the real API integration, rather than inventing a network
path for an offline scaffold. Keep first-display independence distinct from data
readiness and any separately justified physical-device latency measurement.

## Native Acceptance

Use a small instrumented suite for boundaries that need the Android framework,
such as native Activity ownership, window/IME insets, system Back and platform
configuration/system bars. Drive real application consumers through platform
interaction APIs; do not replace their owners or input services to claim native
coverage. Keep cheap state/error matrices on the JVM instead of replaying every
case on a device. A supported emulator cohort establishes functional behavior for
that configuration; OEM input methods and physical-device latency need their own
evidence.

Prefer build-managed device provisioning/execution/teardown over a second custom
emulator lifecycle. Give each case an isolated fixture identity and store. Before
changing device settings, save their original values, including whether an
override was present. On success and failure, release held fixture responses,
close Activity owners, restore settings and stores, and release adopted
permissions. Run cleanup steps independently so one failure cannot skip the rest.

### Drive And Verify User Actions

Establish the action's prerequisites, perform it once, then wait for its observable
outcome with a bounded framework API. Successful injection confirms acceptance
by the input system. Navigation, focus, layout and asynchronous work need their own
completion conditions. Use Compose's test clock for frame-dependent assertions
and an explicit condition for work outside that clock. Avoid sleeps, longer
timeouts or repeated input as substitutes for synchronization.

- **Tap, long press, and navigation.** Resolve a unique target within the intended
  screen or window and wait for it to be actionable. Then check the destination,
  open menu, selected item or other visible result. Re-query the target after a
  window change, recreation or scroll. Scroll within the owning container until
  the target is visible or the container reaches its boundary.
- **Keyboard, IME, and Back.** Check the editor's focus and IME visibility when
  relevant. After input or Back, verify the expected text, focus, insets, or
  dismissal of the intended keyboard, popup or destination.
- **Gestures and animations.** Use controlled Compose input for exact distances,
  thresholds and animation frames. On a device, calculate points from the current
  visible bounds, allow margin from the system gesture area, and verify outcomes
  such as a row returning, being archived or being restored by Undo. Android can
  resample touch events before app delivery. A device assertion about geometry
  needs a defined coordinate space and tolerance that accounts for sampling and
  rounding.
- **Configuration and recreation.** Wait for the active Activity or window to
  expose the expected configuration and for the UI to reflect it. For example,
  verify the new inset or pane arrangement and any retained selection. Obtain new
  bounds before operating on the resulting UI.
- **Asynchronous actions.** Control external responses at the fixture boundary.
  When the in-flight state matters, observe that the request entered the fixture,
  assert the interim UI, then release the response and verify the settled UI or
  authoritative readback.

### Diagnose And Verify Failures

Capture failure diagnostics before device/Activity cleanup and preserve the
original error if capture or restoration also fails. Use Test Storage for
additional files retrieved by the managed runner; an `adb pull` after emulator
teardown cannot recover them. Retain native reports/logcat and useful revision,
device/API and failure-image context without turning diagnostics into golden
tests. Selected device-test failures, cancellations and unexpected skips must
reach the existing CI gate. Setup, commands and output paths live in the
[Android README](../../android/README.md#debug-device-integration-tests).

Name the failed wait and record the expected and last observed values. For an
input failure, retain relevant bounds and injected coordinates, and capture the
screen before canceling the gesture or restoring the window. Use controlled
fixture data and omit credentials and user content from diagnostics.

Distinguish a failed app assertion, an invalid test assumption, an infrastructure
failure and a canceled run. Retain the first failure when a rerun passes. For a
device-test fix, use the same device configuration for reproduction and
verification, then verify the complete managed suite on a checkout that contains
the submitted revision. Record the checkout, Android configuration, attempt and
result alongside the failure evidence.

### Verification Boundaries

Release smoke tests install the verified publishing payload and drive its public
launcher and UI from outside the app process. Keep in-process fixtures and
app-owned state assertions in Debug device tests or the JVM layer.

For appearance or OS interaction, record source revision, device/emulator,
Android version/API, density/font scale, theme, locale and actual evidence.
Exercise relevant IME composition/selection, system back, focus, insets,
accessibility, process recreation, background/foreground and permission flows.
Actual OAuth, push, file/media and account switching need their integrated
environment and acceptance.

Separate local/JVM tests, host Compose tests, APK assembly, device installation,
native acceptance, CI completion and store publication. A sandbox without KVM
does not provide accelerated emulator acceptance. ViewModel retention does not
prove process-death restoration; persistent drafts need their actual data owner.

### Feature Screenshots

Prefer capturing feature screenshots with ADB on an authorized development
host when a suitable device or emulator and a build from the revision under
review are available. Reuse the verified Debug APK when possible. Check its
application ID before installation and use an ID that can coexist with the
installed release.

Drive the actual app to the state being reviewed and confirm the visible
outcome before capturing. Use isolated fixture data when a test account is
unavailable or the review concerns presentation and interaction. Record the
build revision and relevant display conditions with the images. Evidence from
fixtures covers the exercised UI, while backend integration and release
acceptance have their own checks.

Use the [managed screenshot workflow](../../android/screenshots/README.md)
when local access, a suitable configuration or a trustworthy build is
unavailable, or when the review requires reproducible CI evidence. Required
Android tests and CI gates still apply to either capture path.

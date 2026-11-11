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

SDK-independent state-holder tests live with the Kotlin foundation module.
Robolectric tests use API 35, the real Compose route/theme/resources and native
lifecycle collection. They establish host-side behavior, not physical-device
rendering, keyboard accuracy or runtime performance.

Keep formatter/lint evidence separate from behavior checks. Do not weaken a
valid assertion, hide diagnostics or manufacture new production abstractions
just to preserve tests for an obsolete API.

## Native Acceptance

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

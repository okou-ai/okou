# Android Testing

Apply [shared testing](../testing.md). Commands and toolchain setup live in
the [Android README](../../android/README.md).

## Select the Production Boundary

- **CCState core:** use public Store/signal/command/watch operations. Values,
  notification ordering, original failures, cancellation state and actual
  asynchronous outcomes are library caller contracts. Private node maps and
  internal collection sizes are not acceptance evidence.
- **Native observation:** subscribe through `observe`/`observeDeferred` with
  the real graph. Verify initial snapshots, replacement, original errors,
  stale completion rejection, and independent waiter/producer lifetimes.
- **Application UI:** render the actual Compose screen and owner, use input
  and action semantics, and assert content/enabled behavior. Host Robolectric
  is useful for these interactions, not device rendering/performance claims.
- **Data and service integration:** use actual decoding, replay and isolated
  storage through production operations; mock external providers at their
  HTTP/SDK boundary rather than replacing internal services.

## Synchronization and Isolation

Keep every Store on its creating thread. Use controlled Deferred gates and
the coroutine test scheduler to cause the race under test; do not add sleeps,
wall-clock assertions, timeout inflation or polling for guessed completion.
Test both current and obsolete continuations, not only the fastest happy path.
Close native subscriptions and stores and await/cancel owned producer jobs.

Core tests run without an Android SDK using the alternative settings entry.
Adapter JVM tests exercise the same observation functions consumed by Compose.
Robolectric Compose adapter tests live in `ccstate-compose` and exercise its
provider, target/action replacement, equality and disposal without app code.
App Robolectric tests use Android API 35 and the real theme/resources. Keep
formatting/lint separate from behavioral evidence. Changing a valid assertion
or suppressing a diagnostic is not a remedy for a production failure.

Graph changes should compare against the pinned TS contracts in
[Kotlin CCState](android-ccstate.md). Record intentional native scheduling,
precision, exception, or reachability differences. When testing retention,
keep the Store/root/watcher alive while obsolete branches release; a collected
whole graph does not establish dynamic-branch cleanup.

## Native Acceptance

For appearance or OS interaction, record source revision, device/emulator,
Android version/API, density/font scale, theme, locale, and actual evidence.
Exercise relevant IME composition/selection, system back, focus, insets,
accessibility, process recreation, background/foreground and system permission
flows. Actual OAuth, push, file/media and account switching require their own
integrated environment and acceptance.

Separate local/JVM tests, host Compose tests, APK assembly, device installation,
native acceptance, CI completion and store availability. A sandbox without
KVM does not provide accelerated emulator acceptance; never infer it from a
passing compile or a host-side screenshot.

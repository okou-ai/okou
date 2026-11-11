# Android Development

Apply the repository-wide instructions and read
[Android development](../docs/android/android-development.md),
[Kotlin CCState](../docs/android/android-ccstate.md), and
[Android testing](../docs/android/android-testing.md) for changed surfaces.
Setup and commands live in [README.md](README.md).

- Use Kotlin and Jetpack Compose for native application UI. Keep the graph core
  independent of Android/Compose, networking, storage, identity, and realtime SDKs.
- TypeScript CCState 6.1.0 at the pinned upstream revision is the behavior
  authority. Check source/tests; do not copy outdated README watch examples or
  substitute Swift semantics. Update the parity inventory with contract changes.
- Each Store is confined to its creating thread and an explicit owner. Keep
  signal definitions stable outside composable bodies and action invocation.
  Close subscriptions, scoped work, and Stores at their actual lifetime boundary.
- Derive read state in computed and compose graph writes in commands. Leave
  native editing/IME, focus, scrolling, and presentation state with native owners.
- Preserve core identity/scalar equality and adapter equality separately. Do not
  replace the graph with structurally conflated Flow caches.
- Use shared Web semantic colors, Geist, and official brand assets. Regenerate
  colors with `python3 android/scripts/sync-design-tokens.py`; do not hand-edit
  generated resources. Android owns native geometry, accessibility, and controls.
- Use String resources and preserve user content. Never report a local preview
  as a remote message, a successful build as device acceptance, or an installed
  app as store publication.
- Run the applicable commands in README. Kotlin formatting uses Spotless/ktfmt;
  Android lint owns platform diagnostics. Do not weaken checks or add broad
  suppressions/baselines. The core's single erased-cache cast is documented at
  its typed construction boundary; it is not permission for business-code casts.

# Android Development

Apply the repository-wide instructions and read
[Android development](../docs/android/android-development.md),
[CCState principles on Android](../docs/android/android-ccstate.md), and
[Android testing](../docs/android/android-testing.md) for changed surfaces.
Setup and commands live in [README.md](README.md).

- Use Kotlin and Jetpack Compose. Preserve CCState's single source of truth,
  derived values, semantic actions, render purity and explicit resource owners.
  TypeScript syntax, graph internals and runtime parity are not Android contracts.
- Prefer native StateFlow/Flow, Compose State, ordinary state holders and
  ViewModels. Do not add a dependency engine, AbortSignal analogue or generic
  command framework without a demonstrated application requirement.
- Keep mutable state private and expose immutable values/read-only observation.
  Derive related values from the same snapshot; update coupled fields together.
  StateFlow equality conflation is intentional, not a lossless event log.
- UI forwards semantic actions to its owner. Use ordinary methods and suspend
  functions; keep pure derivation free of IO. Do not start business work during
  recomposition or synchronize duplicate mutable state with UI effects.
- Every coroutine, stream and resource has an actual owner. Use structured
  concurrency and native Job cancellation; propagate CancellationException.
  Shared business work can outlive a UI collector. Choose sharing policies by
  lifetime, not a universal WhileSubscribed timeout.
- Collect Flow in Android UI with collectAsStateWithLifecycle. Keep editing/IME,
  focus, scrolling and presentation state with native controls/state holders.
  ViewModel retention, UI visibility and process restoration are different.
- Keep pure Kotlin domain/state holders independent of Android UI types.
  Introduce repositories/use cases when actual data and shared logic need them,
  not as empty layers around the scaffold.
- Use shared Web semantic colors, Geist and official brand assets. Regenerate
  colors with the source-owned script; Android owns geometry and accessibility.
  Use string resources and preserve user content verbatim.
- Keep components private except the reviewed MAIN/LAUNCHER entry. Preserve
  source-manifest auditing and Semgrep's rejection of unreviewed findings.
  New public routes and Intent handling need security review.
- Run applicable README checks. Use Spotless/ktfmt and Android lint without
  broad suppressions/baselines. Test current public state/actions and lifecycle
  outcomes; do not retain tests solely to mimic a replaced TS mechanism.
- Distinguish a local preview, passing tests/build, device acceptance, remote
  writes and store publication. Report only the stages actually verified.

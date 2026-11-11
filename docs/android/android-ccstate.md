# CCState Principles on Android

Use CCState as architectural discipline: one source of truth, derived values,
semantic actions, render purity and explicit asynchronous/resource ownership.
Implement those principles using Kotlin and Jetpack APIs. TypeScript runtime
details are not a compatibility target for the native client.

## State And Derivation

Keep mutable state private to its actual domain/screen owner. Expose immutable
models through read-only StateFlow, Flow or Compose State. Plain Kotlin state
holders can own feature logic; Android ViewModels retain screen state across
configuration changes. Neither is durable storage or an account-wide owner
merely because it exists.

Derive values determined by existing state. Use pure Kotlin functions or
properties for cheap local derivation, map/combine for data streams and Compose
derivedStateOf only when its recomposition savings justify its cost. Do not
copy a derived value into another mutable field and maintain it with an effect.

StateFlow uses Kotlin equals-based conflation and collectors can skip
intermediate values. Use immutable values; an equal new object need not trigger
a UI update. Business identity or revision should be represented explicitly
when meaningful. Do not recreate JS reference equality or Object.is semantics
as a universal native rule.

## Consistent Transitions

One business action owns the complete transition. Update coupled fields in one
immutable state value with MutableStateFlow.update. Its updater may be evaluated
multiple times under contention, so keep the lambda pure; perform IO outside it.
Derive validation from that same snapshot.

combine joins the latest emitted values from its inputs; it is not a transaction
across independently updated flows. Avoid splitting a coupled invariant across
separate mutable streams and assuming recombination makes it atomic. Independently
owned data can still use separate streams.

For Compose-owned state, Snapshot.withMutableSnapshot can publish related changes
atomically when needed. The block must not suspend. Do not hold a state transaction
across network work or build a Promise-style computed scheduler.

## Semantic Actions

Use named methods or suspend functions such as saveDraft, connectAccount or
cancelUpload. The view forwards an event; the owner handles ordered state
changes, IO and the result. A generic Command object or get/set visitor is not
required to enforce that boundary.

Keep business actions separate from render-time derivation. Native effects such
as LaunchedEffect and DisposableEffect are appropriate for composition-owned
synchronization/resources; they do not replace the owner of a business operation.
Ordinary pure helpers and shared use cases do not need a state-framework wrapper.

## Async Ownership And Errors

Finite repository/business operations expose main-safe suspend APIs; changing
data exposes Flow. Use structured concurrency, viewModelScope for screen-owned
work and an explicitly injected longer-lived scope when work must outlive that
screen. Move blocking/CPU work to an appropriate injected dispatcher.

Use native Job cancellation and cooperative suspend APIs. Propagate
CancellationException and release resources in finally/owned teardown. Adapt
external callbacks at the boundary with cancellable APIs and paired cleanup.
Do not introduce a separate AbortSignal analogue for ordinary coroutine work.

Choose latest-wins cancellation for replaceable queries, not automatically for
business writes such as Send. A cancelled coroutine is not proof that a remote
write failed or was rolled back; preserve operation identity and authoritative
readback for integrated features.

StateFlow cannot carry an upstream failure by itself. Materialize relevant
loading/data/error phases in a typed UI/request state before sharing the stream.
Do not catch every Throwable, consume coroutine cancellation, duplicate an
existing request phase in independent booleans or replace domain state machines
with generic loading flags.

## Collection And Sharing

Collect Flow in Android UI through collectAsStateWithLifecycle. Composition
presence, lifecycle STARTED/STOPPED, ViewModel clearing and account replacement
are different boundaries. Native editing, focus and scrolling stay with their
native controls/plain UI state holders at the lowest suitable owner.

A collector does not necessarily own the shared producer. stateIn/shareIn scope
and SharingStarted policy jointly determine upstream lifetime. WhileSubscribed
is suitable for work that should stop without consumers; it can cancel upstream
after its timeout. Lazily/Eagerly or explicit domain-owned work can be appropriate
for other lifetimes. Do not apply one timeout to all requests or move persistent
business writes into a composition-owned collector.

Construct shared pipelines once at their owner boundary. Replace identity-scoped
owners on account/workspace changes and reject obsolete publication. Avoid
unbounded keyed caches and process-global mutable feature state. Persist drafts
or resumable operations through their actual storage contract when required.

## References

- [Android architecture recommendations](https://developer.android.com/topic/architecture/recommendations)
- [UI state production](https://developer.android.com/topic/architecture/ui-layer/state-production)
- [Coroutine best practices](https://developer.android.com/kotlin/coroutines/coroutines-best-practices)
- [State hoisting](https://developer.android.com/develop/ui/compose/state-hoisting)
- [StateFlow contracts](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/-state-flow/)
- [Android testing](android-testing.md)

Setup and executable checks belong in the [Android README](../../android/README.md).

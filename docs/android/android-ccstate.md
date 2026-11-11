# Kotlin CCState

The behavior authority is [TypeScript CCState 6.1.0](https://github.com/e7h4n/ccstate/tree/86f95f2841c15474f08fcfc8e040c078dd2ab093),
commit `86f95f2841c15474f08fcfc8e040c078dd2ab093`, including its core and React
adapter implementation/tests. Swift CCState and outdated upstream README watch
examples do not override that contract. Kotlin source and native tests live in
[`android/ccstate`](../../android/ccstate) and
[`android/ccstate-compose`](../../android/ccstate-compose).

## Definitions and Ownership

`state` defines writable input, `computed` defines a readable derivation, and
`command` defines a semantic action with read/write capability. Definitions
are stable identities; each `Store` owns independent values, errors and graph
dependencies. Construct them outside composable bodies and command execution.
Pass runtime action inputs to a stable command.

```kotlin
private val text = state("")
val canSubmit = computed { get, _ -> get.get(text).isNotBlank() }
val replace = command<String, Unit> { context, value -> context.set(text, value) }
```

Invoke `store.get(canSubmit)` and `store.set(replace, value)` from the owning
thread. `store.update(state) { previous -> next }` is distinct from `set(state,
functionValue)`: Kotlin does not use the JS function/updater ambiguity. This is
a syntax adaptation, not a different derived-state model.

Stores and all their accessors, continuations and cleanup are confined to their
creating thread. Close subscriptions and Stores explicitly. `close()` rejects
future reads/writes, invalidates evaluations and releases the Store's cache;
it is a native owner API beyond TS's public Store surface.

## Parity Inventory

| Contract                       | Kotlin behavior and evidence                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Store isolation and lazy cache | Same definitions in different Stores have independent values/results; unobserved computations validate only when read               |
| Dynamic dependency tracking    | Explicit reads establish edges, including reads after suspension; branch replacement detaches obsolete edges                        |
| Late obsolete evaluations      | Old work may complete for its caller, but cannot reattach obsolete edges or replace the current handle                              |
| Direct readable watch          | `watch(signal, listener)` mounts/reads the signal, does not invoke the listener initially, and returns an idempotent `Subscription` |
| Listener reads                 | They do not add graph dependencies; express all observed dependencies in computed                                                   |
| Synchronous writes             | Internal command writes batch notifications; intermediate reads remain fresh; nested commands share the invocation boundary         |
| Public checkpoints             | Nested public `Store.set` follows the pinned changed-source checkpoint behavior; it is not a global transaction-depth counter       |
| Returned/escaped context       | The command's synchronous boundary ends when its callback returns; later writes flush individually                                  |
| Read errors                    | Original Throwable identity is cached/rethrown until relevant inputs change; writes before a throwing command remain applied        |
| Listener failures              | Other callbacks still execute; `ListenerException.failures` and suppressed causes expose aggregate failures                         |
| Core equality                  | JS-style scalar equality and object/error identity; floating NaN changes, signed zero compares equal                                |
| Evaluation signal              | Stable/lazy per evaluation; invalidated on actual reevaluation, not merely on an unobserved dependency write                        |
| Subscription lifetime          | Unsubscription does not cancel a computed evaluation or shared Deferred producer                                                    |
| Async values                   | Core stores the original value/Deferred handle without wrapping, inspecting, starting or cancelling it                              |
| Adapter state                  | Compose alone projects loading/data/error, initializes observations and fences stale results                                        |
| Refresh retention              | `keepLast` retains the previous phase while pending; a new error replaces prior data                                                |

The public-entry JVM tests translate behavioral scenarios from upstream
`batch-command`, `abort`, `watch-listener-prototype`, result, dependency and
glitch tests. They establish the covered contracts, not an assertion that every
upstream test or all performance/GC properties have been ported.

## Native Async Mapping

A computed may return a caller-owned `Deferred<T>`. Consumers in one Store
share the cached handle while dependencies remain unchanged. Native coroutine
scopes own producer work. An explicit `evaluation.signal.onCancel { ... }` can
opt that work into reevaluation cancellation; core does not cancel arbitrary
returned tasks. Release callback registrations with the work that owns them.
Closing a registration before its dispatch turn prevents invocation, including
when another cancellation callback removes it during reevaluation or Store close.

Cancellation callbacks belong to the retired evaluation. A failing callback
must not become the replacement computed's cached error or detach its new
dependencies. Unlike browser AbortSignal event dispatch, native cleanup errors
are reported as `ListenerException` when the outer public Store/accessor
operation finishes, after graph updates and notifications. Actual read failures
retain their own cached identity. This error-reporting boundary does not defer
public write checkpoints or extend command batching. Failed watch setup
releases the listener before reporting its error.

Kotlin `await()` of a completed Deferred may not suspend. JavaScript Promise
await always crosses a microtask boundary. This port supplies no hidden JS
scheduler or `asyncCommand` translation: the documented batching boundary is
the synchronous command callback's return. Use native coroutine APIs with
explicit ownership and test the actual resumed-write ordering. Independent
read failures may need supervision; cancellation and non-cancellation failures
must remain distinguishable.

A cancelled UI waiter is not a cancelled shared producer. A native owner
closing is not cancellation of a remote authorization or rollback of a Send.
Preserve late remote cleanup and confirmed-write/readback protocols outside core.

## Compose Adapters

Inject an existing Store with `StoreProvider`; the provider creates no Store
and owns no business cache. `observeAsState` observes synchronous signals;
`observeDeferredAsState` resolves shared Deferred signals. Both return
`State<Loadable<T>>` with `Loading`, `Data(value)`, or `Error(cause)`.

`rememberSetter` and `rememberCommand` bind stable actions to the provided
Store/definition. Target replacement creates a new observation. Disposing the
composition detaches observation and cancels only its waiter. The owner still
closes producer work and the Store at the correct boundary. A missing provider
fails explicitly; never substitute a process-global Store.

The non-Compose `observe` and `observeDeferred` entry points share those real
subscription paths and can be used by native adapters. Call them and close
their returned Subscription on the Store's owner thread. Default UI equality
follows React's `Object.is`: reference values use identity, NaN compares equal,
and signed zero differs. Do not put a structural-equality StateFlow between the
core and its observer; it can hide a fresh equal-looking reference.

## JVM Memory and Type Boundaries

The cache uses weak signal keys and avoids retaining the computed definition
through its own async Getter. Dynamic branches release old dependency edges;
disposed subscriptions clear their retained captures. Java WeakHashMap does
not implement JS WeakMap ephemeron collection: values or arbitrary payload
cycles referring to keys can retain them. Do not claim full GC equivalence.
Bound actual feature owners and close their Stores, and investigate retention
with live-owner/obsolete-branch fixtures rather than clearing the whole graph
to make a memory test pass. Do not add TTL eviction that changes memoization.

The heterogeneous node cache requires one localized erased-value cast. Writes
are protected by signal identity and typed State/Computed constructors. Do not
export that erasure or introduce unchecked business casts. Kotlin failures are
Throwables, unlike JS arbitrary thrown values. Float/Double use the corresponding
IEEE equality rules; native integer primitives preserve exact values, including
Long values beyond JS Number precision. Different Kotlin numeric types remain
distinct; custom Number subclasses are reference payloads. This native type
extension must not introduce lossy conversions into graph or UI equality.

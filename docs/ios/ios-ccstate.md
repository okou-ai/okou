# iOS ccstate

Use CCState for explicit reactive inputs, derivation, shared asynchronous reads,
and semantic graph actions. Apply [iOS development](ios-development.md) for
package boundaries and state-owner selection, and [iOS testing](ios-testing.md)
for verification. This guide owns Swift usage; the
[TypeScript ccstate references](../../.claude/skills/ccstate/SKILL.md) and
[Platform rules](../app/platform-ccstate.md) own JavaScript/browser syntax and
tooling.

## Native API Contract

Read the revision in
[`Package.resolved`](../../ios/Okou.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved)
when changing the dependency. The
[core contract](https://github.com/lancy/swift-ccstate/blob/d75c85c8ff3d8c5f9ee224f852ca7b3ad851ab7c/README.md)
and [SwiftUI adapter](https://github.com/lancy/swift-ccstate/blob/d75c85c8ff3d8c5f9ee224f852ca7b3ad851ab7c/Documentation/SwiftUI.md)
explain the APIs used here; recheck their semantics on a dependency upgrade.

| PWA concept                    | Swift expression and boundary                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `state`, `computed`, `command` | `State`, `Computed`, `Command`, accessed on `MainActor`                                                                   |
| Async computed/Promise         | `Computed<Task<Value, Error>>`; `computedTask` starts with `Task.immediate`                                               |
| Invalidation                   | Write an explicit reactive input/revision; re-evaluation produces the new Task                                            |
| Lifecycle signal               | Native Task ownership plus the evaluation's `options.signal`; not a browser `AbortController`                             |
| Loadable hooks                 | CCStateSwiftUI property wrappers under the owning `StoreProvider`                                                         |
| Semantic command composition   | `context.set(subcommand, input)`; services without graph access remain ordinary typed APIs                                |
| Function-valued state          | Swift distinguishes `set(state, value)` from `set(state, update:)`; do not copy the JavaScript updater-wrapper workaround |

Swift uses throwing graph APIs and explicit result values in `body`. Do not
copy browser bans on `try/catch`, timer primitives, `onRef`, or the TS `accept`
helper into native code. Preserve the underlying ownership/error contract using
the native transport and lifecycle APIs.

## Graph Construction and Identity

Keep `State`, `Computed`, and `Command` definitions stable for their real owner.
Construct them in the owning object/factory, outside `body`, rendering/update
callbacks, and repeated action execution. Pass runtime action values as command
input rather than constructing a fresh command for every invocation.

Keep mutable atoms private. Expose meaningful read signals, semantic commands,
or owner methods that invoke those commands. Derive filters, availability,
validation, and projections in `Computed` rather than synchronizing a second
mutable property. Avoid no-op writes when they invalidate meaningful consumers.

```swift
import CCState
import Foundation

@MainActor
final class DraftTextSignals {
  private let text = CCState.State("")
  let canSubmit: Computed<Bool>
  let replaceText: Command<Void, String>

  init() {
    let text = text
    canSubmit = Computed { get in
      !(try get(text)).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    replaceText = Command { context, value in
      guard try context.get(text) != value else { return }
      try context.set(text, value)
    }
  }
}
```

The owner retains the graph and its Store, and invokes
`try store.set(signals.replaceText, value)` from an action. A graph command
should compose related graph writes, not export its `Getter`, `CommandContext`,
or Store as an unstructured service interface. Do not retain accessors in
process-wide helpers. Async commands may use their scoped context across
suspension as supported by the library, with owner/cancellation checks before
publishing.

Share one Store and resource graph where callers share a resource lifetime,
such as a workspace's model/navigation reads. Independent drafts may own
independent graphs. Neither a Store per render nor one process-wide Store for
every account is the default. Different signal definitions in the same Store
do not automatically deduplicate equal HTTP requests.

## Resource Reads

Use a cached Task-valued computed as the source of a repeatable resource read.
Consumers of the same signal in the same Store receive the same Task while its
dependencies are unchanged. A failed Task remains cached until an explicit
dependency change/retry; observing it again is not a retry policy.

The following minimal owner illustrates evaluation cancellation and owner
teardown. It is an example, not a required base class or a second resource
framework. Existing workspace reads belong in
[`WorkspaceResources`](../../ios/Okou/App/WorkspaceResources.swift).

```swift
import CCState
import Foundation

@MainActor
final class ReadSignals<Value: Sendable> {
  private let store: CCState.Store
  private let revision = CCState.State(0)
  private let closed = CCState.State(false)
  private let read: @MainActor () async throws -> Value
  private var current: Task<Value, Error>?
  let reload: Command<Void, Void>

  init(store: CCState.Store, read: @escaping @MainActor () async throws -> Value) {
    self.store = store
    self.read = read
    let revision = revision
    let closed = closed
    reload = Command { context in
      guard try !context.get(closed) else { throw CancellationError() }
      try context.set(revision, update: { $0 + 1 })
    }
  }

  lazy var value = Computed<Task<Value, Error>> { [weak self] get, options in
    guard let self else { throw CancellationError() }
    guard try !get(closed) else { throw CancellationError() }
    _ = try get(revision)
    let signal = options.signal
    let task = Task.immediate { @MainActor [read] in
      let result = try await read()
      try Task.checkCancellation()
      try signal.checkCancellation()
      return result
    }
    current = task
    signal.onCancel { task.cancel() }
    return task
  }

  func close() throws {
    current?.cancel()
    current = nil
    try store.set(closed, true)
  }

  isolated deinit { current?.cancel() }
}
```

The caller owns the `ReadSignals` instance and calls `close()` when its resource
lifetime ends. The graph coordinates I/O; the supplied read uses the existing
Data service. Read errors stay in the original Task. The example does not add
automatic recovery or mutation semantics.

For independent reads, collect their dependency Tasks before awaiting the first
result so an unrelated slow endpoint does not serialize startup. Preserve
independent loading/error outcomes rather than forcing all sections through
one success barrier. Aggregate only where the business contract needs an
atomic/complete snapshot.

Do not copy a read's lifecycle into mutable `items/isLoading/error` properties
or launch an additional `.task` request for each subscriber. The following are
different responsibilities and may still need explicit state:

- a confirmed snapshot used by non-view decisions, with explicit publication
  and reconciliation through its authoritative owner;
- a persisted baseline, local draft, optimistic delivery, or dirty-write state;
- bookkeeping such as an owned Task handle, retry eligibility, or closed flag;
- an authorization/mutation phase with its own domain meaning.

Name why that state exists and how it reconciles. It must not compete with the
resource's loadable state. A confirmed snapshot never authorizes ignoring a
known authentication, permission, or compatibility failure.

## SwiftUI Consumers

Provide the existing Store through `StoreProvider`; it injects that instance
and does not create another cache. Initialize runtime wrappers' backing
storage in the consumer's initializer and keep observation close to the view
that needs the value.

| Need                                                 | Wrapper                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| Synchronous value with explicit graph error          | `@LoadableValue(signal)`                                     |
| Async data/loading/error                             | `@LoadableValue(task: signal)`                               |
| Optional resolved data plus projected phase/error    | `@ResolvedValue(task: signal)` and `$property`               |
| Retain the previous phase while a refresh is pending | `keepLast: true` on the appropriate async wrapper            |
| Loading phase without payload updates                | `@LoadableStatus(task: signal)`                              |
| Stable state writer or semantic action               | `@SignalSetter` or `@CommandSetter`                          |
| Local invocation phase for an action                 | `@LoadableSetter`, with `task:` for a Task-returning command |

The `task:` label matters: without it a Task can be observed as an ordinary
synchronous value rather than resolved.

```swift
import CCState
import CCStateSwiftUI
import SwiftUI

struct NamesContent: View {
  @LoadableValue private var names: Loadable<[String]>

  init(names: Signal<Task<[String], Error>>) {
    _names = LoadableValue(task: names)
  }

  var body: some View {
    switch names {
    case .loading: ProgressView()
    case .hasData(let values): Text(values.joined(separator: ", "))
    case .hasError: Text("Unable to load names")
    }
  }
}
```

The owner supplies `StoreProvider(owner.store) { NamesContent(names: signal) }`.
Use real shared native loading/error components and semantic retry actions in
production; the example only demonstrates phase projection. Preserve semantic
owner identity for local view state, using `.id(...)` when that state must be
replaced with the owner. Do not invent changing keys to suppress updates.

`keepLast` retains the previous **phase** only while the next Task is pending,
including a previous error. A new error replaces old data; it does not mean
"show the last successful value through every failure." `ResolvedValue`
returns `nil` when there is no data, so inspect its projected `Loadable` when
loading and failure differ. Switch on the cases when successful data can itself
be `nil`.

Use equality only for the actual value contract. The defaults compare Equatable
values by value and reference values by identity; a custom `equals:` must not
hide meaningful changes to reduce rendering. A missing provider surfaces as
`StoreObservationError.missingStore`; repair the injection rather than treating
it as an empty or unavailable remote resource.

A same-scope confirmed business snapshot may support an explicitly designed
stale display while the current error remains visible. Do not retain another
workspace's data or implement a second generic last-success cache for a
presentation-only convenience.

## Commands and Invalidation

One action should express a complete business transition. Use stable `Command`
definitions for graph writes and `context.set` for graph-aware subcommands.
Ordinary pure helpers and Data service methods do not need to become commands
when they do not consume graph accessors.

`asyncCommand` returns a `Command<Task<Value, Error>, Input>`. Await the original
Task when the next step depends on completion, and give background work a
retained owner and cancellation path. `@LoadableSetter` observes an invocation;
it does not grant ownership of the mutation to the view or cancel prior
business work automatically.

Plain writers retain their original Store/signal target when they escape a
view. Do not invoke a retired owner's writer after scope replacement. Loadable
setters reset local observation on target changes; synchronous invocation
errors still throw, while asynchronous failures appear in their phase.

Keep read invalidation separate from write confirmation. Follow the owning
resource's actual invalidation protocol, including realtime notifications;
do not add both local refresh and notification refresh without examining
ordering and duplicate work. Invalidation changes dependencies; it does not
prove a write committed or authorize replaying it.

Retries change only the failed resource's relevant input/revision unless the
caller intentionally requests a complete refresh. Debounce query work under
the search/presentation owner. Preserve each endpoint's semantic cache key;
similar-looking lists from different API contracts are not interchangeable.

## Cancellation and Teardown

There are three separate lifetimes:

1. **UI waiter/subscription:** the adapter detaches and ignores stale results
   when its Store/signal target changes or view storage is released.
2. **Computed evaluation:** a re-evaluation cancels the previous
   `options.signal`. Forward it to the original Task with `onCancel` or check
   it after suspension as appropriate.
3. **Resource/business owner:** closing the workspace, draft, presentation, or
   operation releases the work and resources it owns.

Unwatching or hiding a view does not automatically cancel the evaluation or its
cached Task. `computedTask` and `asyncCommand` do not automatically forward
evaluation/owner cancellation to arbitrary work. Cancelling a Task awaiting
another unstructured Task's `.value` does not cancel that shared Task. A row
disappearing must not cancel another consumer's shared read.

Register teardown with acquisition. Retain the original request Task where the
resource owner needs to cancel it. Keep subscriptions, native observers, SDK
callbacks, streams, and temporary files under that same owner. A manual
`store.watch` needs explicit `Subscription.cancel()` and an initial read:
`watch` establishes dependencies but does not initially invoke its listener.

After any suspension that can outlive a request or identity, check native
cancellation, evaluation cancellation when applicable, and the current owner
or operation identity before publishing. A generation token can fence a
late callback; it does not replace cancellation of the underlying work.

Teardown must invalidate future publication as well as cancel current work.
Close retained owners explicitly; `deinit` is a final safety net, not
proof that SwiftUI/navigation released the owner. Account/workspace replacement
must also clear identity-scoped state and sensitive transient values.

Cancellation of a remote mutation is not rollback. A late authorization-start
response may contain a remote session that still needs cancellation; preserve
that cleanup even after local presentation ends. Protocol polling needs a real
owner, server cadence/expiry, and a stop path. Do not use timed polling or fixed
sleeps as a substitute for operation completion in tests.

## Native Adapters and Review

Keep UIKit selection, marked text, undo, focus, gesture arbitration, and scroll
state with the native control/coordinator. Publish semantic document changes
through the owning draft action; reject callbacks from retired editors without
resetting the active editor to repair state.

An Observation bridge may publish graph invalidation to existing native
consumers without storing a second document or loading/error state. It must
own/cancel its subscription and preserve the graph's identity. Use direct
CCStateSwiftUI consumers for suitable SwiftUI resource views; do not add a
parallel bespoke observer just for the same data.

Review the complete path: trigger, graph/Store identity, dependency Task,
publication, invalidation, and teardown. Confirm which state is a resource
phase, confirmed business value, domain phase, or native interaction. Keep
cache bounds and error propagation explicit. Test the affected production
contract, not the number of atoms, subscriptions, callbacks, or view updates.
Native interaction and performance acceptance follow the
[development](ios-development.md#verification-and-review) and
[testing](ios-testing.md#native-acceptance-and-ci) guides.

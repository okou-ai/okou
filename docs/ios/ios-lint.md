# Native SwiftLint Rules

Native code uses the pinned SwiftLint source plus the rules in
[`ios/Tools/SwiftLint/Rules`](../../ios/Tools/SwiftLint/Rules). They use SwiftSyntax,
run with SourceKit disabled, and do not compile the App. Follow
[iOS development](ios-development.md) and [iOS ccstate](ios-ccstate.md) for the
underlying ownership contracts. Setup commands belong in the
[iOS README](../../ios/README.md#swiftlint).

## Enforced Boundaries

| Rule                         | Contract                                                                                                                                                                                | Web counterpart                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `okou_render_effects`        | No known imperative requests, graph writes/construction, Task launches, subscriptions, or external state assignments during native projection.                                          | `no-side-effect-in-render`                                        |
| `okou_stable_graph`          | Construct graph definitions at the owner, not inside graph callbacks, UI actions, or repeatedly invoked operation methods.                                                              | `no-command-in-command` and signal identity guidance              |
| `okou_private_atoms`         | Keep mutable CCState atoms private or fileprivate, including their enclosing owner; expose read signals and semantic commands.                                                          | `no-export-state`                                                 |
| `okou_accessor_escape`       | Do not pass, store, return, or capture graph accessors into known deferred callbacks; ordinary helper parameters cannot expose Getter/CommandContext.                                   | `no-accessor-escape`, `no-getter-setter-params`                   |
| `okou_native_requests`       | Raw URLSession operations and method references belong at their transport definition sites.                                                                                             | `no-direct-fetch`                                                 |
| `okou_resource_failures`     | Preserve failures inside Computed/computedTask/Command/asyncCommand; reject optional try and unfiltered empty outcomes, plus cancellation catches that return successful resource data. | Error-swallowing helper restrictions and cancellation propagation |
| `okou_test_synchronization`  | Reject known fixed-duration sleeps and fixed-count yield loops in XCTest/Swift Testing code.                                                                                            | `no-test-delay` and test synchronization guidance                 |
| `okou_check_after_await`     | Check cancellation or current owner identity after suspension before a direct graph or owner-state write.                                                                               | `signal-check-await`                                              |
| `okou_resource_cancellation` | Newly constructed resource Tasks connect to evaluation cancellation; retained original Tasks have explicit owner teardown.                                                              | `require-client-signal` and lifecycle ownership                   |
| `okou_subscription_teardown` | Pair known CCState subscriptions and block-based notification tokens with cleanup of the original handle or retained collection.                                                        | Native lifecycle ownership                                        |
| `okou_import_boundaries`     | Keep Ably/Clerk imports at native adapters and provider-test entry points; preserve Domain/Data dependency direction.                                                                   | `no-restricted-imports`                                           |
| `okou_storage_boundaries`    | Keep raw UserDefaults dependencies at existing persistence owners; allow AppStorage only for registered UI preferences and tests to construct explicit suites.                          | `no-direct-local-storage` and `no-direct-session-storage`         |
| `okou_task_lifecycle`        | Cancel or drain newly created, retained business Tasks at explicit owner teardown; preserve the original single handle when replacing it.                                               | Native extension of async ownership; no identical Web rule        |

The existing SwiftLint rules also check discarded throwing Tasks
(`unhandled_throwing_task`), discarded block-based notification observer handles
(`discarded_notification_center_observer`), and exposed SwiftUI `@State` /
`@StateObject` properties (`private_swiftui_state`). A retained Task must still
have a real result/cleanup owner; retaining an observer does not prove teardown.

## Native Semantics

- `body` and `@ViewBuilder` helpers project state. Builder content is checked;
  event/lifecycle callbacks are separate execution boundaries. An explicit
  `Button(action:)` leaves its label builder in render scope. Shared native
  controls' callback contracts are recorded alongside standard SwiftUI callbacks
  in `SyntaxSupport.swift`; new contracts need positive and negative CLI cases.
- UIKit update callbacks may update their supplied native control and
  coordinator, including local aliases. A SwiftUI transaction may configure its
  own transaction value. Local constructor-produced projection values may be
  configured in place; aliases of business owners remain checked.
- Graph definitions in owner initializers and returning factories are valid.
  A test invocation also owns fresh fixture graphs; graph callbacks and render
  bodies inside a test remain checked.
- SwiftUI `@State` is not a CCState atom. Native focus, selection, gestures,
  editing, and other control-owned state remain valid. `fileprivate` sharing
  inside a private resource implementation is not a public feature interface.
  A private setter alone still exposes a mutable atom through its getter.
- A scoped native async command may use its context after suspension. Passing
  it to an ordinary helper or capturing it into a separate Task is different.
- Known transport definition sites implement API requests or credential-free
  public asset requests. Business callers use typed ChatData services. Review
  changes to those owners as transport changes; do not broaden exclusions to
  hide feature-local requests.
- Typed domain catches, cancellation rethrows, and cleanup followed by rethrowing
  the original error remain valid. In a Computed/computedTask resource read,
  a cancellation catch cannot return successful data. A semantic command or
  native presentation operation may deliberately end a cancelled action.
  An explicitly typed `Computed/Signal<Task<Void, Never>>` is a completion-only
  owner bridge; ending its cancelled work does not publish resource data.
  A data-producing `Task<Value, Never>` still cannot fabricate successful data
  from cancellation.
  Request phases belong to CCStateSwiftUI loadables; drafts, confirmed snapshots,
  and protocol phases follow their own business contracts.
- Tests await observable completion or an owned gate. Fixed sleep durations,
  including local constant aliases, and constant-bounded `for` loops with
  `Task.yield()` are checked. Forwarding a duration through an injected clock,
  bounded XCTest expectation timeouts, and waits that observe a result remain
  valid. Production protocol polling retains its owner, server cadence and
  cancellation contract; it is not a test synchronization primitive.
- In CCState files, known graph callbacks and native Task bodies check direct
  graph writes and stored-owner assignments after suspension. A throwing
  `Task.checkCancellation()`, an evaluation-signal check, or a terminating
  closed/generation guard can establish the current publication path. A check
  before the await, in another branch, or swallowed with `try?` cannot do so.
  Compound conditions must fence the actual continuing path; a conditional
  cancellation exit or a flag passed to an unknown helper is not proof.
  Same-owner synchronous check helpers are accepted only when their bodies
  establish the check; their names alone grant nothing. Local projections and
  deferred teardown are different from publishing resource data.
- A new asynchronous Task constructed directly in a `Computed`/`computedTask` callback, or in
  a Task factory taking `EvaluationSignal`, connects that signal's `onCancel`
  to the original immutable Task binding or a local alias. Registration and
  cancellation cannot depend on an unrelated condition or occur after an early
  return. Register teardown before the creating scope suspends. Cancelling another
  Task or a shadowed binding does not satisfy ownership. When the callback
  retains the Task in a stored handle, explicit close/cancel teardown releases
  that handle, directly or through a same-owner synchronous helper; `deinit`
  alone is insufficient. Waiting on a Task from an existing resource does not
  acquire ownership of that shared request. Do not cancel it merely because a
  derived consumer stops waiting. Already-completed Tasks and unrelated native
  operations retain their own contracts.
- Known `Store.watch` subscriptions and block-based `NotificationCenter` tokens
  keep the original handle under a visible cleanup owner. Local handles use
  `defer`, XCTest `addTeardownBlock`, or the current evaluation signal's
  `onCancel`; explicit returns transfer ownership to the caller. Retained handles
  and arrays/dictionaries have a release path through `close`, `stop`, `cancel`,
  `dismiss`, `deactivate`, `invalidate`, or `detach`, including synchronous
  same-owner helpers. Collections cancel every element; an early break/return,
  filtered iteration, clearing the collection, or an uncalled closure is not
  cleanup. Cancellation through optional bindings and immutable snapshots is
  valid; shadowed or overwritten handles do not release the original. Block
  observers are removed from their original notification center. Native
  `UIView`/`UIViewController` destruction is a valid control lifetime; a retained
  business owner's `deinit` alone is not an explicit close path. Selector-based
  notification registration retains its system-managed semantics.
- Class/actor owners with a named teardown entry (`close`, `stop`, `cancel`,
  `dismiss`, `deactivate`, `invalidate`, `detach`, `suspend`, `clear`, or `finish`)
  pair newly constructed, nonempty Tasks with cancellation or completion of the
  original handle. A business `deinit` alone is insufficient. The check follows
  Task-typed properties (or direct Task initializers), arrays/dictionaries of Tasks, immutable
  snapshots, all-element loops, and same-owner helpers. Dropping the property,
  clearing a collection, cancelling a different handle, a filtered loop, or an
  uncalled cleanup closure does not release the work.
  Single-handle replacement first cancels/awaits the old Task, proves that the
  handle is absent, or transfers it to another explicit completion owner. A UI
  busy flag alone is not proof; use the actual handle for operation exclusion.
  A loop must establish safe replacement on each iteration or complete the
  newly created work before continuing; cancellation only before the loop is
  insufficient.
  An awaited `value` or `result` establishes completion. A derived Task that
  awaits the original preserves its completion dependency; cancelling that
  derived Task does not cancel the original. A synchronous teardown may return
  a Task that drains its captured original handles, transferring completion to
  its caller. Such drains use immutable local values or explicit capture-list
  snapshots; reading a mutable property or local later is not an original-handle
  capture. This allows accepted writes and late remote cleanup to finish
  without inventing cancellation or rollback. Resource evaluation Tasks retain
  the separate `okou_resource_cancellation` contract.
- Ably, ClerkKit and ClerkKitUI imports belong to the exact realtime,
  authentication, sign-in presentation, authentication-theme and notification
  extension definition sites recorded in `ImportBoundariesRule.swift`. The
  existing external-provider fixtures/tests can import their real SDK; another
  file named `Tests` or placed in a test directory does not acquire that role.
  Review a new adapter's responsibility before registering its import site.
  ChatDomain production sources import only Foundation and the Swift standard
  library. ChatData production/test-support sources reject known App, UI,
  graph, identity and realtime modules while retaining system transport,
  storage, crypto and synchronization frameworks. Package test targets retain
  their test-framework and public package imports.
- Raw `UserDefaults` references, type aliases and injected production types
  belong to the notification-metadata and one-way preference-migration definition
  sites in `StorageBoundariesRule.swift`. Project disclosure uses its typed SQLite
  storage; it does not retain a direct-defaults exception. Callers use their semantic operations.
  `@AppStorage` remains valid for the registered appearance and sidebar keys at
  their exact view definition sites; the same file cannot introduce a new
  business key or a custom `store:`. Direct wrapper construction and aliases do
  not create another preference owner.
  Native tests and ChatData test support may construct an explicit nonempty
  `UserDefaults(suiteName:)`, including qualified and contextual initializers.
  They may inject its typed value, but cannot acquire `.standard`, an unnamed
  domain, a constructor/metatype reference, or a type alias hiding that access.
  Fixtures still own unique suite names and immediate domain cleanup as required
  by [iOS testing](ios-testing.md#external-fixtures-and-isolation).

## Static Analysis Limits

These are syntax checks, not a whole-program ownership proof. They recognize
direct graph/API spellings, local transport aliases, scoped accessor bindings,
and known callback contracts. Cross-file type aliases, arbitrary wrappers,
indirect helper effects, and custom callback execution semantics need review.
Cancellation checks track direct local statement paths, recognized owner guards,
and same-file helpers rather than proving every control-flow path, dynamic
dispatch target, or cross-file teardown contract.
Task lifecycle checks require an explicit class/actor lifetime boundary (or a
business destructor) and directly visible Task construction and storage types.
Inferred/cross-file factories, tuple-held handles, dictionary-key replacement,
arbitrary collection mutation, actor reentrancy, owners without a recognized
teardown entry (including process/SDK lifetimes), and view-owned Task handles
still require review.
The rule does not require a borrower to cancel a shared Task or prove that every
caller invokes teardown and awaits a returned cleanup Task. A syntactically
recognized completion dependency is not proof of upstream cancellation.
Subscription checks recognize local handle transfers, direct Store spellings,
`store`/`stateStore` members, known notification centers, and local immutable
center aliases. Cross-file factories, custom callback lifetimes, dynamic
receivers, arbitrary collection mutations, and whether a caller actually invokes
its owner's close path still need review. Returning a handle is an ownership
transfer, not proof that its eventual caller releases it.
Import checks inspect declarations, including attributed, scoped and
conditional imports, at known source paths. They do not resolve transitive
dependencies, inferred SDK values, type aliases or every future UI/SDK module.
ChatData's known forbidden module edges complement its package manifest;
unknown dependencies and SDK operations still require architectural review.
Storage checks restrict explicit native defaults dependencies and registered
property-wrapper declarations. They do not resolve arbitrary cross-file
factories, inferred helper parameters, runtime suite-name values, or prove that
a test suite is unique and eventually cleared. They do not inspect SQLite,
Keychain, files, or third-party persistence internals.
In particular, a variable called `isLoading` or `error` is not by itself a
violation. The rules do not prove cache bounds, complete teardown, mutation
rollback, or every cancellation path.

Do not copy browser-specific bans on native do/catch, timer primitives, Store
injection, or Computed evaluation cancellation into Swift. Preserve existing
native interaction and cleanup when fixing a finding. Never add a baseline,
inline suppression, or broad file exclusion to obtain a passing result.

## Verification

`Tests/rules.test.py` invokes the compiled SwiftLint CLI against temporary
Swift sources and verifies diagnostic identifiers, source lines, and exit
status. Fixtures are parsed by SwiftLint; they do not require SwiftUI or an App
build. Keep cases for eager builders, deferred actions, owner construction,
accessor shadowing/capture, request aliases, and error propagation together with
their rule changes.

`build.py` combines an immutable upstream revision and the native-rule sources
into an input identity. Publication verifies the binary version, records its
SHA-256, and publishes the binary/receipt atomically. The lint entry point
rejects stale rules and changed binaries, including explicitly supplied
`SWIFTLINT_BIN` overrides. A cached tool is an execution optimization, not a
substitute for running lint or the rule fixtures.

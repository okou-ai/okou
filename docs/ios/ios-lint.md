# Native SwiftLint Rules

Native code uses the pinned SwiftLint source plus the rules in
[`ios/Tools/SwiftLint/Rules`](../../ios/Tools/SwiftLint/Rules). They use SwiftSyntax,
run with SourceKit disabled, and do not compile the App. Follow
[iOS development](ios-development.md) and [iOS ccstate](ios-ccstate.md) for the
underlying ownership contracts. Setup commands belong in the
[iOS README](../../ios/README.md#swiftlint).

## Enforced Boundaries

| Rule                        | Contract                                                                                                                                                                                | Web counterpart                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `okou_render_effects`       | No known imperative requests, graph writes/construction, Task launches, subscriptions, or external state assignments during native projection.                                          | `no-side-effect-in-render`                                        |
| `okou_stable_graph`         | Construct graph definitions at the owner, not inside graph callbacks, UI actions, or repeatedly invoked operation methods.                                                              | `no-command-in-command` and signal identity guidance              |
| `okou_private_atoms`        | Keep mutable CCState atoms private or fileprivate, including their enclosing owner; expose read signals and semantic commands.                                                          | `no-export-state`                                                 |
| `okou_accessor_escape`      | Do not pass, store, return, or capture graph accessors into known deferred callbacks; ordinary helper parameters cannot expose Getter/CommandContext.                                   | `no-accessor-escape`, `no-getter-setter-params`                   |
| `okou_native_requests`      | Raw URLSession operations and method references belong at their transport definition sites.                                                                                             | `no-direct-fetch`                                                 |
| `okou_resource_failures`    | Preserve failures inside Computed/computedTask/Command/asyncCommand; reject optional try and unfiltered empty outcomes, plus cancellation catches that return successful resource data. | Error-swallowing helper restrictions and cancellation propagation |
| `okou_test_synchronization` | Reject known fixed-duration sleeps and fixed-count yield loops in XCTest/Swift Testing code.                                                                                            | `no-test-delay` and test synchronization guidance                 |

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

## Static Analysis Limits

These are syntax checks, not a whole-program ownership proof. They recognize
direct graph/API spellings, local transport aliases, scoped accessor bindings,
and known callback contracts. Cross-file type aliases, arbitrary wrappers,
indirect helper effects, and custom callback execution semantics need review.
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

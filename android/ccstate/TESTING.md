# CCState Contract Tests

The behavior baseline is TypeScript CCState 6.1.0 at
[`86f95f2841c15474f08fcfc8e040c078dd2ab093`](https://github.com/e7h4n/ccstate/tree/86f95f2841c15474f08fcfc8e040c078dd2ab093).
Compare actual runtime/tests when changing a contract. Setup and executable
commands live in the [Android README](../README.md).

## Coverage Map

| Contract                                                                                                    | Upstream scenarios                                           | Native tests                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Empty values, error identity/recovery and equal-error bailout                                               | `empty-state`, `result`, `distinct`                          | `ResultParityTest`, `StoreTest`                                               |
| Direct watch, last-listener teardown, reentrant unsubscribe and callback deduplication                      | `watch-listener-prototype`, `store`                          | `ResultParityTest`, `StoreTest`                                               |
| Synchronous/nested/public write boundaries, eager reads and updater-created subscriptions                   | `batch-command`, `effect`                                    | `PropagationParityTest`, `StoreTest`                                          |
| Shared cold caches, equal branches and multi-layer diamonds                                                 | `cache`, `propagation`, `glitch`                             | `PropagationParityTest`                                                       |
| Dynamic and late dependencies, identical shared async handles and obsolete work                             | `dependencies`, `promise`, direct readable-watch async cases | `EvaluationParityTest`, `StoreTest`                                           |
| Lazy/stable evaluation signals, per-store isolation, skipped signal reads and failed replacements           | `abort`                                                      | `EvaluationParityTest`, `StoreTest`                                           |
| Loading/data/error recovery, stale fulfillments/rejections and retained phases                              | React `loadable`, `readable-watch-migration`                 | `ObservationTest` in `ccstate-compose`                                        |
| Provider/target replacement, stable actions, default equality and composition disposal                      | React `get-and-set`, `loadable`, `readable-watch-migration`  | `ComposeAdapterTest` in `ccstate-compose`                                     |
| Creating-thread confinement, explicit close, cleanup failure isolation and coroutine cancellation ownership | Kotlin/JVM adaptations                                       | `NativeOwnershipTest`, `EvaluationParityTest`, `StoreTest`, `ObservationTest` |

Core cases exercise public Store/accessor/watch operations. Native adapter tests
exercise the actual observation functions and Compose consumers in the owning
library module; they do not depend on the application scaffold. Use controlled
Deferred gates and the test scheduler instead of copying upstream timer delays.
Computation/commit counts test memoization and observer contracts, not private
node-map lookups or wall-clock performance.

## Deliberate Boundaries

Do not turn this map into a claim of complete upstream/API equivalence.
Interceptors, React-specific command-loadable/custom-equality APIs, JS primitive
throws and undefined are outside the current Kotlin surface or type system.
Read-only capabilities are enforced by Kotlin types rather than runtime tests
that attempt an invalid computed write.

JVM WeakHashMap is not a JS ephemeron map. Dynamic-branch tests establish edge
detachment and observable invalidation; they do not establish full GC parity.
Avoid flaky collection deadlines or assertions that merely collect the entire
owner. Keep owners alive when investigating obsolete-branch retention and
report measured reachability separately.

Robolectric covers Compose subscription/action lifetimes and observable commits.
Actual Android device, IME, process recreation and performance acceptance remain
separate from these library contract tests.

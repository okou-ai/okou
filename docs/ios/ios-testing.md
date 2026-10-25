# iOS Testing

Apply the [shared testing principles](../testing.md) and the
[Web principles](../app/app-testing.md) to `ios/`: exercise a real production
entry point, mock only external dependencies, and verify an independent caller
contract. Matching Web's principles does not require a UI automation runner.

## Fast Admission Tests

Report the complete required iOS CI duration, including checkout, dependency
preparation, compilation, simulator startup, all selected tests, and the final
gate. Include archive validation and publication when the event requires them;
test-body time alone does not establish workflow performance. Keep the existing
standard runners and workflow limits: 30 minutes for App build/tests and 15
minutes each for package tests and device archive builds. Optimize measured
bottlenecks within those limits. A cache hit may accelerate the run but cannot
replace verification.

Required CI primarily covers business, HTTP, security, compatibility,
persistence, cancellation, and recovery contracts in process. Do not add
XCUITest, a separate fixture application, screenshot/OCR assertions, appearance
matrices, UI pixel/geometry assertions, or full-screen navigation journeys to
admission CI. Do not require exact scroll offsets, view sizes, animation frames,
or settled layout as prerequisites for business assertions. Keep ordinary visual
and interaction acceptance explicit and on demand.

Choose the cheapest boundary that still proves the independent guarantee. Do
not duplicate a Domain/Data contract through App rendering or repeat the same
journey for every transport status, color scheme, and text size. New tests must
justify their coverage beyond existing checks. When necessary native input
coverage exists, keep a small focused case for the product's own input bridge;
do not retest UIKit editing defaults, system menus, or view configuration.

## Choose the Boundary

| Surface               | Production entry                                                                                    | Observable contract                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ChatDomain            | Public projection, replay, and value APIs                                                           | Message semantics, canonical parts, ownership, and protocol compatibility                                            |
| ChatData              | Public clients, commands, synchronization, and storage APIs                                         | HTTP responses and requests, returned values, idempotency, authenticated scope, and persistence after reopening      |
| App orchestration     | The production feature operations called by its consumers, with real commands and data dependencies | Canonical writes/readback, retained user input, delivered message identity, recovery, and resource ownership         |
| Native input bridge   | The owning production editor/control, only where its integration adds an independent guarantee      | Product-specific structured input, marked text, clipboard payloads, and rejection of callbacks from a retired editor |
| Build/release tooling | The actual script or workflow caller                                                                | Exit status, consumed metadata, artifacts, and cleanup                                                               |

Keep internal production code real. Do not move App behavior into a package,
export a private helper, or add a product API just to make it testable. App
orchestration tests prove the exercised command/ownership contract; they do not
prove that a visible button is wired correctly or that a keyboard animation
feels right. Verify those properties in native acceptance.

Construct realistic inputs through the owning production boundary. Drive an
operation once, await its causal completion, and assert the result. Public
feature operations can exercise business orchestration without mounting every
screen. Do not substitute private pending flags, callback counts, cache entries,
object identity, parser arrays, exact cell counts, or diffable snapshots for the
contract. Public capability checks are meaningful only when they decide an
independent allowed/denied operation; incidental loading transitions are not.

Canonical request assertions are appropriate for authenticated scope, message
parts, captured model options, permission receipts, and idempotency identity.
Prefer readback through the production API or reopening actual storage when the
contract includes a persisted effect. Keep independently useful failure and
security cases; do not build a defensive matrix for states the authoritative
schema/writer cannot produce.

## External Fixtures and Isolation

Use the shared `ChatDataTestSupport` HTTP fixture for owned sessions and
realistic canonical responses. Intercept ordinary API requests in process with
`URLProtocol`, the native counterpart to Web's MSW boundary; do not send them to
live services. Unhandled requests must fail with their method and URL, including
requests whose errors an SDK catches. Mock only external HTTP, identity/realtime
providers, and genuinely external system capabilities. Keep real decoding,
commands, synchronization, SQLite, and temporary files.

Use unique reserved `.invalid` origins, identities, workspaces, storage scopes,
and temporary directories. Keep a real owned loopback server only for transfer
contracts such as compression and signed downloads, or a third-party SDK whose
public API cannot inject its HTTP transport. Identity tests keep the real SDK;
intercept its requests in process when supported, otherwise point its public
proxy configuration at the fixture's loopback service and disable telemetry.
Never fall through to live services, authorize a real account, or reuse a user's
signed-in simulator.

Register cleanup immediately after acquiring resources. Each case owns its
tasks, response gates, sessions, servers, files, windows, and altered clipboard
or system settings. Cleanup runs after throwing assertions as well as success:
cancel and await owned work, release gates, close production owners, invalidate
sessions, detach hosts, restore process-wide settings, and remove owned files.
Do not sweep another test's resources or leave work for the next case.

## Waiting and Verification

Await production operations, controlled external gates, or the smallest public
result that establishes readiness. A wait predicate only observes; actions and
fixture changes stay outside retries. Do not use fixed sleeps, fixed yield
counts, global bootstrap waits, or elapsed-time guesses to prove completion.
A negative result requires a positive causal completion point first.

Control an existing production clock only for actual scheduling/expiry
contracts. Do not expose scheduler internals or add a clock to preserve an
implementation assertion. Native input access belongs on the main actor. Keep
hosted tests sequential on one simulator, with one heavy local check at a time.

A full suite runs every retained test. Do not use exclusion lists, selected
happy paths, automatic assertion retries, or skipped required checks to shorten
the run. Reduce duplicate work, unnecessary UI coverage,
and dependency/build costs instead. Inspect `.xcresult` and the first failure
before rerunning; a later pass does not explain an earlier failure.

When changing tests, map the exact removed methods to retained contracts or
explicitly retired visual/implementation assertions in the owning PR. Validate
necessary replacements before removing mixed coverage. Keep this inventory out
of `docs/`; engineering guidance belongs here, task evidence belongs in the PR.

## Native Acceptance and CI

The shared `Okou` scheme runs the in-process App-hosted `OkouTests` target.
ChatDomain and ChatData package suites run separately. There is no XCUITest
runner or duplicate fixture App in required CI. Use the
[iOS README](../../ios/README.md#ci) for commands and
[archive promotion](../../ios/ARCHIVE_PROMOTION.md) for exact-input evidence;
cache/archive reuse is not a test waiver.

For relevant UI changes, run the app on an isolated simulator or an authorized
device and check the actual changed interaction. Appearance, glass/blur,
animation, scrolling, system menus, keyboard transitions, IME candidates,
VoiceOver, and document/authorization presentation need native acceptance when
touched. Record the exercised scenario, SDK, runtime, and limitations in the
PR. A saved screenshot is evidence, not an automatic regression assertion.

Use the minimum supported major version from `ios/Config/Shared.xcconfig` and
the CI runtime from `.github/workflows/ios.yml` as appropriate to the changed
native behavior. CI currently runs iOS 27.0; iOS 26 native acceptance is a
targeted additional check. An unavailable runtime is an acceptance gap.
Simulator results do not establish physical-device performance. A build,
passing tests, merged PR, uploaded build, TestFlight availability, and observed
device behavior are separate evidence.

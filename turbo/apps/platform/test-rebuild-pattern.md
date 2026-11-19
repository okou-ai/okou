# App test rebuild pattern

Temporary guide for rebuilding Platform Vitest tests from the adjacent BDD
files. Start with the scenario, current product entry points and this guide.
Use [Testing at Okou](../../../docs/testing.md) and
[Platform Testing Patterns](../../../docs/app/app-testing.md) as the source of
truth. The [external behavior boundary](../../../docs/testing.md#external-behavior)
governs setup as well as execution and observation.

## Select the entry point

- Rebuild page behavior in the owning view's test directory through the
  production Router. Match the BDD scenario to its current route, user,
  organization and capability. Exercise the same controls and navigation a
  user can reach.
- Use the documented production signal bootstrap only when no page-visible
  surface exists and the behavior requires real Platform bootstrap. Identify
  the concrete production caller, trigger and external result first. Bring
  an unclear boundary to the case review under its BDD ID.
- For a pure library or protocol contract, identify the owning public
  boundary before deciding its coverage. For behavior that needs private
  state controls or lacks a current entry, record the gap and the evidence
  for case review. See [cases without public construction](../../../docs/testing.md#cases-without-public-construction).

## Setup and readiness

1. Declare one file-scope testContext handle. Use its current signal and
   stores within each case. Helpers receive the context explicitly.
2. Before startup, install focused fixtures and external responses for the
   premise. Supply route and initial browser host through setupPage options.
   Model sign-out with an explicit null auth, and supply a typed auth
   fixture when role or organization affects the outcome. Feed feature
   switches through the authoritative response option.
3. Await setupPage with the intended route. Wait for the smallest observable
   state proving the first action is ready, such as an enabled named control
   in the relevant dialog. For tests that intentionally block startup, use
   startPage and await its content boundary. Verify readiness or cancellation
   separately when that is the contract.
4. Drive subsequent state changes through the page or the real external event
   boundary. A stateful API fixture should let a production write change the
   response to a later production read. Keep application commands and
   asynchronous ownership in the real runtime.

## Interact and observe

- Scope queries to the owning form, dialog, card or panel. Use accessible
  labels and the repository's queryAllByRoleFast for the name-heavy roles
  listed in the App guide. Prefer a single causal readiness check.
- Use the synchronous click helper for ordinary buttons and await fill for
  text. Await userEvent when the keyboard, focus, pointer, upload or other
  full interaction matters. Use fireEvent for a specific low-level browser
  event and act only for external events that bypass Testing Library and
  synchronously schedule React work.
- Perform the action once outside waitFor. Wait callbacks contain queries and
  assertions. For a failure or an absence, first observe the positive event
  proving the relevant action or transition completed.
- Assert the BDD result where a user or an external participant observes it.
  Use presence for ordinary rendered content, visibility for show/hide
  contracts, and explicit value, selection, enabled state, focus or
  destination assertions where material. Verify a request body or external
  side effect when it is itself part of the public contract. Keep checks
  focused on the scenario's outcomes, including meaningful parameter
  differences and negative guarantees.
- For an async recovery example, open the real route with a typed external
  failure, await the relevant enabled control, perform the action and observe
  the local error. Arrange the external retry outcome, click the real retry
  control, and observe recovery. Check the old error's absence after the
  success sentinel.

## External mock and lifetime boundaries

| Boundary                                                       | Pattern                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP                                                           | Use context.mocks.api with the typed contract and realistic response status and shape. Use context.mocks.http when there is no typed contract. Shared MSW fails unhandled requests.       |
| Realtime, popup, storage availability and browser capabilities | Use the owning context's external fixture API. Drive a faithful incoming event and observe its page effect.                                                                               |
| External SDK unavailable in Vitest                             | Use narrowly scoped SDK stubs permitted by the App guide. Keep Router, signals, stores, services and internal imports real.                                                               |
| Time and pending responses                                     | Use mockNow for wall time and mockMonotonicNow for duration deadlines. Bind overrides and deferred resources to the case's lifetime, keep real timers and wait for observable completion. |
| App or worker replacement                                      | Use a named child runtime when an independent app or worker domain matters. Document which worker survives and let the owning context clean up.                                           |

Keep fixtures case-local. Use shared testContext and Vitest lifecycle cleanup
for document, mocks and detached work. Keep setup and observation causal so a
specific regression would break the relevant assertion.

## Rebuild handoff

Read the adjacent BDD, this pattern, current production code and the active
testing guides. Use the frozen name and scenario ID for accounting. Keep
historical test bodies, deletion diffs and old logs with inventory verification.
Leave the 65 already flagged scenarios for the screening stage. Validate the
representative sample against the real route, action, outcome and mock
boundary before applying the pattern broadly. Remove this temporary guide
during final cleanup.

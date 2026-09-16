---
name: ccstate
description: Apply ccstate patterns for reactive values, commands, HTTP responses, and async or DOM ownership
---

# ccstate

Read the reference matching the changed behavior; API work does not require the
React/DOM reference unless it also changes that surface.

| Task                                                              | Reference                                   |
| ----------------------------------------------------------------- | ------------------------------------------- |
| `computed`, memoization, function-valued state, reactive fetches  | [Reactive values](references/reactivity.md) |
| API client status handling and `accept`                           | [HTTP](references/http.md)                  |
| AbortSignal ownership, cancellation, debouncing, detached cleanup | [Lifecycle](references/lifecycle.md)        |
| DOM callbacks, page signals, refs and ref cleanup                 | [React and DOM](references/react.md)        |
| Shared command logic and signal factories                         | [Commands](references/commands.md)          |

## Boundaries

- Keep derivation in `computed` and semantic actions in commands. Do not create
  signals or mutate the store during React render.
- Every async operation needs an owner and cancellation path. Await finite work
  or return its promise inside signals. Start background loops with `setLoop`
  or `setAbly*Loop$`; those primitives own `detach(..., Reason.Daemon)` internally.
  Use `waitLoopUntil` / `waitAbly*LoopUntil$` when subsequent work needs completion.
  Non-periodic background processes use `setDaemon(operation, signal)`.
  Other `detach()` calls belong at an actual outer boundary with their reason. Do not silence work with `void`.
- `resetSignal()` provides mutual exclusion. Add a parent when the work belongs
  to a page/route lifetime; parentless use still needs an explicit owner that
  cancels it. The lifecycle reference defines both valid patterns.
- Use `accept` with a non-empty status list for `apiClient$` calls. Preserve
  structured HTTP errors and use the view's loadable state for lifecycle UI.
- Route setup owns `pageSignal$`. Preserve stable callback refs and `onRef`
  cleanup returns.

See [effects](../../../docs/effect.md), [cache](../../../docs/cache.md), and
[Platform tests](../../../docs/testing/app-testing.md) for the relevant broader
contracts. For performance investigations, use
[React measurements](../../../docs/react-commit.md).

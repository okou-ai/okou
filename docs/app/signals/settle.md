# `settle` and `bestEffort`: let failures stop the operation

**Do not introduce new `settle` or `bestEffort` usages in Platform.**
`ccstate/no-settle` and `ccstate/no-best-effort` are errors and point to this
guide. Existing usages are frozen migration inventory, not an approved pattern
for new code.

Read [Platform ccstate](../platform-ccstate.md),
[request state versus business state](../../react.md#separate-loading-state-from-business-state),
and the related [onRejection](onRejection.md), [tapError](tapError.md), and
[withCleanup](withCleanup.md) guides.

## What the helpers do

The [implementation](../../../turbo/apps/platform/src/signals/utils.ts) awaits an
operation and converts its outcome:

- `settle` returns `{ ok: true, value }` or `{ ok: false, error }`. Cancellation
  still rejects, and a supplied signal is checked after the operation settles.
- `bestEffort` awaits an operation and discards every non-cancellation failure.

Both turn a rejection into an ordinary value. Code after the call then decides,
locally and without a shared boundary, what a failure means. That is where
duplicate request state, rollback, and silent fallbacks accumulate.

## Anti-patterns and correct alternatives

### Optimistic state repaired on failure

Do not hide or change state before a request and use `settle` to restore it
when the request fails. The repair is a second copy of the request lifecycle,
and it usually brings retry identities, "latest intent" markers, and a manual
saving flag with it.

```ts
// Wrong: optimistic removal, settled result, rollback, and manual reload.
set(optimistic$, [...get(optimistic$), item.id]);
const outcome = await settle(accept(client.feedback(request), [200], signal));
set(optimistic$, without(get(optimistic$), item.id));
if (!outcome.ok) {
  set(reload$);
  throw outcome.error;
}

// Prefer: the request fails normally; the view's loadable shows progress and
// failure; the list follows the server's change notification.
await accept(client.feedback(request), [200, 409], signal);
signal.throwIfAborted();
```

Subscribe the resource to the server's change topic with
`setAblyInvalidationLoop$` instead of calling a reload command after each
mutation.

### Branching a business flow on `ok`

`if (!result.ok) set(error$, …)` or `if (!result.ok) return fallback` hides the
failure from the common boundary and invents a local error model. Accept the
statuses that carry business meaning with `accept` and let other failures
propagate. Derive pending and failed UI from the invoking view's
`useLoadableSet`, or from `useLoadable` for an async computed resource.

### Swallowing failures with `bestEffort`

An ignored failure is still a failure. If an operation is genuinely optional,
it should not be awaited by the flow that depends on it; if the flow depends on
it, its failure must stop the flow.

## Narrow infrastructure boundaries

A few existing uses translate low-level protocol failures at a real boundary,
such as the shared-database Worker serializing an error for another tab or an
IndexedDB transaction being retried once on a fresh connection. They remain as
waived inventory. A new boundary of that kind needs an explicit design review,
not a copied waiver.

## ESLint: frozen legacy inventory, not an exception mechanism

The rules reject new runtime use, including aliases, namespace access,
re-exports, and value escapes. Existing references carry a next-line waiver:

```ts
// eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
```

The date is the inventory cutoff, not a review approval. Do not add new
waivers, copy one onto a new call, or move a legacy call to preserve the count.
When a legacy reference is removed, remove its waiver and unused import too. Do
not reproduce the same behavior with `onRejection`, `tapError`, raw
`try`/`catch`, or detached work.

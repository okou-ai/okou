# `onRejection`: boundaries, not business repair

Prefer ordinary awaited control flow. A rejected operation should stop the
business command, not trigger a second feature-specific recovery protocol.
`onRejection` is an exceptional infrastructure tool, not a standard wrapper for
commands.

## What the helper actually does

The [implementation](../../../turbo/apps/platform/src/signals/utils.ts) accepts a
Promise or an operation factory. On success it returns the value unchanged. On
rejection it awaits the error callback, then rethrows the original error.

- The callback runs for **all** rejections, including aborts and synchronous
  throws from a supplied factory. It does not filter cancellation.
- If the callback throws or returns a rejected Promise, **that error replaces
  the original error**, including an original abort. Slow callbacks also delay
  propagation.
- With a Promise argument, a synchronous throw while evaluating that argument
  happens before the helper is called; use a factory when that boundary matters.

Rethrowing does not make a callback harmless: it may already have changed state,
issued another request, duplicated a notification, or obscured the failure.

## Common misuses and better alternatives

### Repeating API error presentation

Use the typed client and `accept` with explicit accepted statuses and the owning
signal. Unexpected responses become `ApiError`; the common boundary owns error
presentation and the authenticated client owns sign-in recovery. Do not add a
second toast, catch-and-refresh flow, or replacement error around it.

```ts
// Wrong: duplicates the common API failure boundary.
await onRejection(
  accept(client.save({ body, fetchOptions: { signal } }), [200], signal),
  () => {
    toast.error("Save failed");
  },
);

// Prefer: only successful responses reach subsequent business work.
await accept(client.save({ body, fetchOptions: { signal } }), [200], signal);
set(invalidateSettings$);
```

A status with explicit business meaning can be accepted and interpreted, such as
`[200, 404]` for an optional resource. Do not catch arbitrary failures and turn
them into an empty result. See the [HTTP guide](../../../.claude/skills/ccstate/references/http.md).

### Repairing a second copy of request state

Manual `busy`, `callbackFailed`, requested-page sets, and rollback cursors often
exist only because code separately models the same request lifecycle. Remove
that duplicate model, not just the rejection callback.

```tsx
const [loadable, save] = useLoadableSet(saveSettings$);
return (
  <Button
    disabled={loadable.state === "loading"}
    onClick={() => detach(save(values, pageSignal), Reason.DomCallback)}
  >
    Save
  </Button>
);
```

Use `useLoadable` for an existing Promise-backed signal and `useLoadableSet` for
a command. Observe the **actual operation**, not an unrelated Promise that
resolves early. If multiple consumers must share one operation, expose that
same Promise through their owner rather than inventing parallel flags.

For pagination, commit the returned page and next cursor only after success;
a failed request then needs no cursor rollback. Give caches explicit retention,
invalidation, and retry semantics rather than depending on catch-time deletion
of a permanently rejected entry. Do not move the same repair logic into another
helper and call that a cleanup.

### Treating domain data as loading state

A product-visible phase (`authorized`, `denied`, `expired`) or identity-scoped
draft is not redundant just because it is mutable. Preserve meaningful domain
states, unsent input, local selections, and draft ownership. Define when a
successful operation commits or consumes them; do not clear or restore them
merely because a transport request failed. A draft must have an identity,
reconciliation rule, and release path independent of a loadable.

See [request state versus business state](../../react.md#separate-loading-state-from-business-state).

### Guessing server state after a failed request

A failed or cancelled response does not establish whether the server committed
the action. Do not set `callbackFailed`, synthesize a terminal domain result, or
launch a special recovery loop from a rejection callback.

Use the owner-scoped `setAbly*Loop$` primitives to invalidate/refetch authoritative
server state, including attachment/reconnection reconciliation. Keep mutation
request state in its Promise/loadable and server progress in the server model.
A background starter means **started**, not subscribed or loaded; use the
appropriate readiness callback or waiting entry point when subsequent work
requires it. Preserve the operation's retry and idempotency semantics.

### Depending on compensating cleanup

Do not require a failure callback to delete a partially created business record
or restore an optimistic marker before normal operation can continue. That
cleanup can fail too. Make ordinary reads and subsequent actions handle valid
partial data, or define an explicit domain reconciliation contract.

This is not permission to leak resources. Acquisition and teardown belong to
the same lifecycle: listeners, subscriptions, capture sessions, and browser
resources need an owner and cancellation/release path. Prefer the shared owner
or adapter over repeating cleanup in each consumer. See
[resource lifetimes](../../react.md#pair-acquisition-with-teardown).

## Narrowly justified uses

These responsibilities can justify a reviewed exception; their names alone do
not justify a new call:

- **Common telemetry or API boundaries:** record a transport/operation outcome
  centrally, without feature-local duplicate reporting. Account for cancellation
  and ensure reporting failures do not accidentally replace the primary error.
- **Resource acquisition cleanup:** release partially acquired resources when
  setup fails but successful setup transfers ownership. Prove what was acquired,
  who releases it on success and cancellation, and why the shared owner cannot
  already do it. Fail fast does not mean omit lifecycle teardown.
- **Bridging deferred errors:** reject a separate readiness/completion Promise
  when its producer fails, so consumers do not hang. Guard against double
  settlement, including cancellation. Prefer direct Promise composition when
  no independent bridge is needed.
- **Cancellation semantic translation:** distinguish caller cancellation from
  a subordinate provider's cancellation or deadline. Preserve the caller's abort
  first; translate only a proven lower-level condition. Deliberately throwing
  from the callback changes the error contract and must be reviewed as such.

## Lint policy and review

`ccstate/no-on-rejection` rejects `onRejection` references by default, not only
calls. It checks imported aliases, namespace access, and re-exports. Select other
helpers explicitly: opaque namespace escapes, rest copies, and dynamic keys can
hide the restricted helper and are rejected too. Preexisting references use a
next-line exemption with the migration date
and a concrete reason, for example:

```ts
// eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: propagate producer failure to the separate readiness promise; preserve cancellation and guard settlement.
await onRejection(start(signal), (error) => {
  if (!ready.settled()) ready.reject(error);
});
```

The date marks preexisting inventory; it does **not** endorse the historical
design. Future uses require narrowly justified review, not copying a legacy
exemption. Explain the owner, why ordinary awaiting/loadables/common lifecycle
handling cannot express the responsibility, behavior on abort, and whether a
callback failure may replace the original error.

Do not mechanically delete all references or replace them with `settle`,
`bestEffort`, an empty catch, or another wrapper. Those change failure semantics
rather than establish correct state ownership.

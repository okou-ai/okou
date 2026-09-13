# Async lifecycle and cancellation

[ccstate guide](../SKILL.md)

## AbortSignal Lifecycle and Ownership

**Every AbortSignal must have a clear owner that will abort it.** Orphaned signals cause polling loops that never stop and promises that leak past test boundaries.

### Signal hierarchy

```
rootSignal$ (app lifecycle)
  └── routeSignal (per-route, aborted on navigation)
      └── pageSignal$ (exposed to components)
          └── resetSignal() (per-operation, e.g. send/polling)
```

Do not use `createChildAbortController()` to create an imperative owner outside
this hierarchy. Existing calls are tracked with targeted
`ccstate/no-create-child-abort-controller` suppressions while they migrate.

### Two usage patterns of `resetSignal()`

`resetSignal()` creates an independent `AbortController` and aborts the previous one on each call. It has two normal usage patterns:

1. **With parent signal**: The signal is controlled by both the parent lifecycle and the next reset
2. **Without parent signal**: The signal is controlled only by the next reset (mutual exclusion) or explicit cancellation

**How `resetSignal` works:**

```typescript
// From utils.ts
return command(({ get, set }, ...signals: AbortSignal[]) => {
  get(controller$)?.abort(); // abort previous
  const controller = new AbortController();
  set(controller$, controller);
  return AbortSignal.any([controller.signal, ...signals]); // combine with parents
});
```

The core capability of `resetSignal` is **mutual exclusion**: each call aborts the previous signal. This naturally provides two abort paths:

- **Starting the next task** automatically cancels the previous one (mutual exclusion)
- **Calling without data** (i.e., not starting a new task) simply cancels the current one

#### Pattern 1: With parent signal — participating in lifecycle

When the operation needs to be aborted along with the page/route lifecycle, pass in a parent signal:

```typescript
// Signal aborts on any of: page navigation, next reset
const signal = set(resetSending$, pageSignal);
```

#### Pattern 2: Without parent signal — pure cancellation control

When the operation does not need to be tied to the page lifecycle and only needs mutual exclusion and explicit cancellation, omit the parent:

**Example 1: Cancel button for file upload** (`chat-draft.ts`)

```typescript
function createChatAttachment(file: File): ChatAttachment {
  const resetSignal$ = resetSignal();

  // Explicit cancel: no new task started, just abort the current upload
  const cancel$ = command(({ set }) => {
    set(resetSignal$);
  });

  // Mutual exclusion start: starting a new upload auto-cancels the previous, also binds to page lifecycle
  const upload$ = command(async ({ get, set }, signal: AbortSignal) => {
    const uploadSignal = set(resetSignal$, signal);
    // ... use uploadSignal for the upload ...
  });
}
```

`cancel$` omits the parent — its job is to abort the current upload when there is no next upload to start. `upload$` passes the parent because page unmount should also abort the upload.

The parent is omitted here because the send operation needs to survive page navigation — if bound to `pageSignal$`, the route change would abort the in-flight send request.

### Common mistake: floating polling loop

For **long-running operations** (like polling loops), a parent signal is required, otherwise the loop never stops (mutual exclusion only takes effect on the next call — if there is no next call, the loop leaks):

```typescript
// ❌ resumeSignal has no parent — loop runs forever if resetSending$ isn't called again
const resumeSignal = set(resetSending$);
set(startLoop$, { runId }, resumeSignal);

// ✅ Pass the page/route signal so loop stops on navigation
const resumeSignal = set(resetSending$, signal);
set(startLoop$, { runId }, resumeSignal);
```

## Debounced and Throttled Commands

Use the factories in `signals/command-scheduling.ts` for command scheduling:

```typescript
const debouncedSearch$ = debounceCommand(search$, 300);
const throttledCatchUp$ = throttleCommand(catchUp$, 1000);

// Source command arguments are preserved, with AbortSignal last.
const result = await set(debouncedSearch$, keyword, signal);
await set(throttledCatchUp$, signal);
```

- `debounceCommand` waits for the quiet interval, resets the wait on each call,
  and passes a cancellable child signal to the source command. Superseded calls
  reject with `AbortError`; a command already running must cooperate with its
  signal. Keep an existing domain `resetSignal()` when clear, send, or close
  actions also need to cancel work without scheduling a replacement.
- `throttleCommand` runs an idle call immediately, serializes executions, and
  keeps at least the specified interval between starts. Calls while busy share
  one trailing execution with the latest arguments. Further calls do not reset
  its deadline. All callers observe their execution's result or error.
- Scheduling state is private to each factory and each Store. Throttled calls
  that share a factory in a Store must use the same lifecycle signal. Create a
  fresh factory at the owning lifecycle boundary when that owner changes, as
  indicator catch-up does in its `rootVersion$`-dependent computed.
- Create wrappers at module scope or in a signal factory, never during React
  render or on every invocation. Return or await their Promises; only detach
  at the existing DOM boundary.

## Detach, Floating Promises, and Test Cleanup

In tests, do not manually `await clearAllDetached()` to make assertions pass.
`clearAllDetached()` belongs to teardown, where it prevents one test's detached
work from leaking into the next test. If a test is flaky while it is still
running, treat that as a floating-promise bug: find the missing `await`, parent
signal, or explicit domain-level test synchronization point instead of adding
waits, manual clears, or extra `detach()` calls.

### Never use `.catch(() => {})` to silence floating promises

**Enforced by ESLint rule: `ccstate/no-empty-promise-catch`**

`.catch(() => {})` technically satisfies `@typescript-eslint/no-floating-promises` (the promise is "handled"), but the empty handler means the promise is invisible to `clearAllDetached()` — it escapes test cleanup and can cause DOMException on teardown.

```typescript
// ❌ Silences lint but escapes cleanup — caught by no-empty-promise-catch
loadFile(file, signal).catch(() => {});
handleToggle(entry, enabled).catch(() => {});

// ✅ Properly tracked for cleanup
detach(loadFile(file, signal), Reason.DomCallback);
detach(handleToggle(entry, enabled), Reason.DomCallback);
```

If the promise has a `.then()` chain before it, wrap the entire chain:

```typescript
// ❌ Empty catch at the end
saveData(signal)
  .then(() => {
    toast.success("Saved");
  })
  .catch(() => {});

// ✅ Wrap entire chain in detach
detach(
  saveData(signal).then(() => {
    toast.success("Saved");
  }),
  Reason.DomCallback,
);
```

### Scope of `detach()` usage

**`detach()` should only appear in the views layer (React components), not in the signals directory.**

`detach` with `Reason.DomCallback` is designed for DOM event handlers — in React components, event callbacks cannot return a promise, so `detach` is needed to track the fire-and-forget promise.

In the signals layer, the caller can always `await` the return value or manage the lifecycle through the signal chain. If you find yourself needing `detach` in signals, it usually means the signal chain or command composition is flawed — fix the root cause instead of working around it with `detach`.

```typescript
// ✅ Views layer: use detach in DOM event callbacks
const handleClick = () => {
  detach(commandFn(pageSignal), Reason.DomCallback);
};

// ❌ Signals layer: detach should not appear here, use await or signal chain
export const someCommand$ = command(async ({ set }, signal) => {
  detach(set(anotherCommand$, signal), Reason.Daemon); // ← misuse
});

// ✅ Signals layer: correct approach is to await directly
export const someCommand$ = command(async ({ set }, signal) => {
  await set(anotherCommand$, signal);
});
```

### `detach()` tracks promises for cleanup

```typescript
detach(someAsyncWork(), Reason.DomCallback);
```

- `clearAllDetached()` in `afterEach` awaits all tracked promises
- Without `detach`, a fire-and-forget promise is a **floating promise** — invisible to cleanup

### Floating promises are dangerous

```typescript
// ❌ Floating promise — escapes all cleanup, causes DOMException on teardown
set(startLoop$, { runId }, signal).catch((e) => { ... });

// ✅ Tracked by detach in the views layer — clearAllDetached will await it
detach(set(startLoop$, { runId }, signal), Reason.Daemon);
```

But don't use `detach` to paper over orphaned signals. Fix the signal chain first.

### Test cleanup order matters

This hook exists once in shared test setup; do not copy it into test files.
`testContext` aborts the owning signal before the shared hook drains detached
work. `PromiseTracker` is private bookkeeping inside the existing helpers and
must not be exposed as a separate test API or duplicated in a test context.

```typescript
// ✅ Shared setup: testContext has already aborted the owning signal
afterEach(async () => {
  await clearAllDetached(); // 1. await detached work
  server.resetHandlers(); // 2. then remove mock handlers
});

// ❌ Wrong: promises try to fetch after handlers are gone → ECONNREFUSED / 401
afterEach(() => {
  server.resetHandlers(); // handlers gone
  // detached promises still running, hit real network
});
```

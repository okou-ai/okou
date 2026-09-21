# No Floating Promises

This document explains common patterns for handling async operations in the codebase, particularly when dealing with long-running loops like Ably subscriptions.

## The Problem

When starting async operations that run indefinitely (like event subscription loops), we need to handle their promises properly. The `@typescript-eslint/no-floating-promises` lint rule catches cases where promises are not awaited or handled.

## Wrong Patterns

### Pattern 1: Fire-and-forget with `void`

```typescript
// WRONG: Creates unhandled rejections when signal aborts
void set(setAblyLoop$, topic, callback$, signal);
```

This pattern:

- Silences the lint error but doesn't actually handle rejections
- When the signal aborts, the loop throws `AbortError`
- The rejection becomes an unhandled promise rejection
- Pollutes test output with "Unhandled Rejection" errors

### Pattern 2: Fire-and-forget with `.catch(throwIfNotAbort)`

```typescript
// WRONG: Still creates floating promises, swallows errors inconsistently
void set(setAblyLoop$, topic, callback$, signal).catch(throwIfNotAbort);
```

This pattern:

- Swallows `AbortError` but the promise is still "floating"
- The calling function loses track of the async operation
- Makes cleanup and error propagation unclear

### Pattern 3: `await` inside `Promise.all` array

```typescript
// WRONG: Sequential execution, not parallel
await Promise.all([
  set(loopA$, signal),
  await set(loopB$, signal), // BUG: await here blocks
  await set(loopC$, signal), // Never reached if loopB$ hangs
]);
```

This pattern:

- JavaScript evaluates array elements sequentially before passing to `Promise.all`
- The `await` inside the array causes loopB$ to block, loopC$ never starts
- If loopB$ never resolves, the function hangs

## Correct Pattern

### Use `await Promise.all([...])` without inner awaits

```typescript
// CORRECT: All loops start in parallel, rejections propagate to caller
await Promise.all([
  set(setAblyLoop$, topicA, callbackA$, signal),
  set(setAblyLoop$, topicB, callbackB$, signal),
  set(setAblyLoop$, topicC, callbackC$, signal),
]);
```

This pattern:

- All three loops start concurrently
- When the signal aborts, all loops throw `AbortError`
- `Promise.all` rejects with the first error
- The rejection propagates up to the caller
- The caller is responsible for handling the abort (usually via `signal.throwIfAborted()`)
- No floating promises, no unhandled rejections

### Why this works for infinite loops

For loops that run until abort (like Ably subscriptions):

1. `setAblyLoop$` enters an infinite `while (!signal.aborted)` loop
2. `Promise.all` waits for all three promises
3. When signal aborts, `signal.throwIfAborted()` inside each loop throws
4. All three promises reject with `AbortError`
5. `Promise.all` rejects, propagating the error to the caller
6. The caller's abort handling (or test cleanup) catches the error

### Example in context

```typescript
const loadPagedMessages$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const thread = await get(threadData$);
    signal.throwIfAborted();

    // ... setup callbacks ...

    // Start all subscription loops in parallel
    await Promise.all([
      set(
        setAblyLoop$,
        `chatThreadMessageCreated:${threadId}`,
        onMessageCreated$,
        signal,
      ),
      set(
        setAblyLoop$,
        `chatThreadDetailChanged:${thread.id}`,
        onThreadChanged$,
        signal,
      ),
      set(
        setAblyLoop$,
        `chatThreadArtifactsChanged:${thread.id}`,
        onArtifactsChanged$,
        signal,
      ),
    ]);

    // This line is only reached if all loops complete (return true)
    // or never reached if signal aborts (Promise.all rejects)
    signal.throwIfAborted();
  },
);
```

## Summary

| Pattern                              | Lint passes | Handles abort | Clean test output |
| ------------------------------------ | ----------- | ------------- | ----------------- |
| `void set(...)`                      | Yes         | No            | No                |
| `void set(...).catch(...)`           | Yes         | Partial       | No                |
| `await set(...)` inside array        | Yes         | No (hangs)    | N/A               |
| `await Promise.all([set(...), ...])` | Yes         | Yes           | Yes               |

Always use `await Promise.all([...])` for starting multiple long-running async operations.

## Testing Note

Do not manually `await clearAllDetached()` from inside a test body to make a
flaky assertion pass. Test setup files call it during teardown so detached work
from one test cannot leak into the next test. If a test is flaky before teardown,
look for the floating promise or missing domain-level synchronization instead
of adding waits, manual clears, or extra `detach()` calls.

## Fix Recipes

When `ccstate/no-void-statement` fires, pick the recipe that matches the call
site. The recipes below cover every case we have ever encountered.

### View — DOM callback firing an async command

```ts
// ❌ void silences lint, promise is untracked
const handleClick = () => {
  void updateParams(next);
};

// ❌ .catch(throwIfNotAbort) hides non-abort rejections from detach tracker
const handleClick = () => {
  updateParams(next).catch(throwIfNotAbort);
};

// ✅ detach() registers the promise for clearAllDetached() cleanup and logs
//    non-abort rejections
const handleClick = () => {
  detach(updateParams(next), Reason.DomCallback);
};
```

Chained `.then()` works the same — detach the whole chain:

```ts
// ❌
onDownload={() => {
  void fetchExtra(id, pageSignal).then(
    (extra) => { downloadJson(extra); },
  );
}}

// ✅
onDownload={() => {
  detach(
    fetchExtra(id, pageSignal).then((extra) => {
      downloadJson(extra);
    }),
    Reason.DomCallback,
  );
}}
```

### Signals — command that kicks off external async work

Prefer making the command `async`, accepting a signal, and letting the caller
await it. Reach for `detach()` only where the work genuinely outlives the call
and its owner is the signal you pass in:

```ts
// ❌ command fires and returns — promise is untracked, `subscribing$` state
//    may never reset on abort
export const ensurePushSubscription$ = command(({ get, set }) => {
  set(subscribing$, true);
  void doSubscribe(...)
    .then(() => set(subscribing$, false))
    .catch(() => set(subscribing$, false));
});

// ✅ async command with try/finally; view detaches at the call site
export const ensurePushSubscription$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(subscribing$, true);
    // eslint-disable-next-line no-restricted-syntax -- finally needed to reset `subscribing$` on success, failure, or abort
    try {
      await doSubscribe(...);
      signal.throwIfAborted();
    } finally {
      set(subscribing$, false);
    }
  },
);

// view
const ensurePushSubscription = useSet(ensurePushSubscription$);
const { signal: rootSignal } = useGet(rootSignal$);
// …
detach(ensurePushSubscription(rootSignal), Reason.DomCallback);
```

### Signals — command that must also kick off a daemon loop

If a command needs both "do the work" and "run a parallel loop for its
duration" (e.g. the app skeleton typewriter), run them with `Promise.all`
so the caller's signal owns both:

```ts
// ❌ floating daemon; the re-launch is invisible to the caller
export const showAppSkeleton$ = command(({ get, set }) => {
  set(internalVisible$, true);
  const { signal } = get(rootSignal$);
  void set(startSkeletonCycling$, signal).catch(throwIfNotAbort);
});

// ✅ split responsibilities: showAppSkeleton$ only flips state; the
//    caller (which already has a signal) runs the loop in parallel with
//    its own work via Promise.all
export const showAppSkeleton$ = command(({ set }) => {
  set(internalVisible$, true);
  set(skeletonFirstCycle$, true);
});

export const onboardingContinueWeb$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);
    await Promise.all([
      set(startSkeletonCycling$, signal),
      (async () => {
        const agentId = await set(completeOnboarding$, signal);
        // …
      })(),
    ]);
  },
);
```

### Signals — keyboard shortcut handler

`setupGlobalShortcut` wraps each handler with `onDomEventFn`, which
already calls `detach(..., Reason.DomCallback)` internally. Write the
handler as an `async` function and use `await`:

```ts
// ❌
y: () => {
  if (taskId) {
    void set(archiveAndFocusNext$, taskId, signal).catch(throwIfNotAbort);
  }
},

// ✅ onDomEventFn detaches the returned promise
y: async () => {
  if (taskId) {
    await set(archiveAndFocusNext$, taskId, signal);
  }
},
```

## Why not `.catch(throwIfNotAbort)`

`.catch(throwIfNotAbort)` handles the promise (so TypeScript's
`no-floating-promises` passes) but silently swallows `AbortError`
— the promise never feeds back into `clearAllDetached()`, so tests can
teardown before the in-flight work settles and surface
`Unhandled Rejection` or `DOMException` from happy-dom. Either `await` the
promise (propagating the abort) or `detach()` it (registering it with the
tracker). Never swallow rejections with a bare handler.

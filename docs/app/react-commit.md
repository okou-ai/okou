# React Commit Analysis

This guide describes how to measure excessive React work, identify the state
subscription that caused it, and reduce unnecessary work in the Okou platform.
The examples use `ccstate-react`, but the measurement method applies to any
React external store.

The linked historical traces record what was measured on a specific day.
Component, hook, and signal names inside them are the names that existed at the
time, and some have since been renamed or removed by the fixes described. Read them as evidence, not as a current symbol index.

## What to Measure

React performance investigations need three separate measurements:

1. **Commits**: how many times React applied a completed tree to a root.
2. **Component executions**: which component functions participated in each
   commit.
3. **Commit duration**: how much development-mode render time React attributed
   to the commits.

These measurements answer different questions. A commit can be valid because a
streaming message changed while still doing unnecessary work in the sidebar.
Conversely, a component function can execute without producing a DOM mutation.
Reducing component executions inside necessary commits is still a meaningful
optimization.

Do not use DOM mutation counts as a substitute for React commit counts, and do
not treat a component execution as proof that the browser painted.

## Establish a Reproducible Scenario

Before changing code:

1. Use a development build. Production timings and development timings are not
   directly comparable.
2. Open the same route with the same visible data and the same number of sidebar
   rows.
3. Let initial data, lazy modules, fonts, and suspense boundaries settle.
4. Enter the prompt before resetting the profiler. Typing is not part of the
   send-to-completion measurement.
5. Reset immediately before clicking Send.
6. Stop only after the run reaches a terminal state and the composer returns to
   its idle state.
7. Record the backend event count or stream update count alongside the React
   measurements.

Streaming runs are often nondeterministic. Queue time, polling, event batching,
and the number of streamed updates can change between runs. A result such as
`44 commits` versus `42 commits` is not meaningful if the two runs processed a
different number of events.

Prefer a fixed mocked event sequence. If that is unavailable, report normalized
metrics such as commits per event and component executions per event. Run the
scenario more than once and retain the raw results.

## Instrument React Commits

The React DevTools global hook can count root commits without adding permanent
profiling components to the application. Keep this instrumentation deliberately
small: the hook is reliable for root commit boundaries, but a traversal of
private Fiber fields is not a reliable component execution log.

Install the following script from the browser console after the page has
loaded:

```js
(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) throw new Error("React DevTools hook is unavailable");
  if (window.__okouReactCommitProfiler) return;

  const state = {
    profile: null,
  };
  const originalOnCommitFiberRoot = hook.onCommitFiberRoot;

  hook.onCommitFiberRoot = function onCommitFiberRoot(id, root) {
    const profile = state.profile;

    if (profile) {
      profile.commits += 1;
      const duration = root.current.actualDuration;
      if (typeof duration === "number" && Number.isFinite(duration)) {
        profile.duration += duration;
      }
      profile.timeline.push({
        atMs: performance.now() - profile.startedAt,
        duration,
      });
    }

    return originalOnCommitFiberRoot?.apply(this, arguments);
  };

  window.__okouReactCommitProfiler = {
    start() {
      state.profile = {
        startedAt: performance.now(),
        commits: 0,
        duration: 0,
        timeline: [],
      };
    },
    stop() {
      const result = state.profile;
      state.profile = null;
      return result;
    },
    uninstall() {
      hook.onCommitFiberRoot = originalOnCommitFiberRoot;
      delete window.__okouReactCommitProfiler;
    },
  };
})();
```

Start immediately before the measured action:

```js
window.__okouReactCommitProfiler.start();
```

After the run finishes, retain both the total and timeline:

```js
const result = window.__okouReactCommitProfiler.stop();
result;
```

Call `uninstall()` after the investigation so a later console session does not
stack another wrapper around the hook. `actualDuration` is a private React
field and development-only relative metric; revalidate the script after a
React upgrade.

### Use React Performance Tracks for Attribution

Capture the same bounded interaction with `agent-browser`:

```bash
agent-browser profiler start
# Perform the measured interaction in the browser.
agent-browser profiler stop tmp/chat-send.trace.json
```

The resulting file is a Chrome trace containing React Performance tracks, not
a raw V8 `.cpuprofile`. Load it in the Chrome Performance panel and inspect:

- `Update` and `Cascading Update` events in `Scheduler ⚛` for the component
  and hook that scheduled work;
- component spans in `Components ⚛` for changed props, referentially unequal
  closures, and deeply equal objects;
- the span duration for the expensive subtree, while remembering that parent
  and child durations are inclusive and must not be added together.

The repository's `analyze-react-renders.mjs` and
`analyze-call-frequency.mjs` scripts accept a raw V8 CPU profile. Do not pass
the Chrome trace container to those scripts. Capture a raw CPU profile or
extract its `Profile` and `ProfileChunk` events first when sampled JavaScript
stacks are needed.

## Avoid Fiber Counting False Positives

Do not infer component executions by traversing every Fiber after a root
commit. The following approaches all overcount in current React builds:

- Counting every fiber with the `PerformedWork` flag. Flags can remain visible
  on reused or bailed-out subtrees after a commit.
- Comparing `fiber.actualStartTime` directly with
  `fiber.alternate.actualStartTime`. React alternates between two fiber objects,
  so this can count historical work from the other buffer.
- Keeping a `WeakMap` of each Fiber's previous `actualStartTime`. React can
  retain or copy timing data while traversing an ancestor or bailed-out
  subtree, so a changed value is still not proof that the component function
  executed.

In one chat sample, the `WeakMap` technique reported 76 sidebar executions.
The React Performance track for the same trace showed no execution spans for
`SidebarLayout`, `Sidebar`, or `ChatThreadsContent`; the only visible
sidebar update initiator was one `ChatThreadItem`. Use the root hook for exact
commit boundaries and React Performance tracks or a deliberately placed React
`Profiler` for component attribution.

Also account for these sources of noise:

- React Strict Mode can intentionally invoke render logic more than once in
  development.
- Hot module replacement invalidates the current sample.
- Opening a popover, typing, scrolling, or changing focus adds unrelated work.
- Development-mode `actualDuration` is useful for relative comparisons only.
- A newly mounted component legitimately appears as work and should be
  separated from repeated updates.

## Divide the Page into Regions

Start with a small region table instead of inspecting hundreds of component
names:

| Region        | Representative components               | Expected updates during streaming                                              |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Sidebar       | `ChatThreadsContent`, `ChatThreadItem`  | Only thread metadata, unread, draft, active-run, route, or pane changes        |
| Message list  | `ChatThreadContent`, message group rows | New or changed message/run data and render-window changes                      |
| Composer      | `ChatThreadComposer`, composer controls | Input, send state, queue state, selected model, or relevant capability changes |
| Global layout | `Router`, `SidebarLayout`, providers    | Route, layout, auth, theme, or provider value changes                          |

For repeated components, record both the aggregate count and the visible item
count. If four sidebar rows each execute ten times, report 40 row executions,
not merely that `ChatThreadItem` appeared in ten commits.

## Trace the Trigger

For every unexpectedly active component, inventory these inputs:

1. `useGet`, `useLastResolved`, `useLoadable`, and `useLastLoadable`
   subscriptions.
2. React context values.
3. Props created by the parent.
4. Local state and reducer updates.
5. A changing `key`, which causes a remount instead of an update.

Then classify each subscribed value:

- primitive or reference;
- synchronous or Promise-backed;
- stable or newly allocated on recomputation;
- visually relevant or used only to derive a primitive;
- expected to change for every stream event or only for a specific domain
  event.

The important question is not merely "what changed?" It is "did the semantic
value used by this component change?"

## Preferred Fixes

Apply fixes in this order.

### 1. Subscribe to the Smallest Semantic Value

If rendering only needs a boolean or identifier, expose that primitive from the
signal factory:

```ts
const hasChatGroups$ = computed(async (get): Promise<boolean> => {
  return (await get(groupedChatMessages$)).length > 0;
});

const selectedModel$ = computed(async (get): Promise<string | null> => {
  return (await get(modelSelection$))?.selectedModel ?? null;
});
```

Primitives let `Object.is` suppress unchanged values cheaply. Do not subscribe
to an entire group list or model-selection object just to calculate one boolean
or string in React.

ccstate computed values already memoize their last result while dependencies
remain unchanged. Do not add a manual cache merely to duplicate that behavior.

### 2. Subscribe Only to Loadable State When Data Is Not Used

This pattern subscribes to every loadable object update:

```ts
const loadable = useLoadable(resource$);
const loading = loadable.state === "loading";
```

If the component only needs the lifecycle state, use the primitive hook:

```ts
const state = useLoadableState(resource$);
const loading = state === "loading";
```

Do not replace `useLastLoadable` mechanically. `useLastLoadable` intentionally
keeps the previous resolved value during refetch, whereas `useLoadableState`
returns `loading` for a replacement Promise. Confirm that the UI should expose
that transition before changing the hook.

### 3. Use Hook Equality for Equivalent Collections

`useGet`, `useLastResolved`, and `useLastLoadable` use `Object.is` by default.
When a computed produces a new array or set with the same semantic contents,
pass an explicit equality function at the React boundary:

```ts
const unreadIds = useLastResolved(unreadThreadIds$, {
  equalityFn: equalSets,
});

const groups = useLastLoadable(renderedGroups$, {
  equalityFn: equalArrays,
});
```

Keep collection comparators small and predictable:

```ts
export function equalArrays<T>(
  previous: readonly T[],
  next: readonly T[],
  equalItem: (previous: T, next: T) => boolean = Object.is,
): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((item, index) => equalItem(item, next[index]!)))
  );
}

export function equalSets<T>(
  previous: ReadonlySet<T>,
  next: ReadonlySet<T>,
): boolean {
  return (
    previous === next ||
    (previous.size === next.size &&
      Array.from(previous).every((item) => next.has(item)))
  );
}
```

For arrays of objects, use a domain comparator that includes every field that
can affect rendering or ordering. Equality is incorrect if it hides a visible
change. Avoid general recursive deep equality in a hot path unless measurement
shows that its comparison cost is lower than the work it prevents.

### 4. Separate Presence from Payload

A component often needs to know whether a payload exists before it needs the
payload itself. Expose both values:

```ts
const hasQueuedUserMessages$ = computed(async (get) => {
  return (await get(groupedChatMessages$)).some(hasQueuedUserMessage);
});

const queuedUserMessages$ = computed(async (get) => {
  return collectQueuedUserMessages(await get(groupedChatMessages$));
});
```

React hooks cannot be called conditionally. Select between the real signal and
a stable empty signal, then call the hook once:

```ts
const hasQueued = useLastResolved(thread.hasQueuedUserMessages$) ?? false;
const messages$ = hasQueued
  ? thread.queuedUserMessages$
  : thread.emptyQueuedUserMessages$;
const messages = useLastResolved(messages$, {
  equalityFn: equalArrays,
});
```

### 5. Remove Duplicate Subscriptions

Do not subscribe to both a source collection and a rendered projection unless
the component actually uses both semantic values. A composer that only needs
`hasMessages` should not subscribe to `groupedChatMessages$`. A message window
may legitimately need both the full group list and the rendered slice; use
equality to suppress equivalent arrays in that case.

### 6. Keep Subscriptions Close to Their Consumers

Avoid passing volatile computed collections through several component layers.
Subscribe in the component that uses the value. This reduces prop coupling and
makes the subscription visible at the render boundary.

Stable props and `React.memo` can prevent parent-driven executions, but they do
not stop updates caused by a component's own external-store subscription.
Narrow the subscription first; add memoization only when profiling still shows
parent-driven work.

### 7. Avoid No-op State Writes and Broad Invalidation

A realtime notification should not rewrite snapshots, event arrays, counters,
or derived state when no new remote data arrived. No-op writes can invalidate a
large computed graph even though the visible domain state is unchanged.

For event-sourced thread data:

- keep the in-memory snapshot and event array as the runtime source of truth;
- append only newly fetched events;
- replace the snapshot only when recovery actually fetched a new snapshot;
- let `threads$` derive from snapshot and events;
- do not add a `syncVersion` or reload counter solely to force replay.

### 8. Use Keys for Identity, Not Render Suppression

A correct key lets React preserve the identity of a row when list order changes.
It does not prevent rerenders. A key that changes unnecessarily forces an
unmount and remount, discards local state, and can increase memory churn.

Use stable domain identifiers such as `thread.id`. Never use a newly allocated
object or an array index when the item has a stable identifier.

## Validate the Fix

Use three validation layers:

1. **Hook integration tests**: wrap a consumer in React `Profiler` and assert
   that an equivalent value causes zero additional commits while a semantic
   change causes exactly one.
2. **Page tests**: exercise user-visible behavior through the normal platform
   page setup. Equality changes must not hide title, unread, running, queue, or
   message changes.
3. **Real-browser profiling**: repeat the fixed streaming scenario and compare
   region execution counts, commit counts, and duration.

Example `Profiler` assertion:

```tsx
const onRender = vi.fn();

render(
  <Profiler id="consumer" onRender={onRender}>
    <Consumer />
  </Profiler>,
);

onRender.mockClear();
store.set(ids$, new Set(["thread-1"]));
await Promise.resolve();
expect(onRender).not.toHaveBeenCalled();
```

Test a later semantic change as well. A test that only verifies suppression can
pass with an equality function that incorrectly returns `true` for everything.

## Memory Leaks Are a Separate Investigation

Low commit counts do not prove that thread switching is leak-free. A leaked
subscription can remain dormant and produce no commits until a later update.

For memory-leak analysis, repeatedly switch between the same threads and check:

- ccstate watcher/subscription counts return to a stable baseline;
- aborted page and thread signals release polling loops;
- detached promises finish during teardown;
- DOM node and fiber counts do not grow monotonically;
- heap snapshots do not retain old thread signal factories or message trees.

Treat commit profiling and heap/subscription profiling as complementary tools.

## Reporting Checklist

Every React performance report should include:

- route and user action;
- development or production build;
- visible row/message counts;
- warm-up and measurement boundaries;
- stream/event count and terminal state;
- total commits and cumulative duration;
- execution counts by page region;
- known sources of nondeterminism;
- before/after code revision;
- behavior tests and browser verification performed.

The goal is not zero commits. The goal is for every commit and every component
execution to correspond to a semantic value that the user can observe or that
the UI genuinely needs.

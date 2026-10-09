# React Development Guide

Write React components as pure projections of state, give effects and commands
explicit lifecycle owners, and measure unnecessary rendering before optimizing
it. This guide covers React and ccstate development in the Okou platform.

- [Effects and ownership](#effects-and-ownership): render purity, execution
  boundaries, semantic commands, cancellation, and signal lifetimes.
- [Cache and resource lifetimes](#cache-and-resource-lifetimes): retention bounds,
  state isolation, cleanup, and lifecycle review.
- [Performance measurement](#performance-measurement): reproducible profiling,
  subscription design, and behavior verification.

## Effects and Ownership

An effect is any process that changes state outside the current calculation,
performs I/O, acquires a resource, or depends on a lifecycle boundary.

The central rule is:

> Choose the owner and trigger before choosing the API.

React render, a DOM mount, a route, and a user action have different semantics.
Moving work from render into a ref or effect changes when it runs, but does not
necessarily give it the correct owner.

### Keep React Render Pure

A component render may:

- read props and ccstate values;
- calculate local values;
- create React elements;
- prepare callbacks that run later in response to an event.

A component render must not:

- execute a command or write to a Store;
- mutate `document`, `window`, or `globalThis`;
- schedule a timer, microtask, request, or polling loop;
- register a listener, observer, or subscription;
- call a signal factory or create `state`, `computed`, or `command` signals;
- create an external resource, editor, or object URL;
- synchronize props into another mutable source of truth.

React can restart, replay, or abandon render work. Anything performed during
render can escape without a corresponding commit or cleanup.

```tsx
// Wrong: this writes to the Store during render.
function AgentSettings({ source }: Props) {
  useSet(initSettingsForm$)(source);
  return <SettingsForm />;
}

// Correct: render reads the authoritative baseline plus an identity-scoped
// draft. User events update the draft through commands.
function AgentSettings({ signals }: Props) {
  const values = useGet(signals.values$);
  const update = useSet(signals.update$);
  return <SettingsForm values={values} onChange={update} />;
}
```

Lint is a safety net, not proof of purity. A helper can hide a DOM mutation,
and a stable ref can still attach the wrong business process to a DOM
lifecycle. Review the complete call path.

### Choose the Execution Boundary

Classify the work before implementing it.

#### Derived value: use `computed`

If a value is determined entirely by other state, derive it. Do not run a
command to keep two states synchronized.

```ts
const effectiveSettings$ = computed((get) => {
  const baseline = get(agentSettings$);
  const draft = get(agentSettingsDraft$);
  return applyDraft(baseline, draft);
});
```

Use `computed(async ...)` for data that should load when it is consumed. Use a
small command to invalidate it after a mutation. Do not copy the complete
response into a second mutable Store merely to model loading or refresh.

#### User or domain event: use a semantic `command`

A click, submit, retry, cancel, save, connect, or navigation is an explicit
event. Represent the complete business transition with one command and invoke
it from the event handler.

```tsx
function ConnectButton() {
  const pageSignal = useGet(pageSignal$);
  const connect = useSet(connectProvider$);

  return (
    <Button onClick={() => detach(connect(pageSignal), Reason.DomCallback)}>
      Connect
    </Button>
  );
}
```

The view forwards the event. It should not orchestrate a sequence of Store
writes or transport calls.

#### Route or page lifecycle: use a setup command

Work that belongs to a route or page starts in its setup command and receives
the route or page `AbortSignal`. This includes page subscriptions, route data
coordination, and long-running processes that must stop on navigation.

Do not attach route behavior to a child element merely because the element is
usually present. Conditional rendering, redirects, and layout changes can
prevent that ref from mounting or abort it too early.

#### DOM lifecycle: use `onRef`

Use `onRef` when the process genuinely requires a mounted DOM element or when
the acquired resource is owned by that element. Examples include:

- focus, selection, measurement, and scrolling;
- DOM event listeners;
- `IntersectionObserver` bound to an element;
- an editor, iframe, or browser resource whose lifetime matches the element.

The inner command receives the mounted element and an `AbortSignal` that is
aborted on detach. Acquire and release the resource in the same lifecycle.
Forward DOM events to a predeclared command:

```ts
const setRootRef$ = onRef(
  command(({ set }, root: HTMLElement, signal: AbortSignal) => {
    root.addEventListener(
      "scroll",
      onDomEventFn(() => set(recordScrollPosition$, root, signal)),
      { passive: true, signal },
    );
  }),
);
```

Mount ownership does not justify observing application-owned layout changes.
Follow the [ResizeObserver guide](app/resize-observer.md) to use CSS, stable
geometry, and deterministic command triggers.

Pass the stable `useSet` result directly to React so the cleanup return value is
preserved:

```tsx
const setRootRef = useSet(signals.setRootRef$);
return <aside ref={setRootRef} />;
```

Do not wrap it in an inline arrow, and do not use `onRef` merely because it
provides a mount signal. If the element parameter is unused, prove that the
behavior is still about the committed presence of that DOM subtree. Otherwise,
the DOM is only being used as a generic lifecycle trigger.

An inline callback ref changes identity on every render and can repeatedly
detach and attach. A wrapper can also discard the React-compatible cleanup
function returned by `onRef`. These transitions must not write state, navigate,
or acquire listeners, timers, observers, or subscriptions without matching
cleanup.

```ts
// Wrong: opening the dialog mounts a hidden trigger that starts a business
// flow. The DOM element is not part of the operation.
const autoStartRef$ = onRef(
  command(async ({ set }, _element: HTMLElement, signal: AbortSignal) => {
    await set(runAuthorizationFlow$, signal);
  }),
);
```

The authorization flow should instead start from the explicit connect command.
The dialog is a projection of that flow, not its trigger.

#### React effect: use only for component-owned external synchronization

An effect is appropriate only when React committing a component is the real
owner and none of the earlier boundaries express the work correctly. Typical
examples are component-local integration with a third-party imperative API or
a browser facility that is not tied to one ref.

Before adding an effect, verify that the work is not:

- derived state that belongs in `computed`;
- a business event that belongs in a command;
- route work that belongs in setup;
- a DOM resource that belongs in `onRef`;
- synchronization between duplicate mutable sources of truth.

An effect must have symmetric cleanup, and its dependency list must represent
the semantic identity of the external synchronization. Do not use an effect as
a generic response to state changes when a command can express the cause.

### Design Commands Around Business Semantics

#### Name the action, not the setter

Prefer commands such as `connectProvider$`, `saveAgentSettings$`,
`retryAuthorization$`, and `cancelUpload$`. Avoid exposing a series of
low-level setters that every view must call in the correct order.

One user action should normally invoke one semantic command. That command owns
the ordered state transition, I/O, invalidation, and success state.

#### Keep cause and effect together

Do not split one action across a command and a mount-driven continuation.

```text
Wrong
  click -> open dialog command -> dialog mounts -> ref starts authorization

Correct
  click -> connect command -> open dialog + start authorization
```

The correct form remains understandable when the dialog implementation,
conditional rendering, or layout changes.

```ts
const resetAuthorizationAttempt$ = resetSignal();

const connectProvider$ = command(async ({ set }, pageSignal: AbortSignal) => {
  set(openAuthorizationDialog$);
  const attemptSignal = set(resetAuthorizationAttempt$, pageSignal);
  await set(runAuthorizationFlow$, attemptSignal);
});

const closeAuthorizationDialog$ = command(({ set }) => {
  set(resetAuthorizationAttempt$);
  set(closeAuthorizationDialogState$);
});
```

#### Make cancellation explicit

Every async command must receive or create a signal with a clear owner:

- route/page work uses the route or page signal;
- a replaceable attempt combines its parent with `resetSignal()`;
- close or cancel commands abort the active attempt explicitly;
- polling and other long-running work must always have a parent lifecycle.

Starting a new attempt may cancel the previous attempt, but mutual exclusion is
not a substitute for an owner that eventually aborts the final attempt.

#### Compose commands through commands

Shared stateful logic belongs in a sub-command, not in a plain helper that
accepts or captures ccstate `get` or `set`. Await sub-commands and pass the
owner's `AbortSignal` through operations that support cancellation.

Background loops start through `setLoop` or `setAbly*Loop$`. These synchronous
starters detach their internal operation with `Reason.Daemon` and keep the
caller's signal as its owner. Their return means started, not attached, loaded,
or completed. Ably consumers that need attachment readiness use `onSubscribed`;
feature-specific failure handling uses `onError`.

Use `waitLoopUntil` or `waitAbly*LoopUntil$` when subsequent work depends on a
loop finishing. These return the internal promise and propagate cancellation
and failure. Both entry points share the same loop, retry, and cleanup logic.

Do not wrap the background starters in another detach. An explicitly
background, non-periodic process such as Desktop sign-in or realtime startup
calls `detach(operation(signal), Reason.Daemon, description)` with its owner
signal; keep ordinary finite command composition awaited. Other detached work
belongs at an actual outer boundary, such as a React DOM callback.

#### Separate loading state from business state

Use `useLoadable` or `useLoadableSet` for request lifecycle such as loading,
transport errors, and completion. Do not store request status or submitted
command arguments in a separate State when a loadable already represents the
same lifecycle. A value used only while the command's loadable is loading
duplicates that lifecycle even when it is not named `loading` or `pending`.

Keep explicit state only for domain phases that the product understands, such
as `pending`, `authorized`, `denied`, or `expired`, or for an identity-scoped
draft. A draft needs its own owner, identity, invalidation or reconciliation
rule, and release path; it must not depend on a separate loadable to acquire
meaning.

Do not replace a multi-stage domain state machine with `useLoadableSet`, and do
not maintain manual `loading` booleans when a loadable already represents the
same lifecycle.

### Own Signals Outside Render

Create signal groups at the narrowest lifecycle that owns their identity:

- application state at application scope;
- route state at route scope;
- thread state in a thread factory;
- dialog state in a dialog owner;
- editor resources in an editor session.

Pass the resulting signal interface to React. Creating it in component render
produces new atom identities, recomputes the graph, and replaces subscriptions
even when the domain identity has not changed. A package-scope `computed` may
select a factory result from a stable domain identity because ccstate memoizes
its last result until its dependencies change. Do not add an unbounded
package-level keyed cache to preserve that identity.

Thread, route, agent, dialog, connector, and editor-session state must not
default to a root Store or module singleton when simultaneous identities need
isolation or data should be released before application shutdown. Every scoped
state group needs:

- an explicit domain identity;
- isolation from simultaneous instances;
- an invalidation or replacement rule;
- a release path tied to its real owner.

A scoped draft must carry the identity it edits. Prefer an authoritative server
baseline plus an identity-scoped patch over copying the complete server object
into a second mutable Store. Derived values stay computed from the
authoritative source. React effects and ref callbacks must not become
synchronization bridges between two mutable state systems.

### Review Checklist

For each new effect or command, verify:

- Is render free of Store writes, I/O, resource allocation, and signal creation?
- What event starts this work: user action, route setup, DOM mount, or state
  derivation?
- Does the chosen API match that event and owner?
- If `onRef` is used, does the command actually depend on the element?
- Does one semantic command own the complete business transition?
- Does every async process have an `AbortSignal` with an eventual abort path?
- Are acquired listeners, observers, timers, URLs, and external objects released
  by the same owner?
- Is state derived instead of synchronized through a command, ref, or effect?
- Are signal factories created outside render and scoped to their domain
  identity?
- Would the behavior remain correct if React restarted render, remounted a ref,
  or changed which dialog subtree was mounted?

## Cache and Resource Lifetimes

Apply the [render-purity](#keep-react-render-pure),
[signal-ownership](#own-signals-outside-render), and
[request-state](#separate-loading-state-from-business-state) rules when reviewing
retention and cleanup. Do not classify a match from syntax alone. Trace the
component, signal definition, callers, owner, identity key, invalidation path,
and teardown path before deciding that it is a defect.

### Bound Cache Retention

Do not retain domain-scoped values in a package- or process-lifetime keyed cache
unless retention has a proven finite domain or hard capacity. The cache also
needs an explicit lifetime, invalidation, and release path. Review:

- module-level `Map`, `Set`, or `WeakMap` instances;
- function properties or factory closures that outlive the instance they create;
- `globalThis` registries;
- caches of `Computed`, Promise, DOM, editor, subscription, or resource objects;
- keys such as thread, agent, workflow, route, URL, or user identity that can grow
  throughout a session.

A `WeakMap` is not automatically safe: it only weakens its key. Keys that stay
reachable elsewhere still retain their entries, and cached values can retain
the rest of the object graph. Trace every strong path instead of inferring a
bound from the container type.

ccstate `computed` already memoizes its last result while dependencies remain
unchanged. Do not add a manual cache merely to duplicate that behavior.

### Share One State Transition Model

Do not maintain separate implementations of the same editor, draft, or state
machine for one product behavior. Parallel paths drift in keyboard shortcuts,
IME behavior, validation, submission, reset, and cleanup semantics even when
their visible UI starts out equivalent.

Shared behavior should have one lifecycle and one state transition model.
Presentation differences may adapt that model without duplicating it.

### Pair Acquisition with Teardown

Every acquired resource needs teardown owned by the same lifecycle. Verify the
pairing for:

- `addEventListener` / `removeEventListener`;
- timer creation / clearing;
- observer creation / `disconnect`;
- object URL creation / `revokeObjectURL`;
- editor or external object creation / `destroy`, `dispose`, or equivalent;
- subscription creation / unsubscribe;
- async work / abort and awaited completion.

Use stable [DOM refs](#dom-lifecycle-use-onref) that preserve cleanup, and give
long-running ccstate work an `AbortSignal` whose owner will abort it. A reset
signal used only for mutual exclusion is not enough for a polling loop that may
never be started again. Follow the [cancellation rules](#make-cancellation-explicit)
and do not use `detach()` to conceal a missing owner or abort path.

### Review Beyond Lint Coverage

Lint passing is not proof that render and lifecycle behavior is correct. Review
patterns that can hide an effect from a syntax-based rule, including:

- chained calls such as `useSet(command$)(...)`;
- render-time side effects hidden inside a helper;
- nested callbacks that a rule incorrectly treats as outside render;
- wrappers that discard the cleanup return from `onRef`;
- accessor aliases or closures that let ccstate `get` or `set` escape a command
  callback.

Treat a gap as both a code finding and a potential lint-rule coverage finding.
Do not weaken or suppress the rule.

### Avoiding False Positives

The following patterns are not defects by themselves:

- a stable callback ref returned by `useSet`;
- `onRef` paired with its provided `AbortSignal` and cleanup;
- a signal factory owned by a clear domain lifecycle with teardown;
- a product-visible domain phase or identity-scoped draft with explicit lifecycle
  and reconciliation;
- normal ccstate `computed` memoization;
- a cache with a proven finite domain or hard capacity plus explicit invalidation
  and release.

When the owner, bound, or teardown cannot be proved, record the item as needing
confirmation rather than asserting a leak.

### Review Evidence

Every confirmed finding should record:

- file and line;
- the shortest trigger path;
- the state or resource's real owner;
- the identity or key that controls retention;
- the missing or incorrect invalidation and teardown path;
- user or engineering impact;
- confidence and any evidence still missing.

Merge findings with the same root cause instead of reporting every call site
separately. Use [performance measurement](#performance-measurement) for render
cost and [heap and subscription profiling](#memory-leaks-are-a-separate-investigation)
for retention; one does not establish the other.

## Performance Measurement

Measure excessive React work, identify the state subscription that caused it,
and reduce unnecessary work without changing visible behavior. The examples
use `ccstate-react`, but the measurement method applies to any React external
store.

### What to Measure

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

### Establish a Reproducible Scenario

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

### Instrument React Commits

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

#### Use React Performance Tracks for Attribution

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

### Avoid Fiber Counting False Positives

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

Use the root hook for exact commit boundaries and React Performance tracks or
a deliberately placed React `Profiler` for component attribution.

Also account for these sources of noise:

- React Strict Mode can intentionally invoke render logic more than once in
  development.
- Hot module replacement invalidates the current sample.
- Opening a popover, typing, scrolling, or changing focus adds unrelated work.
- Development-mode `actualDuration` is useful for relative comparisons only.
- A newly mounted component legitimately appears as work and should be
  separated from repeated updates.

### Divide the Page into Regions

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

### Trace the Trigger

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

### Preferred Fixes

Apply fixes in this order.

#### 1. Subscribe to the Smallest Semantic Value

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

#### 2. Subscribe Only to Loadable State When Data Is Not Used

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

#### 3. Use Hook Equality for Equivalent Collections

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

#### 4. Separate Presence from Payload

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

#### 5. Remove Duplicate Subscriptions

Do not subscribe to both a source collection and a rendered projection unless
the component actually uses both semantic values. A composer that only needs
`hasMessages` should not subscribe to `groupedChatMessages$`. A message window
may legitimately need both the full group list and the rendered slice; use
equality to suppress equivalent arrays in that case.

#### 6. Keep Subscriptions Close to Their Consumers

Avoid passing volatile computed collections through several component layers.
Subscribe in the component that uses the value. This reduces prop coupling and
makes the subscription visible at the render boundary.

Stable props and `React.memo` can prevent parent-driven executions, but they do
not stop updates caused by a component's own external-store subscription.
Narrow the subscription first; add memoization only when profiling still shows
parent-driven work.

#### 7. Avoid No-op State Writes and Broad Invalidation

A realtime notification should not rewrite snapshots, event arrays, counters,
or derived state when no new remote data arrived. No-op writes can invalidate a
large computed graph even though the visible domain state is unchanged.

For event-sourced thread data:

- keep the in-memory snapshot and event array as the runtime source of truth;
- append only newly fetched events;
- replace the snapshot only when recovery actually fetched a new snapshot;
- let `threads$` derive from snapshot and events;
- do not add a `syncVersion` or reload counter solely to force replay.

#### 8. Use Keys for Identity, Not Render Suppression

A correct key lets React preserve the identity of a row when list order changes.
It does not prevent rerenders. A key that changes unnecessarily forces an
unmount and remount, discards local state, and can increase memory churn.

Use stable domain identifiers such as `thread.id`. Never use a newly allocated
object or an array index when the item has a stable identifier.

### Validate the Fix

Use two validation layers:

1. **Page tests**: exercise user-visible behavior through the normal platform
   page setup. Equality changes must not hide title, unread, running, queue, or
   message changes.
2. **Real-browser profiling**: repeat the fixed streaming scenario and compare
   region execution counts, commit counts, and duration.

### Memory Leaks Are a Separate Investigation

Low commit counts do not prove that thread switching is leak-free. A leaked
subscription can remain dormant and produce no commits until a later update.

For memory-leak analysis, repeatedly switch between the same threads and check:

- ccstate watcher/subscription counts return to a stable baseline;
- aborted page and thread signals release polling loops;
- detached promises finish during teardown;
- DOM node and fiber counts do not grow monotonically;
- heap snapshots do not retain old thread signal factories or message trees.

Treat commit profiling and heap/subscription profiling as complementary tools.

### Reporting Checklist

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

## Related Documentation

- [Platform ccstate](app/platform-ccstate.md) defines request, lifecycle,
  module-state, and import boundaries.
- [Platform testing](app/app-testing.md) defines page setup and user-visible
  assertions for behavior verification.
- [ccstate patterns and best practices](../.claude/skills/ccstate/SKILL.md)
  documents the concrete ccstate APIs and implementation patterns.

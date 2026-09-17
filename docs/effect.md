# React Effects and ccstate Commands

This guide defines where React and ccstate work should run in the Okou
platform. It covers effects in the broad sense: any process that changes state
outside the current calculation, performs I/O, acquires a resource, or depends
on a lifecycle boundary.

The central rule is:

> Choose the owner and trigger before choosing the API.

React render, a DOM mount, a route, and a user action have different semantics.
Moving work from render into a ref or effect changes when it runs, but does not
necessarily give it the correct owner.

## Keep React Render Pure

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
- create a signal factory, external resource, editor, or object URL;
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

## Choose the Execution Boundary

Classify the work before implementing it.

### Derived value: use `computed`

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

### User or domain event: use a semantic `command`

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

### Route or page lifecycle: use a setup command

Work that belongs to a route or page starts in its setup command and receives
the route or page `AbortSignal`. This includes page subscriptions, route data
coordination, and long-running processes that must stop on navigation.

Do not attach route behavior to a child element merely because the element is
usually present. Conditional rendering, redirects, and layout changes can
prevent that ref from mounting or abort it too early.

### DOM lifecycle: use `onRef`

Use `onRef` when the process genuinely requires a mounted DOM element or when
the acquired resource is owned by that element. Examples include:

- focus, selection, measurement, and scrolling;
- DOM event listeners;
- `ResizeObserver` or `IntersectionObserver` bound to an element;
- an editor, iframe, or browser resource whose lifetime matches the element.

The inner command receives the mounted element and an `AbortSignal` that is
aborted on detach. Acquire and release the resource in the same lifecycle.

```ts
const setRootRef$ = onRef(
  command((_ctx, root: HTMLElement, signal: AbortSignal) => {
    const observer = new ResizeObserver(() => {
      // Read or update state owned by this DOM resource.
    });

    observer.observe(root);
    signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    });
  }),
);
```

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

### React effect: use only for component-owned external synchronization

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

## Design Commands Around Business Semantics

### Name the action, not the setter

Prefer commands such as `connectProvider$`, `saveAgentSettings$`,
`retryAuthorization$`, and `cancelUpload$`. Avoid exposing a series of
low-level setters that every view must call in the correct order.

One user action should normally invoke one semantic command. That command owns
the ordered state transition, I/O, invalidation, and success state.

### Keep cause and effect together

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

### Make cancellation explicit

Every async command must receive or create a signal with a clear owner:

- route/page work uses the route or page signal;
- a replaceable attempt combines its parent with `resetSignal()`;
- close or cancel commands abort the active attempt explicitly;
- polling and other long-running work must always have a parent lifecycle.

Starting a new attempt may cancel the previous attempt, but mutual exclusion is
not a substitute for an owner that eventually aborts the final attempt.

### Compose commands through commands

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

Do not add `detach()` to feature commands or wrap the background starters in
another detach. `setDaemon(operation, signal)` is the shared primitive in
`signals/utils.ts` that owns daemon detachment. Use it for an explicitly
background, non-periodic process such as Desktop sign-in or realtime startup;
keep ordinary finite command composition awaited. Other detached work belongs
at an actual outer boundary, such as a React DOM callback.

### Separate loading state from business state

Use loadable state for request lifecycle such as loading and transport errors.
Keep explicit state only for domain phases that the product understands, such
as `pending`, `authorized`, `denied`, or `expired`.

Do not replace a multi-stage domain state machine with `useLoadableSet`, and do
not maintain manual `loading` booleans when a loadable already represents the
same lifecycle.

## Own Signals Outside Render

Create signal groups at the narrowest lifecycle that owns their identity:

- application state at application scope;
- route state at route scope;
- thread state in a thread factory;
- dialog state in a dialog owner;
- editor resources in an editor session.

Pass the resulting signal interface to React. Do not create it in a component
render, and do not use an unbounded package-level keyed cache to preserve its
identity. ccstate `computed` already memoizes its current result.

A scoped draft must carry the identity it edits. Prefer an authoritative server
baseline plus an identity-scoped patch over copying the complete server object
into a second mutable Store.

## Review Checklist

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

## Related Documentation

- [React and ccstate cache and lifecycle practices](./cache.md) defines the
  anti-patterns used during implementation and review.
- [React commit analysis](./react-commit.md) explains how to measure and
  attribute unnecessary React work.
- [ccstate patterns and best practices](../.claude/skills/ccstate/SKILL.md)
  documents the concrete ccstate APIs and implementation patterns.

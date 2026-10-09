# React and ccstate Cache and Lifecycle Practices

This document defines the React, ccstate, cache, and resource-lifecycle
anti-patterns to check during implementation and code review. It complements
the ccstate patterns in `.claude/skills/ccstate/SKILL.md` and the React
measurement guidance in `docs/app/react-commit.md`.

Do not classify a match from syntax alone. For each candidate, trace the
component, signal definition, callers, owner, identity key, invalidation path,
and teardown path before deciding that it is a defect.

## RC-1: Render-Phase Side Effects

React render must stay pure. A component must not execute commands, write to a
Store, mutate `document`, `window`, or `globalThis`, schedule timers or
microtasks, register events, or create external resources while rendering.

These effects can run again when React restarts, replays, or abandons work. Put
them behind an event, an effect with symmetric cleanup, or an owning signal
lifecycle instead.

## RC-2: Render-Time Signal Allocation

Do not call a signal factory or create a new `state`, `computed`, or `command`
from component render. Each render can then produce a new atom identity,
recompute the graph, and replace subscriptions even when the domain identity
did not change.

Create scoped signal groups at the lifecycle boundary that owns them. A
package-scope `computed` may select a factory result from a stable domain
identity because ccstate memoizes the result until its dependencies change.

## RC-3: Unbounded Lifetime Caches

Do not retain domain-scoped values in a package- or process-lifetime keyed
cache unless the domain is bounded and the cache has an explicit lifetime.
Suspicious storage includes:

- module-level `Map`, `Set`, or `WeakMap` instances;
- function properties or factory closures that outlive the instance they
  create;
- `globalThis` registries;
- caches of `Computed`, Promise, DOM, editor, subscription, or resource
  objects;
- keys such as thread, agent, workflow, route, URL, or user identity that can
  grow throughout a session.

A `WeakMap` is not automatically safe: it only weakens its key. Keys that stay
reachable elsewhere still retain their entries, and cached values can retain
the rest of the object graph. Trace every strong path instead of inferring a
bound from the container type.

ccstate `computed` already memoizes its last result while dependencies remain
unchanged. Do not add a manual cache merely to duplicate that behavior.

## RC-4: Owner and Lifetime Mismatch

State belongs to the narrowest lifecycle that owns it. Thread, route, agent,
dialog, connector, and editor-session state must not default to a root Store or
module singleton when multiple identities can exist or when the data should be
released before application shutdown.

Check that every scoped state group has:

- an explicit domain identity;
- isolation from simultaneous instances;
- an invalidation or replacement rule;
- a release path tied to its real owner.

## RC-5: Duplicate Mutable Sources of Truth

Do not copy a complete server object into a second mutable Store and then keep
both versions synchronized. Derived values should remain computed from the
authoritative source; genuinely local edits should be modeled as an explicitly
scoped draft.

A draft must carry the identity it edits, such as agent, thread, connector, or
editor session. React effects and ref callbacks must not become synchronization
bridges between two mutable state systems.

## RC-6: Parallel Editors, Drafts, or State Machines

Do not maintain separate implementations of the same editor, draft, or state
machine for one product behavior. Parallel paths drift in keyboard shortcuts,
IME behavior, validation, submission, reset, and cleanup semantics even when
their visible UI starts out equivalent.

Shared behavior should have one lifecycle and one state transition model.
Presentation differences may adapt that model without duplicating it.

## RC-7: Unstable Callback Refs and Lost Cleanup

An inline callback ref changes identity on every render, so React can detach
and attach it repeatedly. It is a defect when those transitions write state,
register listeners, start timers, attach observers or subscriptions, or
navigate without a matching cleanup path.

For ccstate DOM refs, use `onRef` and pass the stable `useSet(onRef(...))`
result directly:

```tsx
const setElement = useSet(setElement$);
return <div ref={setElement} />;
```

Do not wrap it in an inline arrow. The wrapper discards the React-compatible
cleanup function returned by `onRef`.

## RC-8: Asymmetric Resource Lifecycles

Every acquired resource needs teardown owned by the same lifecycle. Verify the
pairing for:

- `addEventListener` / `removeEventListener`;
- timer creation / clearing;
- observer creation / `disconnect`;
- object URL creation / `revokeObjectURL`;
- editor or external object creation / `destroy`, `dispose`, or equivalent;
- subscription creation / unsubscribe;
- async work / abort and awaited completion.

Long-running ccstate work must receive an `AbortSignal` whose owner will abort
it. A reset signal used only for mutual exclusion is not enough for a polling
loop that may never be started again. Do not use `detach()` to conceal a
missing owner or abort path.

## RC-9: Lint Coverage Gaps

Lint passing is not proof that render and lifecycle behavior is correct. Review
patterns that can hide an effect from a syntax-based rule, including:

- chained calls such as `useSet(command$)(...)`;
- render-time side effects hidden inside a helper;
- nested callbacks that a rule incorrectly treats as outside render;
- wrappers that discard the cleanup return from `onRef`;
- accessor aliases or closures that let ccstate `get` or `set` escape a
  command callback.

Treat a gap as both a code finding and a potential lint-rule coverage finding.
Do not weaken or suppress the rule.

## RC-10: Duplicate Request Lifecycle State

Do not store request status or submitted command arguments in a separate State
when a loadable already represents the same request lifecycle. A value used only
while the command's loadable is loading is a lifecycle sidecar even when it is
not named `loading` or `pending`.

Use `useLoadable` or `useLoadableSet` for loading, transport errors, and
completion. Keep explicit state only when the product understands it as a domain
phase or an identity-scoped draft. Such a draft needs an explicit owner,
identity, invalidation or reconciliation rule, and release path; it must not
depend on a separate loadable to acquire meaning.

## Avoiding False Positives

The following patterns are not defects by themselves:

- a stable callback ref returned by `useSet`;
- `onRef` paired with its provided `AbortSignal` and cleanup;
- a signal factory owned by a clear domain lifecycle with teardown;
- a product-visible domain phase or identity-scoped draft with explicit
  lifecycle and reconciliation;
- normal ccstate `computed` memoization;
- a cache with a proven finite domain or hard capacity plus explicit
  invalidation and release.

When the owner, bound, or teardown cannot be proved, record the item as needing
confirmation rather than asserting a leak.

## Review Evidence

Every confirmed finding should record:

- file and line;
- the shortest trigger path;
- the state or resource's real owner;
- the identity or key that controls retention;
- the missing or incorrect invalidation and teardown path;
- user or engineering impact;
- confidence and any evidence still missing.

Merge findings with the same root cause instead of reporting every call site
separately.

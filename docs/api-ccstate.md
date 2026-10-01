# API ccstate Design

This guide covers how API server code under `turbo/apps/api/src/signals/` should
build ccstate graphs. It records the rules applied in
[#37421](https://github.com/okou-ai/okou/issues/37421) /
[#37430](https://github.com/okou-ai/okou/pull/37430), where the chat pick, claim,
and enqueue path was rewritten from helper-driven orchestration into derived
graphs. That rewrite reduced the mutable state in `createClaimRunObjects` from
nine `state` atoms to three.

The general ccstate rules live in the [ccstate skill](../.claude/skills/ccstate/SKILL.md)
and its [command reference](../.claude/skills/ccstate/references/commands.md).
This document adds API-specific guidance for per-request and per-claim graphs.

The central rule is:

> Data is derived, writes are explicit, and the entry point owns the order.

Each node expresses one thing:

- `computed` describes **what the data is**, derived from its source.
- `command` performs **one write or one semantic action** and returns its
  result.
- The **entry point** (route handler, ingress processor, automation trigger)
  calls commands in order and owns background scheduling.

## Node Roles

| Node               | Use for                                                                  | Do not use for                                                 |
| ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Factory argument   | Plain values known when the graph is built (`claim`, `orgId`, thread id) | Values that must be queried first                              |
| `computed`         | Reads and anything derivable from other nodes                            | Results of writes; values set by a command before a read       |
| `command`          | One write or one action; returns its result; `signal` is the final arg   | Passing parameters into computeds; dispatching callbacks       |
| `state`            | Results of writes that later computeds read; revision counters           | Inputs, intermediate conclusions, early-exit results, timing   |
| `db$` / `writeDb$` | Database handles, read inside the node that needs them                   | Passing handles through state, factory arguments, or callbacks |

## Rules

### 1. Factories take plain values

A signal factory such as `createClaimRunObjects(claim)` receives a plain value
that is already decided. Nodes read it through the closure. Each claim builds a
fresh graph, so a value scoped to one claim needs no reset.

### 2. Do not use state to pass parameters to a computed

The pattern below hides the dependency in call order. It needs an "impossible"
null check, and a missing or repeated `set` silently reads the wrong data.

```ts
// Wrong: state as a parameter slot
const internalInput$ = state<RunAdmissionInput | null>(null);
const admission$ = computed((get) => {
  const input = get(internalInput$);
  if (!input) {
    throw new Error("requires a selected input");
  }
  // ...
});
const checkAdmission$ = command(async ({ set }, input, signal: AbortSignal) => {
  set(internalInput$, input);
  return await set(admission$, signal);
});
```

Derive the input from its source instead, or take it from the factory argument:

```ts
// Right: read the source once and derive everything else from it
export function createClaimRunObjects(claim: ThreadClaim) {
  const pickedEvent$ = computed(async (get) => {
    // Reads the full queue-head row once.
  });
  const head$ = computed(async (get) => {
    const picked = await get(pickedEvent$);
    // ...
  });
  const queuedModelInput$ = computed(async (get) => {
    const head = await get(head$);
    return { orgId: claim.orgId, userId: head.userId, eventId: head.id };
  });
  // ...
}
```

### 3. Express early exits as derived data

A command that writes a rejection into a state atom forces every downstream
node to check `if (get(early$))` and forces resets between runs. Derive the
conclusion instead, and return a discriminated union:

```ts
const earlyAssembly$ = computed(async (get): Promise<Assembly | null> => {
  const head = await get(head$);
  if (!head) {
    return { kind: "not-ready" };
  }
  const selected = await settle(
    Promise.all([get(queuedMessage$), get(agent$)]),
  );
  if (!selected.ok) {
    return preparationRejection(selected.error, head);
  }
  const [queued, agent] = selected.value;
  if (queued?.id !== head.id) {
    return { kind: "not-ready" };
  }
  return agent ? null : missingAgentRejection(head);
});
```

The final assembly returns `assembled`, `rejected`, or `not-ready`, and callers
branch on `kind`. Values generated once per graph, such as run and session ids,
are a `computed` inside the factory, not a state atom written by a command.

### 4. Read each source once

If several consumers need the same row, read it once in one `computed` and
derive the rest from it. In the claim graph, `pickedEvent$` reads the full
queue-head row, and the head context, model inputs, and integration context
lookups all derive from it. Do not let separate nodes query the same table for
overlapping columns.

### 5. Commands return their results

A command that returns `void` and reports its result through a callback, a
state atom, or a side channel is hard to compose. Return the result so that the
caller can decide what happens next. For example, `pickEnqueuedChatThread$`
returns the pick result.

### 6. Entry points own orchestration

A shared module must not take `touch`, `publish`, or `afterPick` callbacks,
call `waitUntil` itself, and merge errors with `AggregateError`. That inverts
ownership: the module ends up scheduling work for every integration, and the
order is hidden in the module.

The module exposes commands. Each entry writes the sequence linearly inside its
own `waitUntil`:

```ts
const picked = await settle(
  set(pickEnqueuedChatThread$, { orgId, chatThreadId }, signal),
);
signal.throwIfAborted();
await set(touchNativeChatThread$, { chatThreadId, createdAt, eventId }, signal);
await publishChatThreadMessageCreatedSafely({ userId, orgId, threadId });
const noticed = await settle(sendWaitNoticeIfNeeded(/* ... */));
```

Work that is independent of the sequence keeps its own `waitUntil`. On the
enqueue path, notifying a running run of pending input is one such task. When
you move orchestration into entries, check every entry for these independent
tasks; one was dropped and later restored during #37430.

### 7. Cancellation

- Pass `AbortSignal` as the final positional argument. Never put it in args
  objects, state, or factory arguments.
- After each await that does not take the signal, call `signal.throwIfAborted()`.
  When the signal aborts, the remaining steps are skipped. This is the intended
  abort semantics, not a bug to compensate for.
- A `computed` cannot capture a signal (`ccstate/no-computed-signal`). External
  reads started from a computed are owned by their own request timeout. If such
  a read must follow the caller's cancellation, move it into a command that
  receives the signal.

### 8. No fallbacks, retries, or swallowed errors

- Use `Promise.all` for parallel reads so that the first failure fails the step.
- Return business rejections explicitly as data. Do not use `try/catch` to
  continue, `?? default` for impossible states, or retry loops. See
  [Fallbacks](./fallback.md) and [Bad code smells](./bad-smell.md).
- Do not add row locks, advisory locks, `NOWAIT`, or `lock_timeout` to coordinate
  graph steps. See [advisory locks](./advisory-locks.md). Pick correctness on
  this path comes from the claim conditional update, lease, and fencing
  described in [chat run pick](./chat-run-pick.md).

### 9. No test hooks in production code

Production signals must not export `set…HookForTest` and `clear…HookForTest`
functions, `observe…` pause or count points, or fault injectors. #37430 deleted
`agent-run-preparation-hooks.ts` and
`prepared-launch-persistence-observer.service.ts` for this reason, together
with the model-route and connector-catalog read hooks.

Tests build scenarios through public APIs, run callbacks, `mockNow`, and test
environment configuration. A scenario that can only be reached through a hook
is deleted. The exception is a declared historical persisted-state case. See
[Testing](./testing.md) and
[external behavior testing](./testing/testing-external-behavior.md).

## Design Checklist

Answer these questions when you add or review an API ccstate node:

1. **Is the input known when the graph is built?** Make it a factory argument,
   or a command argument for a one-off action. If it has to be queried, make it
   a `computed`.
2. **Can the value be derived from existing data?** Use `computed`. Only the
   product of a write goes into `state`.
3. **Does this step write?** Use a `command` that returns its result.
4. **Who decides the order "A, then B"?** The entry point decides. The callee
   takes no callbacks and does not call `waitUntil`.
5. **Does a test need a change in production code?** If so, the design is
   wrong. Build the scenario through public interfaces, or delete the test.

## Allowed State

After #37430, `createClaimRunObjects` keeps exactly these atoms:

- `promptAllowanceWriteResult$` and `automationAllowanceWriteResult$`: results
  of the usage-allowance refresh command, read by later computeds.
- `internalTargetRevision$`: a revision counter that triggers recomputation.

When you need a new state atom, check that it is a write result or a revision.
Anything else should be a factory argument or a `computed`.

## Reference Implementation

- `turbo/apps/api/src/signals/services/claim-run-context.ts`: the claim graph
  (`createClaimRunObjects`), with derived head, model inputs, and early-exit
  assembly.
- `turbo/apps/api/src/signals/services/chat-thread-queue-drain.service.ts`:
  `pickEnqueuedChatThread$` and `enqueuedChatQueueWaitReason$`, with no
  callbacks.
- Ingress processors such as `canonical-slack-ingress-processor.service.ts`:
  linear post-pick orchestration owned by the entry.

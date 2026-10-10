# API ccstate Design

This guide covers how API server code under `turbo/apps/api/src/signals/` should
build ccstate graphs: derived reads, explicit writes, graph-local ownership,
and entry-owned orchestration.

The general ccstate rules live in the [ccstate skill](../../.claude/skills/ccstate/SKILL.md)
and its [command reference](../../.claude/skills/ccstate/references/commands.md).
This document adds API-specific guidance for per-request and per-claim graphs.
The database ownership, transaction, and signal-parameter restrictions below
are stricter than patterns permitted by the general command reference and
[database development guidance](../../.claude/skills/database-development/SKILL.md).
Apply these stricter API rules when building API graphs.

The central rule is:

> Data is derived, writes are explicit, and the entry point owns the order.

Side-effect-free reads and computations are written as `computed` wherever
possible; only operations with side effects belong in a `command` (Ethan,
2026-10-02). Side effects are database, Stripe and cache writes, OAuth refresh,
encryption followed by a write, Runner notification or publication, and run
commit and activation. Telemetry recording in a command's own timing stays with
that command.

Each node expresses one thing:

- `computed` describes **what the data is**, derived from its source.
- `command` performs **one write or one semantic action** and returns its
  result.
- The **entry point** (route handler, ingress processor, automation trigger)
  calls commands in order and owns background scheduling.

The target shape is:

1. Database handles are never passed as parameters, including inside args or
   runtime objects, or hidden behind callbacks and escaping closures.
2. Prefer one atomic SQL statement with a conditional `UPDATE ... WHERE`,
   `INSERT ... ON CONFLICT`, or a CTE, backed by the actual business unique key.
   Do not add new transactions except for necessary billing-related atomicity.
   Keep allowed billing transactions short and lightweight inside their owning
   command callbacks, with no `tx` escape.
3. Each file exposes a small public computed/command surface for business
   operations. Read-only computed dependencies may be passed to a computed
   factory when the owning graph connects them during graph construction.
   Keep command nodes, accessors and database handles out of parameters.

## Node Roles

| Node               | Use for                                                                                                         | Do not use for                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Factory argument   | Plain values known when the graph is built; read-only computed dependencies connected during graph construction | Database handles, command nodes, signals, or accessors                                |
| `computed`         | Reads and anything derivable from other nodes                                                                   | Results of writes; values set by a command before a read                              |
| `command`          | One write or one action; returns its result; `signal` is the final arg                                          | Passing parameters into computeds; dispatching callbacks                              |
| `state`            | Results of writes that later computeds read; revision counters                                                  | Inputs, intermediate conclusions, early-exit results, timing                          |
| `db$` / `writeDb$` | Database handles, read inside the node that needs them                                                          | Passing handles through parameters, args/runtime objects, state, or escaping closures |

## Rules

### 1. Factories take plain values or read-only computed dependencies

A signal factory such as `createThreadClaimRunObjects(claim)` receives a plain value
that is already decided. Nodes read it through the closure. Each claim builds a
fresh graph, so a value scoped to one claim needs no reset. A read-only factory
may instead receive a computed dependency for input that must be queried or
derived first; connect that dependency when constructing the owning graph.

**Narrow exception — `AgentRunContextSignals`:** the identity-grouped read-only
interface returned by `createAgentRunContextSignals(userId, orgId, agentId)` may
cross the enqueue, pick and Thread graph boundaries. It contains only the three
plain identity strings and async computed nodes. It must contain no command or
state and must perform no writes. Consumers read only the groups they need;
computed dependencies share the same identity-scoped sources. This interface exception
does not permit database handles, accessors, commands, mutable state or unrelated
graph interfaces across boundaries. Read-only computed factory inputs follow
the separate graph-construction allowance above.

**Picked-event context — `ThreadContext`:**
`createThreadContext(bootstrap, pickedEvent$)` builds the read-only computed
collection for one selected event. Bootstrap keeps identity-scoped reads;
ThreadContext owns thread/session facts, integration contexts, template selection
and model routing. The picked event carries the thread snapshot already read by
the request/pick path, so consumers do not issue another thread query. Identity
reconciliation reuses matching bootstrap groups. Admission, prompt composition
and Run preparation consume the same computed instances. This collection contains
no commands, state, database handles or storage materialization. Its constructor
and nested factories may read bootstrap's plain identity fields and otherwise
only declare computeds and verified computed bundles.

**Run material bundles:** Thread run preparation consumes final, persisted
material, not intermediate selection state. Each bundle is a read-only computed
factory over bootstrap, the picked event and ThreadContext. It returns one
computed with the exact data the Run stores, and it reports admission failures
through a typed error that the owning graph maps to a route result.

- `createPromptAndSkillVolumesSignals(...)` returns `PromptAndSkillVolumes`:
  `{ appendedSystemPrompt, userPrompt, skillVolumes }`.
- `createEnvironmentSignals(...)` returns `Environment`. It merges
  `createConnectorEnvironmentSignals(...)` and
  `createModelProviderEnvironmentSignals(...)` (and the Run body environment)
  in one place:

```ts
interface Environment {
  readonly vars: Record<string, string> | undefined;
  readonly environment: Record<string, string> | undefined; // env templates
  readonly secrets: Record<string, string> | undefined; // decrypted, keyed by env alias
  // Owner and storage source of each secret alias. Firewall auth uses it to
  // refresh an expired OAuth token for the exact connector account or personal
  // model-provider subscription; persisted as secretConnectorMap and
  // secretConnectorMetadataMap.
  readonly secretSources: Record<string, SecretSource>;
  readonly firewalls: ExecutionFirewalls | undefined;
  readonly networkPolicies: NetworkPolicies | undefined;
  // Connector and account behind each firewall; persisted as
  // connectorRuntimeTargets for network-policy refresh and runtime sync.
  readonly runtimeTargets: readonly ConnectorRuntimeTargetRegistration[];
  // Merge-only: aliases owned by custom connectors.
  readonly reservedSecretAliases: readonly string[];
}

function createEnvironmentSignals(bootstrap, pickedEvent$, threadContext) {
  const connector$ = createConnectorEnvironmentSignals(
    pickedEvent$,
    threadContext,
  );
  const modelProvider$ = createModelProviderEnvironmentSignals(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  return computed(async (get) => {
    const [connector, modelProvider] = await Promise.all([
      get(connector$),
      get(modelProvider$),
    ]);
    return mergeEnvironment(connector, modelProvider);
  });
}
```

Each source produces only its own contribution: the connector environment does
not include model-provider firewalls, and it decrypts every non-MCP connector
secret it needs instead of depending on later overrides. `mergeEnvironment` is
the single owner of precedence: body secrets override model-provider secrets,
which override connector secrets; an overridden alias drops its secret source;
custom-connector reserved aliases remove matching builtin and model-provider
sources. Values derivable at a consumer stay out of the bundle: Okou token
connector source ids come from `runtimeTargets`, and MCP status comes from the
connector catalog.

Build the owning graph before commands execute. Do not call `command()` inside
another command callback, including indirectly through a factory. Private nodes
share dependencies through the owning graph's lexical scope or explicitly
connected read-only computed factory inputs. Construct those factories with the
owning graph, not inside computed evaluation or command execution. Pass plain business values and
returned results across operation boundaries instead.

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
export function createThreadClaimRunObjects(claim: ThreadClaim) {
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
  reads started from a computed are owned by their own request timeout.
  Side-effect-free reads, including KMS decryption and an exact managed-key
  read, may run in a computed (Ethan, 2026-10-02); side effects such as OAuth
  refresh, encryption followed by a database write, Stripe or cache writes stay
  in commands. If such
  a read must follow the caller's cancellation, move it into a command that
  receives the signal.

### 8. No fallbacks, retries, or swallowed errors

- Use `Promise.all` for parallel reads so that the first failure fails the step.
- Return business rejections explicitly as data. Do not use `try/catch` to
  continue, `?? default` for impossible states, or retry loops. See
  [Fallbacks](../fallback.md) and [Bad code smells](../bad-smell.md).
- Do not add locks to order the steps of a graph. On the pick path,
  correctness comes from the actual claim predicate and existing ownership
  fences, not a second orchestration lock. Follow
  [database concurrency rules](database.md#concurrency-and-coordination) for retained invariants. Do not
  hide unresolved ordering with `NOWAIT`, lock retry loops, or larger timeouts.

### 9. No test hooks in production code

Production signals must not export `set…HookForTest` and `clear…HookForTest`
functions, `observe…` pause or count points, or fault injectors. #37430 deleted
`agent-run-preparation-hooks.ts` and
`prepared-launch-persistence-observer.service.ts` for this reason, together
with the model-route and connector-catalog read hooks.

Tests build scenarios through public APIs, run callbacks, `mockNow`, and test
environment configuration. A scenario that can only be reached through a hook
is deleted, including fabricated historical state. See
[Testing](../testing.md) and
[external behavior testing](../testing.md#external-behavior).

### 10. Keep database handles local and prefer atomic SQL

Outside `signals/external/db.ts`, no function or method accepts a `Db`,
`ReadonlyDb`, `Tx`, `WriteTx`, `DbTransaction`, or equivalent database handle.
This includes narrowed handles such as `Pick<Db, "select">`, handles in args or
runtime objects, handles copied into state, and callbacks or returned closures
that hide access to them. Reads obtain `get(db$)` inside their node; writes obtain
`set(writeDb$)` inside their command.

[Database transaction lint](database.md#transaction-lint) enforces the default
prohibition and deletion-only legacy inventory. A legacy ID is not approval to
expand a transaction; new necessary billing exceptions still require review.

Follow the [database transaction boundaries](database.md#transaction-boundaries):
no new non-billing transactions; necessary billing atomicity requires a concrete
financial invariant and an insufficient single-statement alternative. Keep any
necessary transaction inside one owning command, with inline SQL and no external
I/O. Pure shared builders return values or SQL fragments, not query executors.
The database guide owns the full policy, recovery contracts, and verification
requirements; reading this summary does not replace it.

### 11. Keep a small public surface and a closed internal graph

Export only the computeds and commands that callers need for business operations.
Keep intermediate reads, preparation steps, and state private. A factory's
returned interface is also a public surface: do not expose every internal node
through a large signal bundle, re-exports, or spreads.

Read-only computed nodes may be explicit inputs to a computed factory. The
owning graph must create and connect the factory before evaluation; do not
create another computed graph while evaluating one. The receiving computed reads
its dependencies with `get` and obtains its own database dependency through
`get(db$)`. This allowance does not permit command-node parameters, escaping
getters/setters, database handles hidden in nodes, or mutable state slots used to
supply request inputs. Ordinary ccstate
`get(node$)` and `set(command$, args, signal)` calls inside an owning node are not
node injection into a domain helper and remain the way to read or invoke nodes.

Keep a shared reactive dependency in its owning graph and derive private nodes
there. At an operation boundary, return plain captured facts or a prepared plan
and pass those values to a stable, named command. Do not move inputs into state
slots, rebuild graphs during command execution, or repeat source queries merely
to avoid passing nodes. Preserve the single-read and lifecycle ownership rules.

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
6. **Does a database handle, command node or accessor cross a parameter boundary?**
   Remove it, including object-wrapped and callback forms. Obtain handles inside
   nodes. Read-only computed factory inputs are allowed only when connected
   during owning-graph construction, without hiding handles or rebuilding graphs.
7. **Can one conditional statement or business-key upsert preserve the write?**
   Prefer it, including for billing. Do not add a non-billing transaction. For a
   necessary billing transaction, document its financial invariant, snapshot,
   or local setting and why a simpler atomic SQL operation is insufficient.
   Keep all its SQL inside one command's transaction callback.
8. **Does the public surface expose implementation steps?** Keep them private;
   export only the necessary business queries and commands.

## Allowed State

A state atom stores a write result consumed by later computeds or a revision
that invalidates derived reads. Request inputs, intermediate conclusions, and
early-exit results belong in factory arguments or computeds, not mutable slots.
The owning graph and its tests define its actual nodes; do not duplicate a
business graph's symbol inventory in this standard.

## Reference Implementation

These references illustrate derived reads, limited state, and entry-owned
orchestration from #37430. They are not proof that the referenced files already
meet every target rule above. In particular, remaining database-handle passing,
node-valued parameters, or command construction during execution are migration
work, not patterns to copy. Transaction and handle cleanup is tracked in
[#37513](https://github.com/okou-ai/okou/issues/37513).

- `turbo/apps/api/src/signals/services/thread-claim-run.service.ts`: the claim
  graph (`createThreadClaimRunObjects`), with derived head, model inputs, model
  resolution and early-exit assembly.
- `turbo/apps/api/src/signals/services/chat-thread-queue-drain.service.ts`:
  `pickEnqueuedChatThread$` and `enqueuedChatQueueWaitReason$`, with no
  callbacks.
- Ingress processors such as `canonical-slack-ingress-processor.service.ts`:
  linear post-pick orchestration owned by the entry.

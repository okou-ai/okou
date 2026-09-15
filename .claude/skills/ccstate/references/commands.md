# Command composition and signal factories

[ccstate guide](../SKILL.md)

## Construct the command graph before commands run

Define commands at package scope or while constructing an owning signal
factory. Never call `command()` from inside another command callback. A command
created at runtime only gets a fresh identity around the callback closure; it
does not gain ccstate state, memoization, lifecycle, or isolation.

Pass runtime values as positional sub-command arguments instead. When the value
must remain reactive or outlive one invocation, represent it as explicit
ccstate state owned by the surrounding signal graph. A signal factory may
construct commands for a genuinely separate graph instance, but the owning
code must instantiate that factory outside command execution: at package
scope, inside another factory, or inside a `computed` that derives the
instance from its domain identity. A graph built in a `computed` cannot
capture an `AbortSignal`, so let its owner install one with `resetSignal()`
after construction.

`ccstate/no-command-in-command` enforces this boundary.

## Extracting Shared Logic from Commands

When two or more commands share duplicated logic, extract it into a **sub-command** (`command()`), not a plain function that receives `get`/`set`.

### Why not a plain function?

A plain helper that accepts `get` or `set` as parameters breaks the ccstate contract — `get`/`set` are scoped to the command callback and should not leak out. The ESLint rule `ccstate/...` flags this. More importantly, a plain function cannot participate in the signal/reactive graph.

### Pattern: Extract a sub-command

```typescript
// ❌ Plain function receiving get — breaks ccstate contract
async function sendRequest(
  get: Getter,
  agentId: string,
  prompt: string,
): Promise<Result> {
  const client = get(apiClient$)(contract);
  return await client.send({ body: { agentId, prompt } });
}

// ✅ Sub-command — get/set stay inside the command callback
const sendRequest$ = command(
  async ({ get }, agentId: string, prompt: string): Promise<Result> => {
    const client = get(apiClient$)(contract);
    return await client.send({ body: { agentId, prompt } });
  },
);

// Caller
const doSomething$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await set(sendRequest$, agentId, prompt);
  signal.throwIfAborted();
  // ...
});
```

### Handling AbortSignal in sub-commands

**Pass `signal` explicitly and use `fetchOptions: { signal }` for HTTP calls.** This ensures the request is cancelled when the caller's signal aborts.

Keep `AbortSignal` out of args objects, options objects, and React props. For
repository-owned functions, pass it as the final positional parameter. React
components should read the lifecycle signal from its owning ccstate signal
(for example, `useGet(pageSignal$)`) instead of receiving it as a prop. Object
members remain appropriate only at fixed boundaries such as `fetchOptions` or
third-party SDK request options.

```typescript
const sendRequest$ = command(
  async (
    { get },
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Result> => {
    const client = get(apiClient$)(contract);
    const result = await accept(
      client.send({
        body: { agentId, prompt },
        fetchOptions: { signal },
      }),
      [201],
    );
    return result.body;
  },
);
```

The caller passes its own signal through:

```typescript
const parentCommand$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await set(sendRequest$, agentId, prompt, signal);
  // No need for signal.throwIfAborted() here — if signal was aborted,
  // the fetch inside sendRequest$ already threw an AbortError.
  // Only add throwIfAborted() after operations that DON'T accept a signal.
});
```

### Do not wrap accessors in domain closures

Wrapping `get`/`set` in helper-specific closures is the same contract break as
passing them directly. Avoid `getFlow`/`setFlow`-style arguments, args-object
properties such as `{ setFlow: set }`, and shorthand objects such as `{ set }`.

Prefer one of these patterns:

- Pass atoms (`State`, `Computed`, `Command`) into a sub-command and read/write
  them inside that command.
- Use a signal factory when two feature variants need isolated state but shared
  command logic.

The device-auth signals are the worked example: the Codex and Claude Code flows
instantiate one factory per org/personal variant, while API calls live in
module-scope sub-commands. `ccstate/no-getter-setter-params` catches explicit
`Getter`/`Setter` helper parameters, and `ccstate/no-accessor-escape` catches
call sites that pass, store, alias, return, or object-wrap callback accessors.

### When to use `signal.throwIfAborted()`

Use it **after any `await` that does NOT accept a signal** — i.e., after operations that will complete even if the caller wants to abort:

```typescript
const example$ = command(async ({ get, set }, signal: AbortSignal) => {
  // ✅ fetch accepts signal → no throwIfAborted needed after
  const result = await set(sendRequest$, data, signal);

  // ✅ get() on a computed is synchronous-ish but doesn't accept signal
  const thread = await get(currentThread$);
  signal.throwIfAborted(); // ← needed: get() doesn't know about our signal

  // ✅ set() on a sub-command that passes signal through → no throwIfAborted needed
  await set(anotherCommand$, thread.id, signal);
});
```

**Rule of thumb:** If the awaited operation receives your signal, it will throw on abort itself. If it doesn't, check manually after.

## Signal Factory Pattern

Refactored the signal handling to avoid global singletons when multiple signals exist within a single page.

In previous requirements, we only needed a single chat session per page, so we used global singleton signals. This was not an issue at the time.

However, as we refactor the code to support multiple chat sessions within a single page, we must implement the Signal Factory pattern to prevent global singleton conflicts.

Each factory call returns fresh `state()`/`computed()`/`command()` instances, so multiple instances can coexist without sharing state.

### Module-level singletons

```typescript
// chat-message.ts
const internalLocalMessages$ = state<ChatEvent[]>([]);
export const resetLocalMessages$ = command(({ set }) => {
  set(internalLocalMessages$, []);
});
export const messages$ = computed(async (get) => {
  /* ... */
});
export const allFinished$ = computed(async (get) => {
  /* ... */
});
export const sendMessage$ = command(async ({ get, set }, prompt, signal) => {
  /* ... */
});

// chat-auto-scroll.ts
import { onRef } from "../utils.ts";

const chatScrollContainer$ = state<HTMLElement | null>(null);
export const setChatScrollContainer$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(chatScrollContainer$, null);
    });
    set(chatScrollContainer$, el);
  }),
);
export const autoScroll$ = command(({ get }) => {
  /* ... */
});
```

```typescript
// View imports singletons directly — can't have two threads on screen
import {
  messages$,
  sendMessage$,
} from "../../signals/chat-page/chat-message.ts";
import { setChatScrollContainer$ } from "../../signals/chat-page/chat-auto-scroll.ts";

export function ChatPage() {
  const msgs = useLastLoadable(messages$);
  // ...
}
```

### Factory function returning a signals interface

The Signals Factory allows a single page to contain multiple sets of Signals.

While this approach is more complex than using a singleton, it provides a viable solution for managing multiple distinct page instances within a single view.

**Step 1 — Define the interface and factory:**

```typescript
// create-chat-thread.ts
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef } from "../utils.ts";

export interface ChatThreadSignals {
  messages$: Computed<Promise<ChatEvent[]>>;
  allFinished$: Computed<Promise<boolean>>;
  sendMessage$: Command<Promise<void>, [string, AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  draft: DraftSignals;
}
```

**Step 2 — Break into sub-factories for each concern:**

```typescript
function createMessageState(threadData$: Computed<Promise<ThreadData | null>>) {
  const internalLocalMessages$ = state<ChatEvent[]>([]);

  const messages$ = computed(async (get) => {
    const serverMsgs = (await get(threadData$))?.chatMessages ?? [];
    const localMsgs = get(internalLocalMessages$);
    return [...transformServerMessages(serverMsgs), ...localMsgs];
  });

  const allFinished$ = computed(async (get) => {
    /* ... */
  });

  return {
    internalLocalMessages$,
    messages$,
    allFinished$,
  };
}

function createScrollSignals() {
  const container$ = state<HTMLElement | null>(null);

  const setScrollContainer$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(container$, null);
      });
      set(container$, el);
    }),
  );

  return { setScrollContainer$ };
}
```

**Step 3 — Compose sub-factories in the main factory:**

```typescript
export function createChatThreadSignals(
  threadId: string,
  existingDraft?: DraftSignals,
): ChatThreadSignals {
  const { threadData$, reloadThread$ } = createThreadData(threadId);
  const { internalLocalMessages$, messages$, allFinished$ } =
    createMessageState(threadData$);
  const { setScrollContainer$ } = createScrollSignals();
  const draft = existingDraft ?? createDraftSignals();

  const { sendMessage$ } = createMessageCommands({
    threadId,
    threadData$,
    reloadThread$,
    internalLocalMessages$,
    draft,
  });

  return {
    messages$,
    allFinished$,
    sendMessage$,
    setScrollContainer$,
    draft,
  };
}
```

**Step 4 — Derive from route via package-scope computed, pass as prop:**

```typescript
// create-chat-thread.ts
export const currentChatThreadSignals$ = computed(
  (get): ChatThreadSignals | null => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) return null;
    return createChatThreadSignals(threadId);
  },
);

// chat-page-setup.ts
export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = get(currentChatThreadId$);
    const thread = get(currentChatThreadSignals$)!;

    set(updatePage$, createElement(ChatThreadPage, { key: threadId, thread }));
    // ...
    await set(thread.loadMessages$, signal);
  },
);
```

No manual cache needed — ccstate `computed` memoizes the last result. As long as `currentChatThreadId$` hasn't changed, the same `ChatThreadSignals` object is returned without re-creation.

**Step 5 — Components consume via props:**

```typescript
export function ChatThreadPage({ thread }: { thread: ChatThreadSignals }) {
  const messagesLoadable = useLastLoadable(thread.messages$);
  const setScrollContainer = useSet(thread.setScrollContainer$);
  // ... pass thread down to children ...
}
```

### Key rules

1. **Interface first** — define a `Signals` interface listing only the public signals. Keep internal `state()` atoms private to the factory.
2. **Sub-factories for each concern** — split message state, scroll, draft, commands, etc. into separate functions. The main factory composes them.
3. **Dependencies via parameters** — sub-factories receive the signals they depend on as arguments, not module-level imports.
4. **Pass as React props** — the factory result is a plain object, so pass it as a prop. Use `useGet(thread.someSignal$)` / `useSet(thread.someCommand$)` in components.
5. **`key` prop for remount** — when creating the component element, use `key: threadId` so React remounts when the thread changes, avoiding stale hook state.
6. **Allow dependency injection** — accept optional existing signal groups (e.g., `existingDraft?: DraftSignals`) so the caller can share state across factories when needed.
7. **Helpers that were only used by singletons can be inlined** — if a hook or utility existed only to wrap singleton signals (e.g., `useFileUploadHandlers`), inline its logic directly into the component once signals are injected via props.

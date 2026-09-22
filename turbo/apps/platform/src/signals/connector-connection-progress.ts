import { command, computed, state, type Command } from "ccstate";
import {
  onRef,
  resetKeyedSignal,
  waitForOperation,
  withCleanup,
} from "./utils.ts";

const defaultConnectionKey = Symbol("default connector connection");
type ConnectionKey = string | typeof defaultConnectionKey;

interface ConnectionCancellation {
  readonly signal: AbortSignal;
}

interface ConnectionProgressAttempt {
  readonly id: symbol;
  readonly cancellation: ConnectionCancellation | null;
  readonly invocations: ReadonlyMap<symbol, AbortSignal>;
  readonly completed: boolean;
  readonly showDialog: boolean;
  readonly dismissed: boolean;
}

interface ConnectionProgressInvocation {
  readonly key: ConnectionKey;
  readonly attemptId: symbol;
  readonly id: symbol;
  readonly signal: AbortSignal;
}

const connectionAttempts$ = state<
  ReadonlyMap<ConnectionKey, ConnectionProgressAttempt>
>(new Map());
const connectionDialogs$ = state(0);
const resetConnectionSignal$ = resetKeyedSignal<symbol>();

const selectedConnectionAttempt$ = computed((get) => {
  const attempts = get(connectionAttempts$);
  const legacy = attempts.get(defaultConnectionKey);
  if (legacy?.cancellation) {
    return legacy;
  }
  return (
    [...attempts.values()].find((attempt) => {
      return attempt.cancellation !== null;
    }) ?? null
  );
});

/** Legacy controls continue to own the default connection group. */
export const connectorConnectionAttempt$ = computed((get) => {
  return get(selectedConnectionAttempt$)?.id ?? null;
});

export const connectorConnectionAttempts$ = computed(
  (get): readonly symbol[] => {
    return [...get(connectionAttempts$).values()].flatMap((attempt) => {
      return attempt.cancellation ? [attempt.id] : [];
    });
  },
);

export const connectorConnectionAttemptForKey$ = computed((get) => {
  const attempts = get(connectionAttempts$);
  return (key: string): symbol | null => {
    const attempt = attempts.get(key);
    return attempt?.cancellation ? attempt.id : null;
  };
});

export const connectorConnectionCompleted$ = computed((get) => {
  return get(selectedConnectionAttempt$)?.completed ?? false;
});

export const markConnectorConnectionCompleted$ = command(
  ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const attempts = get(connectionAttempts$);
    for (const [key, attempt] of attempts) {
      if ([...attempt.invocations.values()].includes(signal)) {
        const next = new Map(attempts);
        next.set(key, { ...attempt, completed: true });
        set(connectionAttempts$, next);
        return;
      }
    }
  },
);

/** Cancel only the attempt that the displayed control belongs to. */
export const cancelConnectorConnection$ = command(
  ({ get, set }, attemptId: symbol | null) => {
    if (attemptId === null) {
      return;
    }
    for (const attempt of get(connectionAttempts$).values()) {
      if (attempt.id === attemptId && attempt.cancellation) {
        set(resetConnectionSignal$, attempt.id);
        return;
      }
    }
  },
);

export const connectorConnectionPending$ = computed((get) => {
  return get(connectionAttempts$).size > 0;
});

const displayedConnectionAttempt$ = computed((get) => {
  return (
    [...get(connectionAttempts$).values()].find((attempt) => {
      return attempt.showDialog && !attempt.dismissed;
    }) ?? null
  );
});

/** The shared progress dialog cancels the specific attempt it presents. */
export const connectorConnectionProgressAttempt$ = computed((get) => {
  const attempt = get(displayedConnectionAttempt$);
  return attempt?.cancellation ? attempt.id : null;
});

export const connectorConnectionProgressActive$ = computed((get) => {
  return get(displayedConnectionAttempt$) !== null;
});

export const connectorConnectionProgressVisible$ = computed((get) => {
  return (
    get(connectorConnectionProgressActive$) && get(connectionDialogs$) === 0
  );
});

export const dismissConnectorConnectionProgress$ = command(
  ({ get, set }, attemptId?: symbol | null) => {
    const id =
      attemptId === undefined
        ? get(displayedConnectionAttempt$)?.id
        : attemptId;
    const attempts = get(connectionAttempts$);
    for (const [key, attempt] of attempts) {
      if (attempt.id === id) {
        const next = new Map(attempts);
        next.set(key, { ...attempt, dismissed: true });
        set(connectionAttempts$, next);
        return;
      }
    }
  },
);

/** Existing connection dialogs own their feedback until they unmount. */
export const registerConnectorConnectionDialog$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    set(connectionDialogs$, (count) => {
      return count + 1;
    });
    signal.addEventListener(
      "abort",
      () => {
        set(connectionDialogs$, (count) => {
          return count - 1;
        });
      },
      { once: true },
    );
  }),
);

const beginConnectorConnectionProgress$ = command(
  (
    { get, set },
    options: {
      readonly key: ConnectionKey;
      readonly showDialog: boolean;
      readonly cancellable: boolean;
    },
    signal: AbortSignal,
  ): ConnectionProgressInvocation => {
    signal.throwIfAborted();
    const attempts = get(connectionAttempts$);
    const existing = attempts.get(options.key);
    const attemptId = existing?.id ?? Symbol();
    let cancellation = existing?.cancellation ?? null;
    if (!cancellation && options.cancellable) {
      cancellation = {
        signal: set(resetConnectionSignal$, attemptId, signal),
      };
    }
    const attemptSignal = cancellation
      ? AbortSignal.any([signal, cancellation.signal])
      : signal;
    const invocation = Symbol();
    const invocations = new Map(existing?.invocations);
    invocations.set(invocation, attemptSignal);
    const attempt: ConnectionProgressAttempt = {
      id: attemptId,
      cancellation,
      invocations,
      completed: existing?.completed ?? false,
      showDialog: options.showDialog || (existing?.showDialog ?? false),
      dismissed: existing?.dismissed ?? false,
    };
    const next = new Map(attempts);
    next.set(options.key, attempt);
    set(connectionAttempts$, next);
    return {
      key: options.key,
      attemptId: attempt.id,
      id: invocation,
      signal: attemptSignal,
    };
  },
);

const releaseConnectorConnectionProgress$ = command(
  ({ get, set }, invocation: ConnectionProgressInvocation) => {
    const attempts = get(connectionAttempts$);
    const current = attempts.get(invocation.key);
    if (
      current?.id !== invocation.attemptId ||
      !current.invocations.has(invocation.id)
    ) {
      return;
    }
    const invocations = new Map(current.invocations);
    invocations.delete(invocation.id);
    const next = new Map(attempts);
    if (invocations.size > 0) {
      next.set(invocation.key, { ...current, invocations });
    } else {
      next.delete(invocation.key);
    }
    set(connectionAttempts$, next);
    if (invocations.size === 0 && current.cancellation) {
      set(resetConnectionSignal$, current.id);
    }
  },
);

/** Keep feedback visible through nested commands sharing one connection key. */
export function withConnectorConnectionProgress<T, Args extends unknown[]>(
  source$: Command<Promise<T>, [...Args, AbortSignal]>,
  {
    showDialog = false,
    cancellable = true,
    getConnectionKey,
  }: {
    readonly showDialog?: boolean;
    readonly cancellable?: boolean;
    readonly getConnectionKey?: (...args: [...Args, AbortSignal]) => string;
  } = {},
): Command<Promise<T>, [...Args, AbortSignal]> {
  const tracked$ = command(
    async (
      { set },
      args: [...Args, AbortSignal],
      signal: AbortSignal,
    ): Promise<T> => {
      const invocation = set(
        beginConnectorConnectionProgress$,
        {
          key: getConnectionKey?.(...args) ?? defaultConnectionKey,
          showDialog,
          cancellable,
        },
        signal,
      );
      const attemptArgs: [...Args, AbortSignal] = [...args];
      attemptArgs[attemptArgs.length - 1] = invocation.signal;
      const release = () => {
        set(releaseConnectorConnectionProgress$, invocation);
      };
      invocation.signal.addEventListener("abort", release, { once: true });
      return await withCleanup(
        (async () => {
          // Invoke synchronously so window.open retains the click's user activation.
          return await waitForOperation(
            set(source$, ...attemptArgs),
            invocation.signal,
          );
        })(),
        () => {
          invocation.signal.removeEventListener("abort", release);
          release();
        },
      );
    },
  );

  return command(({ set }, ...args: [...Args, AbortSignal]) => {
    // TypeScript cannot address the last element of a generic variadic tuple.
    const signal = args[args.length - 1] as AbortSignal;
    return set(tracked$, args, signal);
  });
}

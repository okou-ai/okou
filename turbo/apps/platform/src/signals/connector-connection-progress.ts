import { command, computed, state, type Command } from "ccstate";
import { onRef, resetSignal, withCleanup } from "./utils.ts";

/**
 * Null reserves ownership only during synchronous source invocation, before its
 * actual Promise exists. It is never substituted with a feedback Promise.
 */
const connectionOperations$ = state<
  ReadonlyMap<symbol, Promise<unknown> | null>
>(new Map());

/**
 * Every join/leave invalidates this observation, including late participants.
 * Callers own the results; one rejection must not hide other pending work.
 */
export const connectorConnectionOperations$ = computed((get) => {
  const operations = [...get(connectionOperations$).values()].filter(
    (operation): operation is Promise<unknown> => {
      return operation !== null;
    },
  );
  return Promise.allSettled(operations);
});
const progressDismissed$ = state(false);
const progressDialogRequested$ = state(false);
const connectionDialogs$ = state(0);
const internalConnectionCompleted$ = state(false);
const resetConnectionSignal$ = resetSignal();
const activeConnection$ = state<{
  readonly id: symbol;
  readonly signal: AbortSignal;
} | null>(null);

export const connectorConnectionAttempt$ = computed((get) => {
  return get(activeConnection$)?.id ?? null;
});

export const connectorConnectionCompleted$ = computed((get) => {
  return get(connectorConnectionPending$) && get(internalConnectionCompleted$);
});

export const markConnectorConnectionCompleted$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(internalConnectionCompleted$, true);
  },
);

/** Cancel only the attempt that the displayed control belongs to. */
export const cancelConnectorConnection$ = command(
  ({ get, set }, attemptId: symbol | null) => {
    if (attemptId !== null && get(activeConnection$)?.id === attemptId) {
      set(resetConnectionSignal$);
    }
  },
);

export const connectorConnectionPending$ = computed((get) => {
  return get(connectionOperations$).size > 0;
});

export const connectorConnectionProgressActive$ = computed((get) => {
  return (
    get(connectorConnectionPending$) &&
    get(progressDialogRequested$) &&
    !get(progressDismissed$)
  );
});

export const connectorConnectionProgressVisible$ = computed((get) => {
  return (
    get(connectorConnectionProgressActive$) && get(connectionDialogs$) === 0
  );
});

export const dismissConnectorConnectionProgress$ = command(({ set }) => {
  set(progressDismissed$, true);
});

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

/** Keep feedback visible through nested connection commands and continuations. */
export function withConnectorConnectionProgress<T, Args extends unknown[]>(
  source$: Command<Promise<T>, [...Args, AbortSignal]>,
  {
    showDialog = false,
    cancellable = true,
  }: {
    readonly showDialog?: boolean;
    readonly cancellable?: boolean;
  } = {},
): Command<Promise<T>, [...Args, AbortSignal]> {
  const tracked$ = command(
    async (
      { get, set },
      args: [...Args, AbortSignal],
      signal: AbortSignal,
    ): Promise<T> => {
      signal.throwIfAborted();
      if (!get(connectorConnectionPending$)) {
        set(internalConnectionCompleted$, false);
        if (cancellable) {
          set(activeConnection$, {
            id: Symbol(),
            signal: set(resetConnectionSignal$, signal),
          });
        }
        set(progressDismissed$, false);
        // Most entry points already show connecting feedback. Only callers
        // without visible feedback opt in to the shared dialog.
        set(progressDialogRequested$, showDialog);
      }
      const connection = get(activeConnection$);
      if (showDialog) {
        set(progressDialogRequested$, true);
      }
      if (cancellable && !connection) {
        throw new Error("Pending connector connection has no owner");
      }
      // Preserve any narrower owner (for example device-code polling) while
      // allowing the user to cancel the complete, nested connection attempt.
      const attemptSignal = connection
        ? AbortSignal.any([signal, connection.signal])
        : signal;
      const attemptArgs: [...Args, AbortSignal] = [...args];
      attemptArgs[attemptArgs.length - 1] = attemptSignal;
      const invocation = Symbol();
      set(connectionOperations$, (operations) => {
        return new Map([...operations, [invocation, null]]);
      });
      const release = () => {
        set(connectionOperations$, (operations) => {
          if (!operations.has(invocation)) {
            return operations;
          }
          const remaining = new Map(operations);
          remaining.delete(invocation);
          return remaining;
        });
        if (
          connection !== null &&
          get(connectionOperations$).size === 0 &&
          get(activeConnection$) === connection
        ) {
          set(activeConnection$, null);
          set(resetConnectionSignal$);
        }
      };
      attemptSignal.addEventListener("abort", release, { once: true });

      return await withCleanup(
        (async () => {
          // Invoke synchronously so window.open retains the click's user activation.
          const operation = set(source$, ...attemptArgs);
          // Synchronous source cancellation may already have released it.
          if (!attemptSignal.aborted) {
            set(connectionOperations$, (operations) => {
              return new Map([...operations, [invocation, operation]]);
            });
          }
          return await operation;
        })(),
        () => {
          attemptSignal.removeEventListener("abort", release);
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

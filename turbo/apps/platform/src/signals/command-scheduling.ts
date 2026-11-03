import { command, state, type Command } from "ccstate";
import { delay } from "signal-timers";
import { now } from "../lib/time.ts";
import {
  createDeferredPromise,
  onRejection,
  resetSignal,
  settle,
  withCleanup,
} from "./utils.ts";

function commandSignal(
  args: readonly [...unknown[], AbortSignal],
): AbortSignal {
  // TypeScript cannot address the last element of a generic variadic tuple.
  return args[args.length - 1] as AbortSignal;
}

/**
 * Wait for a quiet interval before invoking the command with its latest args.
 * A new call cancels the previous delay and cooperatively cancels active work.
 * Superseded calls reject with AbortError; the latest call returns its result.
 * The final argument is the caller's lifecycle signal, as on the source command.
 */
export function debounceCommand<T, Args extends unknown[]>(
  command$: Command<T, [...Args, AbortSignal]>,
  intervalMs: number,
): Command<Promise<Awaited<T>>, [...Args, AbortSignal]> {
  const reset$ = resetSignal();

  const runDebounced$ = command(
    async (
      { set },
      args: [...Args, AbortSignal],
      parentSignal: AbortSignal,
    ): Promise<Awaited<T>> => {
      parentSignal.throwIfAborted();
      const signal = set(reset$, parentSignal);
      await delay(intervalMs, { signal });
      const invocationArgs: [...Args, AbortSignal] = [...args];
      invocationArgs[invocationArgs.length - 1] = signal;
      const result = await set(command$, ...invocationArgs);
      signal.throwIfAborted();
      return result;
    },
  );

  return command(({ set }, ...args: [...Args, AbortSignal]) => {
    return set(runDebounced$, args, commandSignal(args));
  });
}

type Completion<T> = ReturnType<typeof createDeferredPromise<T>>;

/**
 * Serialize command executions with a minimum interval between their starts.
 * An idle call starts immediately. Further calls share one trailing execution,
 * which uses the latest args without extending the interval. Every caller can
 * await its execution's result or error. Calls in one Store share scheduling
 * state and must pass the same lifecycle signal; independent lifecycles use
 * separate factory instances. Different Stores always have independent state.
 */
export function throttleCommand<T, Args extends unknown[]>(
  command$: Command<T, [...Args, AbortSignal]>,
  intervalMs: number,
): Command<Promise<Awaited<T>>, [...Args, AbortSignal]> {
  const lastStartedAt$ = state<number | null>(null);
  const active$ = state<Completion<Awaited<T>> | null>(null);
  const trailing$ = state<{
    readonly completion: Completion<Awaited<T>>;
    readonly args: [...Args, AbortSignal];
  } | null>(null);

  const executeScheduled$ = command(
    async (
      { get, set },
      completion: Completion<Awaited<T>>,
      args: [...Args, AbortSignal],
      previous: Promise<Awaited<T>> | null,
      signal: AbortSignal,
    ): Promise<Awaited<T>> => {
      signal.throwIfAborted();
      if (previous) {
        // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
        await settle(previous, signal);
      }
      const lastStartedAt = get(lastStartedAt$);
      const remaining =
        lastStartedAt === null
          ? 0
          : Math.max(0, lastStartedAt + intervalMs - now());
      if (remaining > 0) {
        await delay(remaining, { signal });
      }
      signal.throwIfAborted();

      const trailing = get(trailing$);
      const invocationArgs =
        trailing?.completion === completion ? trailing.args : args;
      if (trailing?.completion === completion) {
        set(trailing$, null);
      }
      set(active$, completion);
      set(lastStartedAt$, now());
      return await set(command$, ...invocationArgs);
    },
  );

  const runScheduled$ = command(
    async (
      { get, set },
      completion: Completion<Awaited<T>>,
      args: [...Args, AbortSignal],
      previous: Promise<Awaited<T>> | null,
      signal: AbortSignal,
    ): Promise<Awaited<T>> => {
      // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: propagate execution failure to the shared completion.
      const result = await onRejection(
        // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
        withCleanup(
          set(executeScheduled$, completion, args, previous, signal),
          () => {
            if (get(active$) === completion) {
              set(active$, null);
            }
            if (get(trailing$)?.completion === completion) {
              set(trailing$, null);
            }
          },
        ),
        (error) => {
          if (!completion.settled()) {
            completion.reject(error);
          }
        },
      );
      signal.throwIfAborted();
      completion.resolve(result);
      return result;
    },
  );

  return command(({ get, set }, ...args: [...Args, AbortSignal]) => {
    const signal = commandSignal(args);
    signal.throwIfAborted();
    const trailing = get(trailing$);
    if (trailing) {
      set(trailing$, { completion: trailing.completion, args });
      return trailing.completion.promise;
    }

    const active = get(active$);
    const lastStartedAt = get(lastStartedAt$);
    const leading =
      active === null &&
      (lastStartedAt === null || now() - lastStartedAt >= intervalMs);
    const completion = createDeferredPromise<Awaited<T>>(signal);
    // Publish ownership before execution, including when the delay reaches zero.
    if (leading) {
      set(active$, completion);
    } else {
      set(trailing$, { completion, args });
    }
    return set(
      runScheduled$,
      completion,
      args,
      active?.promise ?? null,
      signal,
    );
  });
}

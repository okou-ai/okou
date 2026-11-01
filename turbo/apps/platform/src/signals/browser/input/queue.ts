import { command, state, type Command, type Computed } from "ccstate";
import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import {
  createDeferredPromise,
  detach,
  Reason,
  type DeferredPromise,
} from "../../utils.ts";
import type { CdpClient } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";
import { releaseRuntimeObjects } from "../cdp/runtime-objects.ts";
import type { InputEffects, InputOperation } from "./effects.ts";
import type { Preedit } from "./composition.ts";
import type { InputLifecycle, InputOwner } from "./lifecycle.ts";
import type { Point } from "../display/geometry.ts";
import {
  sameDirection,
  samePointerState,
  type PointerState,
} from "./coalescing.ts";

interface Wheel extends PointerState {
  readonly point: Point;
  readonly modifiers: number;
  readonly deltaX: number;
  readonly deltaY: number;
}
type PreparationMethod =
  | "Page.getLayoutMetrics"
  | "Page.createIsolatedWorld"
  | "Runtime.addBinding"
  | "Runtime.evaluate"
  | "Runtime.callFunctionOn";
type WriteMethod =
  | "Input.dispatchKeyEvent"
  | "Input.dispatchMouseEvent"
  | "Input.insertText"
  | "Input.imeSetComposition";
type Button = NonNullable<Protocol.Input.DispatchMouseEventRequest["button"]>;
type Key = Protocol.Input.DispatchKeyEventRequest;

/** Immutable values only; all protocol actions are stable queue commands. */
export interface InputJob {
  readonly owner: InputOwner;
  readonly text?: string;
  readonly preedit?: Preedit;
  readonly wheel?: Wheel;
  readonly data?: unknown;
}
type Run = Command<void | Promise<void>, [InputJob, AbortSignal]>;
type Read = Command<Promise<unknown>, [InputJob, AbortSignal]>;
type Valid = Command<boolean, [InputJob]>;
interface QueuedJob {
  readonly input: InputJob;
  readonly run: Command<unknown, [InputJob, AbortSignal]>;
  readonly move?: PointerState;
  readonly prepare?: Run;
  readonly barrier?: boolean;
  readonly result?: DeferredPromise<unknown>;
  readonly valid?: Valid;
}
interface ActiveJob {
  readonly entry: QueuedJob;
  readonly started: boolean;
  readonly cancelled: boolean;
}
type Acknowledgement =
  | {
      readonly kind: "key";
      readonly key: Key;
      readonly pressed: Key | undefined;
    }
  | {
      readonly kind: "button";
      readonly button: Button;
      readonly pressed: Point | undefined;
    }
  | { readonly kind: "composition"; readonly token: object | null };

/** Private semantic queue state; no native effects or captured accessors. */
function createQueueOwnership(
  lifecycle: InputLifecycle,
  isCurrent$: Computed<boolean>,
) {
  const jobs$ = state<readonly QueuedJob[]>([]);
  const active$ = state<ActiveJob | null>(null);
  const lane$ = state<object | null>(null);
  const idleWaiters$ = state<ReadonlySet<DeferredPromise<void>>>(new Set());
  const wake$ = command(({ get, set }) => {
    const waiters = get(idleWaiters$);
    set(idleWaiters$, new Set());
    for (const waiter of waiters) {
      if (!waiter.settled()) {
        waiter.resolve();
      }
    }
  });
  const pending$ = state<ReadonlyMap<object, Promise<void>>>(new Map());
  const preparation$ = state<DeferredPromise<void> | null>(null);

  const owns$ = command(({ get, set }, owner: InputOwner): boolean => {
    return get(isCurrent$) && set(lifecycle.owns$, owner);
  });
  const cancel$ = command((_context, entry: QueuedJob) => {
    if (entry.result && !entry.result.settled()) {
      entry.result.reject(new Error("Input cancelled"));
    }
  });
  const cancelPreparation$ = command(({ get, set }) => {
    const preparation = get(preparation$);
    set(preparation$, null);
    if (preparation && !preparation.settled()) {
      preparation.resolve();
    }
  });
  const clear$ = command(({ get, set }) => {
    const jobs = get(jobs$);
    const active = get(active$);
    // Fence the lane before cancellation can synchronously reenter admission.
    set(jobs$, []);
    if (active) {
      set(active$, { ...active, cancelled: true });
    }
    set(cancelPreparation$);
    if (active) {
      set(cancel$, active.entry);
    }
    for (const job of jobs) {
      set(cancel$, job);
    }
  });
  const capture$ = command((_context, owner: InputOwner): InputJob => {
    return Object.freeze({ owner });
  });
  const check$ = command(({ set }, job: InputJob) => {
    if (!set(owns$, job.owner)) {
      throw new Error("Input cancelled");
    }
  });
  return {
    jobs$,
    active$,
    lane$,
    idleWaiters$,
    wake$,
    pending$,
    preparation$,
    owns$,
    cancel$,
    cancelPreparation$,
    clear$,
    capture$,
    check$,
  };
}
type QueueOwnership = ReturnType<typeof createQueueOwnership>;

function createQueueProtocol(
  graph: QueueOwnership & {
    readonly client: CdpClient;
    readonly effects: InputEffects;
  },
) {
  const { client, effects, owns$, check$ } = graph;
  const awaitWrite$ = command(
    async (
      { set },
      job: InputJob,
      operation: InputOperation<WriteMethod>,
      signal: AbortSignal,
    ): Promise<unknown> => {
      set(check$, job);
      const result = await set(effects.request$, operation);
      signal.throwIfAborted();
      set(check$, job);
      return result;
    },
  );
  const write$ = command(
    (
      { set },
      job: InputJob,
      operation: InputOperation<WriteMethod>,
    ): Promise<unknown> => {
      return set(awaitWrite$, job, operation, graph.client.signal);
    },
  );
  function requestFor<M extends PreparationMethod>(method: M) {
    const request$ = command(
      async (
        { set },
        job: InputJob,
        params: ProtocolMapping.Commands[M]["paramsType"][0],
        signal: AbortSignal,
      ): Promise<ProtocolMapping.Commands[M]["returnType"]> => {
        set(check$, job);
        const runtime =
          method === "Runtime.evaluate" || method === "Runtime.callFunctionOn";
        // This adapter only releases external handles, and never captures graph accessors.
        const releaseResult = (result: unknown) => {
          return releaseRuntimeObjects(client, job.owner.sessionId, result);
        };
        const result = await client.request(
          method,
          params,
          job.owner.sessionId,
          runtime ? releaseResult : undefined,
          signal,
        );
        signal.throwIfAborted();
        const current = set(owns$, job.owner);
        if (
          runtime &&
          (!current ||
            (isRecord(params) && params.returnByValue === true) ||
            (isRecord(result) && result.exceptionDetails !== undefined))
        ) {
          releaseResult(result);
        }
        if (!current) {
          throw new Error("Input cancelled");
        }
        return result;
      },
    );
    return command(
      (
        { set },
        job: InputJob,
        params: ProtocolMapping.Commands[M]["paramsType"][0],
      ) => {
        return set(request$, job, params, graph.client.signal);
      },
    );
  }
  const layoutRequest$ = requestFor("Page.getLayoutMetrics");
  const layout$ = command(({ set }, job: InputJob) => {
    return set(layoutRequest$, job, undefined);
  });
  const createWorld$ = requestFor("Page.createIsolatedWorld");
  const addBinding$ = requestFor("Runtime.addBinding");
  const evaluate$ = requestFor("Runtime.evaluate");
  const callFunction$ = requestFor("Runtime.callFunctionOn");

  return {
    write$,
    layout$,
    createWorld$,
    addBinding$,
    evaluate$,
    callFunction$,
  };
}
type QueueGraph = QueueOwnership &
  ReturnType<typeof createQueueProtocol> & {
    readonly lifecycle: InputLifecycle;
    readonly client: CdpClient;
    readonly effects: InputEffects;
    readonly failed$: Command<void, [unknown?]>;
  };

function createQueueReceipts(graph: QueueGraph) {
  const { lifecycle, pending$, owns$, write$, failed$, wake$ } = graph;
  const acknowledge$ = command(
    ({ set }, job: InputJob, receipt: Acknowledgement) => {
      if (receipt.kind === "key") {
        set(lifecycle.releaseKey$, job.owner, receipt.key, receipt.pressed);
      } else if (receipt.kind === "button") {
        set(
          lifecycle.releaseButton$,
          job.owner,
          receipt.button,
          receipt.pressed,
        );
      } else {
        set(lifecycle.finishComposition$, job.owner, receipt.token);
      }
    },
  );
  const receive$ = command(
    async (
      { get, set },
      ticket: {
        readonly token: object;
        readonly job: InputJob;
        readonly operation: InputOperation<WriteMethod>;
        readonly receipt?: Acknowledgement;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      const { token, job, operation, receipt } = ticket;
      using _receipt = {
        [Symbol.dispose]: () => {
          const pending = new Map(get(pending$));
          pending.delete(token);
          set(pending$, pending);
          set(wake$);
        },
      };
      const [result] = await Promise.allSettled([set(write$, job, operation)]);
      signal.throwIfAborted();
      if (result.status === "fulfilled") {
        if (receipt) {
          set(acknowledge$, job, receipt);
        }
      } else if (set(owns$, job.owner)) {
        set(failed$, result.reason);
      }
    },
  );
  const dispatch$ = command(
    (
      { get, set },
      job: InputJob,
      operation: InputOperation<WriteMethod>,
      receipt?: Acknowledgement,
    ) => {
      if (!set(owns$, job.owner)) {
        return;
      }
      if (get(pending$).size >= 64) {
        set(failed$);
        return;
      }
      const token = Object.freeze({});
      const pending = set(
        receive$,
        { token, job, operation, ...(receipt ? { receipt } : {}) },
        graph.client.signal,
      );
      set(pending$, new Map(get(pending$)).set(token, pending));
      detach(pending, Reason.DomCallback, "browser input acknowledgement");
    },
  );
  return { dispatch$ };
}

function createQueueRunner(graph: QueueGraph) {
  const { active$, pending$, preparation$, owns$, cancel$, effects } = graph;
  const canRun$ = command(({ get, set }, entry: QueuedJob): boolean => {
    return (
      set(owns$, entry.input.owner) &&
      (!entry.valid || set(entry.valid, entry.input)) &&
      (get(active$)?.entry !== entry || !get(active$)?.cancelled)
    );
  });
  const runJob$ = command(
    async (
      { get, set },
      original: QueuedJob,
      signal: AbortSignal,
    ): Promise<void> => {
      if (original.barrier) {
        await Promise.all(get(pending$).values());
        signal.throwIfAborted();
        // Original cleanup also owns native receipts outside the queued send lane.
        await set(effects.completion$);
        signal.throwIfAborted();
      }
      if (!set(canRun$, original)) {
        set(cancel$, original);
        return;
      }
      const pressured =
        !!(original.move || original.input.wheel) && get(pending$).size >= 32;
      if (original.prepare || pressured) {
        const cancelled = createDeferredPromise<void>(signal);
        set(preparation$, cancelled);
        using _preparation = {
          [Symbol.dispose]: () => {
            if (!cancelled.settled()) {
              cancelled.resolve();
            }
            if (get(preparation$) === cancelled) {
              set(preparation$, null);
            }
          },
        };
        if (pressured) {
          await Promise.race([
            cancelled.promise,
            Promise.race(get(pending$).values()),
          ]);
          signal.throwIfAborted();
          if (!set(canRun$, original)) {
            set(cancel$, original);
            return;
          }
        }
        if (original.prepare) {
          await Promise.race([
            cancelled.promise,
            set(original.prepare, original.input, signal),
          ]);
          signal.throwIfAborted();
        }
      }
      // Coalescing may replace an unstarted preedit in the active semantic slot.
      const active = get(active$);
      const entry = active?.entry ?? original;
      if (!set(canRun$, entry)) {
        set(cancel$, entry);
        return;
      }
      set(active$, { entry, started: true, cancelled: false });
      const value = await set(entry.run, entry.input, signal);
      signal.throwIfAborted();
      if (entry.result && !entry.result.settled()) {
        if (set(canRun$, entry)) {
          entry.result.resolve(value);
        } else {
          set(cancel$, entry);
        }
      }
    },
  );
  return { canRun$, runJob$ };
}

function createQueueLane(
  graph: QueueGraph,
  runner: ReturnType<typeof createQueueRunner>,
) {
  const {
    jobs$,
    active$,
    lane$,
    idleWaiters$,
    wake$,
    pending$,
    owns$,
    cancel$,
    cancelPreparation$,
    failed$,
  } = graph;
  const { canRun$, runJob$ } = runner;
  const drain$ = command(
    async ({ get, set }, token: object, signal: AbortSignal): Promise<void> => {
      using _lane = {
        [Symbol.dispose]: () => {
          if (get(lane$) === token) {
            set(lane$, null);
            set(wake$);
          }
        },
      };
      while (get(jobs$).length) {
        const [entry, ...rest] = get(jobs$);
        if (!entry) {
          break;
        }
        set(jobs$, rest);
        if (!set(canRun$, entry)) {
          set(cancel$, entry);
          continue;
        }
        set(active$, { entry, started: false, cancelled: false });
        using _active = {
          [Symbol.dispose]: () => {
            set(cancelPreparation$);
            set(active$, null);
          },
        };
        const [result] = await Promise.allSettled([
          set(runJob$, entry, signal),
        ]);
        signal.throwIfAborted();
        if (result.status === "rejected") {
          if (entry.result && !entry.result.settled()) {
            entry.result.reject(result.reason);
          } else if (!entry.result && set(owns$, entry.input.owner)) {
            set(failed$, result.reason);
          }
        }
      }
    },
  );
  const add$ = command(({ get, set }, entry: QueuedJob) => {
    if (!set(canRun$, entry)) {
      set(cancel$, entry);
      return;
    }
    const jobs = get(jobs$);
    const previous = jobs.at(-1);
    const replace =
      entry.move &&
      previous?.move &&
      set(owns$, previous.input.owner) &&
      samePointerState(previous.move, entry.move);
    const next = replace ? jobs.slice(0, -1) : jobs;
    if (next.length + get(pending$).size + (get(active$) ? 1 : 0) >= 64) {
      if (entry.result) {
        set(cancel$, entry);
      } else {
        set(failed$);
      }
      return;
    }
    set(jobs$, [...next, entry]);
    if (!get(lane$)) {
      const token = Object.freeze({});
      set(lane$, token);
      detach(
        set(drain$, token, graph.client.signal),
        Reason.DomCallback,
        "browser input send lane",
      );
    }
  });
  const awaitSettle$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      // Wait for semantic lane/receipt progress, not a cached worker Promise.
      while (get(lane$) || get(pending$).size) {
        const waiter = createDeferredPromise<void>(signal);
        set(idleWaiters$, new Set([...get(idleWaiters$), waiter]));
        using _waiter = {
          [Symbol.dispose]: () => {
            const remaining = new Set(get(idleWaiters$));
            remaining.delete(waiter);
            set(idleWaiters$, remaining);
          },
        };
        await waiter.promise;
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
    },
  );
  const settle$ = command(({ set }): Promise<void> => {
    return set(awaitSettle$, graph.client.signal);
  });
  return { add$, settle$ };
}
type QueueAdmission = QueueGraph &
  ReturnType<typeof createQueueRunner> &
  ReturnType<typeof createQueueLane>;

function createQueueReads(graph: QueueAdmission) {
  const { effects, jobs$, canRun$, cancel$, add$ } = graph;
  const completeRun$ = command(({ set }): Promise<void> => {
    return set(effects.completion$);
  });
  const completion$ = command(({ set }, owner: InputOwner): Promise<void> => {
    const result = createDeferredPromise<unknown>(graph.client.signal);
    set(add$, {
      input: Object.freeze({ owner }),
      run: completeRun$,
      barrier: true,
      result,
    });
    return result.promise as Promise<void>;
  });
  const enqueueRead$ = command(
    (
      { get, set },
      owner: InputOwner,
      run: Read,
      valid?: Valid,
      data?: unknown,
    ): Promise<unknown> => {
      const result = createDeferredPromise<unknown>(graph.client.signal);
      const retained: QueuedJob[] = [];
      for (const job of get(jobs$)) {
        if (set(canRun$, job)) {
          retained.push(job);
        } else {
          set(cancel$, job);
        }
      }
      set(jobs$, retained);
      set(add$, {
        input: Object.freeze({ owner, data }),
        run,
        barrier: true,
        result,
        ...(valid ? { valid } : {}),
      });
      return result.promise;
    },
  );
  return { completion$, enqueueRead$ };
}

function createPreeditAdmission(graph: QueueAdmission) {
  const { jobs$, active$, owns$, failed$, add$ } = graph;
  const preedit$ = command(
    (
      { get, set },
      owner: InputOwner,
      preedit: Preedit,
      run: Run,
      data?: unknown,
    ) => {
      if (!set(owns$, owner)) {
        return;
      }
      if (preedit.text.length > 64 * 1024) {
        set(failed$);
        return;
      }
      const jobs = get(jobs$);
      const active = get(active$);
      const tail =
        jobs.at(-1) ?? (active && !active.started ? active.entry : null);
      if (
        tail?.input.preedit &&
        tail.input.data === data &&
        set(owns$, tail.input.owner)
      ) {
        const entry = {
          ...tail,
          input: Object.freeze({ ...tail.input, preedit }),
        };
        if (jobs.length) {
          set(jobs$, [...jobs.slice(0, -1), entry]);
        } else if (active) {
          set(active$, { ...active, entry });
        }
      } else {
        set(add$, {
          input: Object.freeze({ owner, preedit, data }),
          run,
          barrier: true,
        });
      }
    },
  );
  const discardPreedit$ = command(({ get, set }) => {
    const jobs = get(jobs$);
    const active = get(active$);
    const tail =
      jobs.at(-1) ?? (active && !active.started ? active.entry : null);
    if (!tail?.input.preedit || !set(owns$, tail.input.owner)) {
      return;
    }
    if (jobs.length) {
      set(jobs$, jobs.slice(0, -1));
    } else if (active) {
      set(active$, { ...active, cancelled: true });
    }
  });
  return { preedit$, discardPreedit$ };
}

function createQueueAdmission(graph: QueueAdmission) {
  const { jobs$, owns$, failed$, add$ } = graph;
  const enqueue$ = command(
    (
      { set },
      owner: InputOwner,
      run: Run,
      ...options: [
        move?: PointerState,
        prepare?: Run,
        data?: unknown,
        barrier?: boolean,
      ]
    ) => {
      const [move, prepare, data, barrier] = options;
      set(add$, {
        input: Object.freeze({ owner, data }),
        run,
        ...(barrier ? { barrier } : {}),
        ...(move ? { move } : {}),
        ...(prepare ? { prepare } : {}),
      });
    },
  );
  const text$ = command(
    (
      { set },
      owner: InputOwner,
      text: string,
      run: Run,
      ...options: [data?: unknown, barrier?: boolean]
    ) => {
      const [data, barrier = false] = options;
      if (!set(owns$, owner) || !text) {
        return;
      }
      if (text.length > 64 * 1024) {
        set(failed$);
        return;
      }
      set(add$, { input: Object.freeze({ owner, text, data }), run, barrier });
    },
  );
  const wheel$ = command(
    (
      { get, set },
      owner: InputOwner,
      wheel: Wheel,
      run: Run,
      ...options: [prepare?: Run, data?: unknown]
    ) => {
      const [prepare, data] = options;
      if (!set(owns$, owner)) {
        return;
      }
      if (![wheel.deltaX, wheel.deltaY].every(Number.isFinite)) {
        set(failed$);
        return;
      }
      const jobs = get(jobs$);
      const tail = jobs.at(-1);
      const previous = tail?.input.wheel;
      if (
        tail &&
        previous &&
        set(owns$, tail.input.owner) &&
        previous.point.x === wheel.point.x &&
        previous.point.y === wheel.point.y &&
        samePointerState(previous, wheel) &&
        sameDirection(previous.deltaX, wheel.deltaX) &&
        sameDirection(previous.deltaY, wheel.deltaY)
      ) {
        const deltaX = previous.deltaX + wheel.deltaX;
        const deltaY = previous.deltaY + wheel.deltaY;
        if (![deltaX, deltaY].every(Number.isFinite)) {
          set(failed$);
        } else {
          set(jobs$, [
            ...jobs.slice(0, -1),
            {
              ...tail,
              input: Object.freeze({
                ...tail.input,
                wheel: { ...previous, deltaX, deltaY },
              }),
            },
          ]);
        }
      } else {
        set(add$, {
          input: Object.freeze({ owner, wheel, data }),
          run,
          ...(prepare ? { prepare } : {}),
        });
      }
    },
  );
  return { enqueue$, text$, wheel$, ...createPreeditAdmission(graph) };
}

/** One ordered preparation/send lane, with bounded original-session receipts. */
export function createInputQueue(
  client: CdpClient,
  lifecycle: InputLifecycle,
  effects: InputEffects,
  isCurrent$: Computed<boolean>,
  failed$: Command<void, [unknown?]>,
) {
  const ownership = createQueueOwnership(lifecycle, isCurrent$);
  const native = { ...ownership, client, effects };
  const protocol = createQueueProtocol(native);
  const graph = { ...native, ...protocol, lifecycle, failed$ };
  const receipts = createQueueReceipts(graph);
  const runner = createQueueRunner(graph);
  const lane = createQueueLane(graph, runner);
  const admission = { ...graph, ...runner, ...lane };
  const reads = createQueueReads(admission);
  const jobs = createQueueAdmission(admission);
  return {
    clear$: ownership.clear$,
    capture$: ownership.capture$,
    settle$: lane.settle$,
    ...protocol,
    ...receipts,
    ...reads,
    ...jobs,
  };
}
export type InputQueue = ReturnType<typeof createInputQueue>;

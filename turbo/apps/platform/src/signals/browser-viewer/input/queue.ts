import { createDeferredPromise, type DeferredPromise } from "../../utils.ts";

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping";
import type { CdpClient } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";
import { releaseRuntimeObjects } from "../cdp/runtime-objects.ts";
import type { InputEffects } from "./effects.ts";
import type { Preedit } from "./composition.ts";
import type { InputLifecycle, InputOwner } from "./lifecycle.ts";
import type { Point } from "../display/geometry.ts";
import {
  sameDirection,
  samePointerState,
  type PointerState,
} from "./coalescing.ts";

interface Wheel extends PointerState {
  point: Point;
  modifiers: number;
  deltaX: number;
  deltaY: number;
}

type InputMethod =
  "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent" | "Input.insertText";
type PreparationMethod =
  | "Page.getLayoutMetrics"
  | "Page.getNavigationHistory"
  | "Page.createIsolatedWorld"
  | "Runtime.evaluate"
  | "Runtime.callFunctionOn";
type WriteMethod =
  | InputMethod
  | "Input.imeSetComposition"
  | "Page.navigate"
  | "Page.reload"
  | "Page.navigateToHistoryEntry";

export interface InputJob {
  readonly owner: InputOwner;
  readonly text?: string;
  preedit?: Preedit;
  wheel?: Wheel;
  request<M extends PreparationMethod>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  write<M extends WriteMethod>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]>;
  dispatch<M extends InputMethod>(
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
    acknowledged?: () => void,
  ): void;
}

interface QueuedJob extends InputJob {
  run: (job: InputJob) => void | Promise<void>;
  move: PointerState | null;
  started: boolean;
  cancelled?: boolean;
  prepare?: (job: InputJob) => Promise<void>;
  barrier?: boolean;
  completion?: boolean;
  cancel?: () => void;
  valid?: () => boolean;
}

/** Preparation and sends are ordered; bounded acknowledgements settle separately. */
export class InputQueue {
  private readonly jobs: QueuedJob[] = [];
  private readonly pending = new Set<Promise<void>>();
  private running = false;
  private drained: Promise<void> = Promise.resolve();
  private cancelPreparation: (() => void) | undefined;
  private active: QueuedJob | null = null;

  constructor(
    private readonly client: CdpClient,
    private readonly lifecycle: InputLifecycle,
    private readonly effects: InputEffects,
    private readonly isCurrent: () => boolean,
    private readonly failed: (error?: unknown) => void,
  ) {}

  clear(): void {
    this.cancelPreparation?.();
    this.active?.cancel?.();
    for (const job of this.jobs) {
      job.cancel?.();
    }
    this.jobs.length = 0;
  }

  /** After admission stops, join the send lane without acquiring a new owner. */
  async settle(): Promise<void> {
    await this.drained;
    await Promise.allSettled(this.pending);
  }

  /** A completion fence observes prior work; it cannot acquire write authority. */
  completion(owner: InputOwner, settle: () => Promise<void>): Promise<void> {
    return this.enqueueRead(
      owner,
      settle,
      () => {
        return this.lifecycle.owns(owner);
      },
      true,
    );
  }

  /** Read failures/cancellation settle their caller without disabling input. */
  read<T>(
    owner: InputOwner,
    run: (job: InputJob) => Promise<T>,
    valid: () => boolean,
  ): Promise<T> {
    return this.enqueueRead(owner, run, valid, false);
  }

  private async enqueueRead<T>(
    owner: InputOwner,
    run: (job: InputJob) => Promise<T>,
    valid: () => boolean,
    completion: boolean,
  ): Promise<T> {
    const admitted = createDeferredPromise<InputJob>(this.client.signal);
    const completed = createDeferredPromise<void>(this.client.signal);
    const cancelled = createDeferredPromise<never>(this.client.signal);
    const cancel = () => {
      const error = new Error("Selection cancelled");
      if (!admitted.settled()) {
        admitted.reject(error);
      }
      if (!cancelled.settled()) {
        cancelled.reject(error);
      }
    };
    // The caller observes the real read result. The queue only joins its
    // completion, so a failed selection cannot disable unrelated input.
    const operation = this.executeRead(admitted.promise, run, completed);
    using _cancellation = {
      [Symbol.dispose]: () => {
        if (!cancelled.settled()) {
          cancelled.reject(
            new DOMException("Selection finished", "AbortError"),
          );
        }
      },
    };
    if (!this.lifecycle.owns(owner)) {
      cancel();
    } else {
      for (let index = this.jobs.length - 1; index >= 0; index--) {
        const job = this.jobs[index]!;
        if (job.valid && !job.valid()) {
          job.cancel?.();
          this.jobs.splice(index, 1);
        }
      }
      this.add(
        owner,
        async (job) => {
          if (!admitted.settled()) {
            admitted.resolve(job);
          }
          await completed.promise;
        },
        { barrier: true, cancel, valid, completion },
      );
    }
    return await Promise.race([operation, cancelled.promise]);
  }

  private async executeRead<T>(
    admitted: Promise<InputJob>,
    run: (job: InputJob) => Promise<T>,
    completed: DeferredPromise<void>,
  ): Promise<T> {
    using _completion = {
      [Symbol.dispose]: () => {
        if (!completed.settled()) {
          completed.resolve();
        }
      },
    };
    const job = await admitted;
    this.client.signal.throwIfAborted();
    return await run(job);
  }

  capture(owner: InputOwner): InputJob {
    return {
      owner,
      request: (method, params) => {
        return this.request(owner, method, params);
      },
      write: (method, params) => {
        return this.write(owner, method, params);
      },
      dispatch: (method, params, acknowledged) => {
        if (!this.lifecycle.owns(owner)) {
          return;
        }
        if (this.pending.size >= 64) {
          this.failed();
          return;
        }
        const pending = (async () => {
          using _completion1 = {
            [Symbol.dispose]: () => {
              return this.pending.delete(pending);
            },
          };

          const [reply2] = await Promise.allSettled([
            (async () => {
              const [reply1] = await Promise.allSettled([
                this.write(owner, method, params),
              ]);
              if (reply1.status === "fulfilled") {
                return acknowledged?.();
              }
              throw reply1.reason;
            })(),
          ]);
          if (reply2.status === "fulfilled") {
            return reply2.value;
          }
          const error = reply2.reason;

          if (this.lifecycle.owns(owner)) {
            this.failed(error);
          }

          return;
        })();
        this.pending.add(pending);
      },
    };
  }

  text(owner: InputOwner, text: string, run: QueuedJob["run"]): void {
    if (!this.lifecycle.owns(owner) || !text) {
      return;
    }
    if (text.length > 64 * 1024) {
      this.failed();
      return;
    }
    // Each native commit may change the page's focus before the next commit.
    this.add(owner, run, { text });
  }

  preedit(owner: InputOwner, value: Preedit, run: QueuedJob["run"]): void {
    if (!this.lifecycle.owns(owner)) {
      return;
    }
    if (value.text.length > 64 * 1024) {
      this.failed();
      return;
    }
    const tail =
      this.jobs.at(-1) ?? (this.active?.started ? null : this.active);
    if (tail?.preedit !== undefined && this.lifecycle.owns(tail.owner)) {
      tail.preedit = value;
      return;
    }
    this.add(owner, run, { preedit: value });
  }

  discardPreedit(): void {
    const tail =
      this.jobs.at(-1) ?? (this.active?.started ? null : this.active);
    if (!tail?.preedit || !this.lifecycle.owns(tail.owner)) {
      return;
    }
    if (tail === this.active) {
      tail.cancelled = true;
    } else {
      this.jobs.pop();
    }
  }

  wheel(
    owner: InputOwner,
    wheel: Wheel,
    run: QueuedJob["run"],
    prepare: NonNullable<QueuedJob["prepare"]>,
  ): void {
    if (!this.lifecycle.owns(owner)) {
      return;
    }
    const tail = this.jobs.at(-1);
    const previous = tail?.wheel;
    if (![wheel.deltaX, wheel.deltaY].every(Number.isFinite)) {
      this.failed();
      return;
    }
    if (
      previous &&
      tail &&
      this.lifecycle.owns(tail.owner) &&
      previous.point.x === wheel.point.x &&
      previous.point.y === wheel.point.y &&
      samePointerState(previous, wheel) &&
      sameDirection(previous.deltaX, wheel.deltaX) &&
      sameDirection(previous.deltaY, wheel.deltaY)
    ) {
      const deltaX = previous.deltaX + wheel.deltaX;
      const deltaY = previous.deltaY + wheel.deltaY;
      if (![deltaX, deltaY].every(Number.isFinite)) {
        this.failed();
      } else {
        previous.deltaX = deltaX;
        previous.deltaY = deltaY;
      }
      return;
    }
    this.add(owner, run, { wheel, prepare });
  }

  enqueue(
    owner: InputOwner,
    run: QueuedJob["run"],
    move?: PointerState,
    prepare?: QueuedJob["prepare"],
  ): void {
    this.add(owner, run, {
      ...(move ? { move } : {}),
      ...(prepare ? { prepare } : {}),
    });
  }

  barrier(owner: InputOwner, run: QueuedJob["run"]): void {
    this.add(owner, run, { barrier: true });
  }

  private add(
    owner: InputOwner,
    run: QueuedJob["run"],
    options: {
      move?: PointerState;
      text?: string;
      preedit?: Preedit;
      wheel?: Wheel;
      prepare?: NonNullable<QueuedJob["prepare"]>;
      barrier?: boolean;
      completion?: boolean;
      cancel?: () => void;
      valid?: () => boolean;
    },
  ): void {
    if (!this.lifecycle.owns(owner)) {
      options.cancel?.();
      return;
    }
    const { move = null, ...rest } = options;
    const previous = this.jobs.at(-1);
    if (
      move &&
      previous?.move &&
      this.lifecycle.owns(previous.owner) &&
      samePointerState(previous.move, move)
    ) {
      this.jobs.pop();
    }
    if (this.jobs.length + this.pending.size + (this.active ? 1 : 0) >= 64) {
      if (options.cancel) {
        options.cancel();
      } else {
        this.failed();
      }
      return;
    }
    const job: QueuedJob = {
      ...this.capture(owner),
      run,
      move,
      started: false,
      ...rest,
    };
    this.jobs.push(job);
    if (!this.running) {
      this.drained = (async () => {
        const [reply3] = await Promise.allSettled([this.drain()]);
        if (reply3.status === "fulfilled") {
          return reply3.value;
        }
        const error = reply3.reason;

        if (this.lifecycle.available) {
          this.failed(error);
        }

        return;
      })();
    }
  }

  private async write<M extends WriteMethod>(
    owner: InputOwner,
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    if (!this.lifecycle.owns(owner)) {
      throw new Error("Input cancelled");
    }
    const result = await this.effects.request(method, params);
    if (!this.lifecycle.owns(owner)) {
      throw new Error("Input cancelled");
    }
    return result;
  }

  private async request<M extends PreparationMethod>(
    owner: InputOwner,
    method: M,
    params: ProtocolMapping.Commands[M]["paramsType"][0],
  ): Promise<ProtocolMapping.Commands[M]["returnType"]> {
    if (!this.lifecycle.owns(owner)) {
      throw new Error("Input cancelled");
    }
    const runtime =
      method === "Runtime.evaluate" || method === "Runtime.callFunctionOn";
    const releaseResult = (result: unknown) => {
      return releaseRuntimeObjects(this.client, owner.sessionId, result);
    };
    const result = await this.client.request(
      method,
      params,
      owner.sessionId,
      runtime ? releaseResult : undefined,
    );
    const current = this.lifecycle.owns(owner);
    // By-value and exceptional results never transfer a remote handle to the
    // job. Only a successful, current by-reference result may be retained.
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
  }

  private canRun(job: QueuedJob): boolean {
    return (
      this.isCurrent() &&
      job.valid?.() !== false &&
      this.lifecycle.owns(job.owner) &&
      !job.cancelled
    );
  }

  private async runJob(job: QueuedJob): Promise<void> {
    if (job.barrier) {
      await Promise.allSettled(this.pending);
    }
    if (!this.lifecycle.owns(job.owner) || job.valid?.() === false) {
      job.cancel?.();
      return;
    }
    if (job.completion) {
      job.started = true;
      await job.run(job);
      return;
    }
    const pressured = !!(job.move || job.wheel) && this.pending.size >= 32;
    if (job.prepare || pressured) {
      if (!this.canRun(job)) {
        job.cancel?.();
        return;
      }
      const cancelled = createDeferredPromise<void>(this.client.signal);
      this.cancelPreparation = () => {
        if (!cancelled.settled()) {
          cancelled.resolve();
        }
      };
      if (pressured) {
        await Promise.race([cancelled.promise, Promise.race(this.pending)]);
        if (!this.canRun(job)) {
          job.cancel?.();
          return;
        }
      }
      if (job.prepare) {
        await Promise.race([cancelled.promise, job.prepare(job)]);
      }
      if (!cancelled.settled()) {
        cancelled.resolve();
      }
      this.cancelPreparation = undefined;
    }
    if (this.canRun(job)) {
      job.started = true;
      await job.run(job);
    } else {
      job.cancel?.();
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    const [drained] = await Promise.allSettled([
      (async () => {
        while (this.jobs.length && this.lifecycle.available) {
          const job = this.jobs.shift()!;
          if (!this.lifecycle.owns(job.owner) || job.valid?.() === false) {
            job.cancel?.();
            continue;
          }
          this.active = job;
          using _job = {
            [Symbol.dispose]: () => {
              this.cancelPreparation?.();
              this.cancelPreparation = undefined;
              this.active = null;
            },
          };
          const [result] = await Promise.allSettled([this.runJob(job)]);
          if (result.status === "rejected") {
            if (job.cancel) {
              job.cancel();
            } else if (this.lifecycle.owns(job.owner)) {
              this.failed(result.reason);
            }
          }
        }
      })(),
    ]);
    this.running = false;
    if (drained.status === "rejected") {
      throw drained.reason;
    }
  }
}

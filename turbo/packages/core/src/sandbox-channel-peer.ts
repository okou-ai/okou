import {
  SANDBOX_CHANNEL_LIMITS as limits,
  SandboxChannelError,
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  sandboxChannelCategoriesSchema,
  sandboxChannelErrorSchema,
  sandboxChannelHelloResultSchema,
  sandboxChannelIdSchema,
  sandboxChannelNameSchema,
  sandboxChannelObjectSchema,
  sandboxChannelRemoteError,
  type SandboxChannelCategoryContract,
  type SandboxChannelEvent,
  type SandboxChannelErrorCode,
  type SandboxChannelMessage,
  type SandboxChannelOperation,
  type SandboxChannelPayloadSchema,
  type SandboxChannelWireError,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import { delay } from "signal-timers";
import type {
  RunWssTransport,
  RunWssTransportOptions,
  RunWssState,
} from "./run-wss-transport";

export type SandboxChannelState =
  "idle" | "connecting" | "ready" | "reconnecting" | "closed" | "failed";

export interface SandboxChannelHandlerContext {
  readonly signal: AbortSignal;
  readonly peer: SandboxChannelPeer;
}

export interface SandboxChannelHandler {
  readonly operation: SandboxChannelOperation;
  readonly handle: (
    params: unknown,
    context: SandboxChannelHandlerContext,
  ) => Promise<unknown>;
}
export interface SandboxChannelEventHandler {
  readonly event: SandboxChannelEvent;
  readonly handle: (
    data: unknown,
    context: SandboxChannelHandlerContext,
  ) => Promise<void>;
}

/** Local rejection only; events carry no acknowledgment or delivery promise. */
export interface SandboxChannelEventError {
  readonly category: string;
  readonly event: string;
  readonly code: SandboxChannelErrorCode;
}

/** Typed params adapter; the peer validates the captured operation's result. */
export function sandboxChannelHandler<P, R>(
  operation: SandboxChannelOperation<P, R>,
  handle: (params: P, context: SandboxChannelHandlerContext) => R | Promise<R>,
): SandboxChannelHandler {
  return {
    operation,
    async handle(params, context) {
      const parsed = operation.params.safeParse(params);
      if (!parsed.success) throw new SandboxChannelError("invalid_params");
      return handle(parsed.data, context);
    },
  };
}

export function sandboxChannelEventHandler<D>(
  event: SandboxChannelEvent<D>,
  handle: (
    data: D,
    context: SandboxChannelHandlerContext,
  ) => void | Promise<void>,
): SandboxChannelEventHandler {
  return {
    event,
    async handle(data, context) {
      const parsed = event.data.safeParse(data);
      if (!parsed.success) throw new SandboxChannelError("invalid_params");
      await handle(parsed.data, context);
    },
  };
}

export interface SandboxChannelPeerOptions {
  readonly categories: readonly SandboxChannelCategoryContract[];
  readonly handlers?: readonly SandboxChannelHandler[];
  readonly events?: readonly SandboxChannelEventHandler[];
  /** Synchronous and payload-free; a throwing observer is retired. */
  readonly onEventError?: (error: SandboxChannelEventError) => undefined;
  readonly onStateChange?: (
    state: SandboxChannelState,
    error?: SandboxChannelError,
  ) => void;
}

type RequestMessage = Extract<
  SandboxChannelMessage,
  { type: "hello" | "request" }
>;
type ResponseMessage = Extract<SandboxChannelMessage, { type: "response" }>;
type BusinessRequest = Extract<SandboxChannelMessage, { type: "request" }>;
type EventMessage = Extract<SandboxChannelMessage, { type: "event" }>;
interface Pending {
  readonly complete: (message: ResponseMessage) => void;
  readonly reject: (error: Error) => void;
}
interface QueuedFrame {
  readonly frame: ArrayBuffer;
  readonly deadline: number;
  readonly failure: () => void;
  readonly valid: () => boolean;
}
interface Epoch {
  readonly owner: AbortController;
  readonly pending: Map<string, Pending>;
  readonly incoming: Set<string>;
  readonly queue: QueuedFrame[];
  peerCategories: ReadonlyMap<string, number>;
  ready: boolean;
  eventWork: number;
  queuedBytes: number;
  writing: boolean;
}
interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function key(category: string, name: string): string {
  return `${category}:${name}`;
}
function closedError(): DOMException {
  return new DOMException("Sandbox channel closed", "AbortError");
}

/** One external connector, with either-direction business calls after hello. */
export class SandboxChannelPeer {
  private readonly transport: RunWssTransport;
  private readonly categories = new Map<string, number>();
  private readonly operations = new Map<string, SandboxChannelOperation>();
  private readonly eventContracts = new Map<string, SandboxChannelEvent>();
  private readonly handlers = new Map<string, SandboxChannelHandler>();
  private readonly events = new Map<string, SandboxChannelEventHandler>();
  private readonly waiters = new Set<ReadyWaiter>();
  private epoch: Epoch | null = null;
  private stateValue: SandboxChannelState = "idle";
  private started = false;
  private rootSignal: AbortSignal | null = null;
  private eventErrorObserver: SandboxChannelPeerOptions["onEventError"];

  constructor(
    createTransport: (options: RunWssTransportOptions) => RunWssTransport,
    private readonly options: SandboxChannelPeerOptions,
  ) {
    this.eventErrorObserver = options.onEventError;
    this.installContracts(options.categories);
    this.installHandlers(options);
    this.transport = createTransport({
      onFrame: (frame) => {
        return this.receive(frame);
      },
      onStateChange: (state) => {
        return this.transportState(state);
      },
    });
  }

  private installContracts(
    contracts: readonly SandboxChannelCategoryContract[],
  ): void {
    for (const contract of contracts) {
      const parsed = sandboxChannelCategoriesSchema.safeParse({
        [contract.category]: contract.version,
      });
      if (!parsed.success || this.categories.has(contract.category))
        throw new SandboxChannelError("invalid_request");
      this.categories.set(contract.category, contract.version);
      for (const operation of contract.operations) {
        this.register(contract, operation.operation, operation);
        const operationKey = key(contract.category, operation.operation);
        if (this.operations.has(operationKey))
          throw new SandboxChannelError("invalid_request");
        this.operations.set(operationKey, operation);
      }
      for (const event of contract.events) {
        this.register(contract, event.event, event);
        const eventKey = key(contract.category, event.event);
        if (this.eventContracts.has(eventKey))
          throw new SandboxChannelError("invalid_request");
        this.eventContracts.set(eventKey, event);
      }
    }
    if (this.categories.size > limits.maxCategories)
      throw new SandboxChannelError("limit_exceeded");
  }

  private installHandlers(options: SandboxChannelPeerOptions): void {
    for (const handler of options.handlers ?? []) {
      const operationKey = key(
        handler.operation.category,
        handler.operation.operation,
      );
      if (
        this.operations.get(operationKey) !== handler.operation ||
        handler.operation.origin === "external" ||
        this.handlers.has(operationKey)
      )
        throw new SandboxChannelError("invalid_request");
      this.handlers.set(operationKey, handler);
    }
    for (const operation of this.operations.values()) {
      if (
        operation.origin !== "external" &&
        !this.handlers.has(key(operation.category, operation.operation))
      )
        throw new SandboxChannelError("invalid_request");
    }
    for (const event of options.events ?? []) {
      const eventKey = key(event.event.category, event.event.event);
      if (
        this.eventContracts.get(eventKey) !== event.event ||
        event.event.origin === "external" ||
        this.events.has(eventKey)
      )
        throw new SandboxChannelError("invalid_request");
      this.events.set(eventKey, event);
    }
  }

  get state(): SandboxChannelState {
    return this.stateValue;
  }

  connect(signal: AbortSignal): Promise<void> {
    if (
      signal.aborted ||
      this.stateValue === "closed" ||
      this.stateValue === "failed"
    )
      return Promise.reject(closedError());
    if (this.started) return this.whenReady(signal);
    this.started = true;
    this.rootSignal = signal;
    signal.addEventListener("abort", this.closeOnAbort, { once: true });
    const ready = this.whenReady(signal);
    return Promise.all([this.transport.connect(signal), ready])
      .then(() => {
        return undefined;
      })
      .catch((error: unknown) => {
        if (this.stateValue !== "closed")
          this.fail(new SandboxChannelError("unavailable"));
        throw error;
      });
  }

  /** Resolves for the current/replacement business epoch, never mere admission. */
  whenReady(signal: AbortSignal): Promise<void> {
    if (
      signal.aborted ||
      this.stateValue === "closed" ||
      this.stateValue === "failed"
    )
      return Promise.reject(closedError());
    if (this.epoch?.ready) return Promise.resolve();
    if (this.waiters.size >= limits.maxPending)
      return Promise.reject(new SandboxChannelError("busy"));
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
      };
      const waiter: ReadyWaiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        return waiter.reject(closedError());
      };
      this.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async call<P, R>(
    operation: SandboxChannelOperation<P, R>,
    params: P,
    signal: AbortSignal,
  ): Promise<R> {
    const epoch = this.readyEpoch();
    this.gate(epoch, operation.category, operation.categoryVersion);
    if (
      this.operations.get(key(operation.category, operation.operation)) !==
      operation
    )
      throw new SandboxChannelError("unknown_operation");
    if (operation.origin === "guest")
      throw new SandboxChannelError("forbidden");
    const parsed = operation.params.safeParse(params);
    if (!parsed.success) throw new SandboxChannelError("invalid_params");
    const object = sandboxChannelObjectSchema.safeParse(parsed.data);
    if (!object.success) throw new SandboxChannelError("invalid_params");
    const message: BusinessRequest = {
      schemaVersion: limits.schemaVersion,
      type: "request",
      id: this.id(),
      category: operation.category,
      categoryVersion: operation.categoryVersion,
      operation: operation.operation,
      params: object.data,
    };
    return this.request(
      epoch,
      message,
      operation.result,
      limits.requestTimeoutMs,
      signal,
    );
  }

  /** Acceptance means a finite local write, not delivery or acknowledgment. */
  sendEvent<D>(event: SandboxChannelEvent<D>, data: D): boolean {
    const epoch = this.readyEpoch();
    this.gate(epoch, event.category, event.categoryVersion);
    if (this.eventContracts.get(key(event.category, event.event)) !== event)
      throw new SandboxChannelError("unknown_operation");
    if (event.origin === "guest") throw new SandboxChannelError("forbidden");
    const parsed = event.data.safeParse(data);
    if (!parsed.success) throw new SandboxChannelError("invalid_params");
    const object = sandboxChannelObjectSchema.safeParse(parsed.data);
    if (!object.success) throw new SandboxChannelError("invalid_params");
    let accepted = true;
    const queued = this.write(
      epoch,
      {
        schemaVersion: limits.schemaVersion,
        type: "event",
        id: this.id(),
        category: event.category,
        categoryVersion: event.categoryVersion,
        event: event.event,
        data: object.data,
      },
      () => {
        accepted = false;
      },
    );
    return queued && accepted;
  }

  close(): void {
    if (this.stateValue === "closed") return;
    this.stateValue = "closed";
    this.disposeEpoch(closedError());
    this.releaseRoot();
    this.transport.close();
    this.rejectWaiters(closedError());
    this.notify();
  }

  private register(
    contract: SandboxChannelCategoryContract,
    name: string,
    binding: { category: string; categoryVersion: number },
  ): void {
    if (
      binding.category !== contract.category ||
      binding.categoryVersion !== contract.version ||
      !sandboxChannelNameSchema.safeParse(name).success
    )
      throw new SandboxChannelError("invalid_request");
  }
  private readonly closeOnAbort = () => {
    return this.close();
  };
  private releaseRoot(): void {
    this.rootSignal?.removeEventListener("abort", this.closeOnAbort);
    this.rootSignal = null;
  }
  private notify(error?: SandboxChannelError): void {
    try {
      this.options.onStateChange?.(this.stateValue, error);
    } catch {
      this.close();
    } // A broken consumer cannot escape or orphan the peer.
  }
  private setState(state: SandboxChannelState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.notify();
  }
  private fail(error: SandboxChannelError): void {
    if (this.stateValue === "closed" || this.stateValue === "failed") return;
    this.stateValue = "failed";
    this.disposeEpoch(error);
    this.releaseRoot();
    this.transport.close();
    this.rejectWaiters(error);
    this.notify(error);
  }
  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) waiter.reject(error);
  }
  private current(epoch: Epoch): boolean {
    return this.epoch === epoch && !epoch.owner.signal.aborted;
  }
  private terminal(): boolean {
    return this.stateValue === "closed" || this.stateValue === "failed";
  }
  private readyEpoch(): Epoch {
    if (!this.epoch?.ready || !this.current(this.epoch))
      throw new SandboxChannelError("unavailable");
    return this.epoch;
  }
  private id(): string {
    try {
      const id = globalThis.crypto.randomUUID();
      if (!sandboxChannelIdSchema.safeParse(id).success)
        throw new SandboxChannelError("unavailable");
      return id;
    } catch {
      const error = new SandboxChannelError("unavailable");
      this.fail(error);
      throw error;
    }
  }
  private transportState(state: RunWssState): void {
    if (this.terminal()) return;
    if (state === "ready") {
      this.startEpoch();
      return;
    }
    if (state === "closed" || state === "failed") {
      this.fail(new SandboxChannelError("unavailable"));
      return;
    }
    if (state === "reconnecting")
      this.disposeEpoch(new SandboxChannelError("unavailable"));
    // An epoch-abort listener may have closed the entire peer synchronously.
    if (this.terminal()) return;
    if (state === "connecting" || state === "reconnecting")
      this.setState(state);
  }
  private disposeEpoch(error: Error): void {
    const epoch = this.epoch;
    this.epoch = null;
    if (!epoch) return;
    epoch.ready = false;
    epoch.owner.abort();
    for (const pending of epoch.pending.values()) pending.reject(error);
    const queued = epoch.queue.splice(0);
    epoch.queuedBytes = 0;
    for (const entry of queued) entry.failure();
  }
  private startEpoch(): void {
    this.disposeEpoch(new SandboxChannelError("unavailable"));
    if (this.terminal()) return;
    const epoch: Epoch = {
      owner: new AbortController(),
      pending: new Map(),
      incoming: new Set(),
      queue: [],
      peerCategories: new Map(),
      ready: false,
      eventWork: 0,
      queuedBytes: 0,
      writing: false,
    };
    this.epoch = epoch;
    try {
      const hello: RequestMessage = {
        schemaVersion: limits.schemaVersion,
        type: "hello",
        id: this.id(),
        categories: Object.fromEntries(this.categories),
      };
      this.request(
        epoch,
        hello,
        sandboxChannelHelloResultSchema,
        limits.helloTimeoutMs,
        epoch.owner.signal,
        (result) => {
          epoch.peerCategories = new Map(Object.entries(result.categories));
          epoch.ready = true;
          this.setState("ready");
          if (this.current(epoch))
            for (const waiter of this.waiters) waiter.resolve();
        },
      ).catch((error: unknown) => {
        if (this.current(epoch))
          this.fail(
            error instanceof SandboxChannelError
              ? error
              : new SandboxChannelError("unavailable"),
          );
      });
    } catch (error) {
      this.fail(
        error instanceof SandboxChannelError
          ? error
          : new SandboxChannelError("unavailable"),
      );
    }
  }

  private request<R>(
    epoch: Epoch,
    message: RequestMessage,
    schema: SandboxChannelPayloadSchema<R>,
    timeout: number,
    signal: AbortSignal,
    beforeResolve?: (value: R) => void,
  ): Promise<R> {
    if (signal.aborted || !this.current(epoch))
      return Promise.reject(closedError());
    if (epoch.pending.size >= limits.maxPending)
      return Promise.reject(new SandboxChannelError("busy"));
    if (epoch.pending.has(message.id))
      return Promise.reject(new SandboxChannelError("invalid_request"));
    return new Promise<R>((resolve, reject) => {
      const timer = new AbortController();
      let settled = false;
      const cleanup = () => {
        timer.abort();
        signal.removeEventListener("abort", abort);
        if (epoch.pending.get(message.id) === pending)
          epoch.pending.delete(message.id);
      };
      const pending: Pending = {
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
        complete: (response) => {
          if (settled) return;
          if (response.error !== undefined) {
            pending.reject(sandboxChannelRemoteError(response.error));
            return;
          }
          let result: ReturnType<typeof schema.safeParse>;
          try {
            result = schema.safeParse(response.result);
          } catch {
            pending.reject(new SandboxChannelError("invalid_request"));
            return;
          }
          if (!result.success) {
            pending.reject(new SandboxChannelError("invalid_request"));
            return;
          }
          cleanup();
          beforeResolve?.(result.data);
          settled = true;
          resolve(result.data);
        },
      };
      const abort = () => {
        return pending.reject(closedError());
      };
      // Registration precedes the synchronous send boundary and reverse traffic.
      epoch.pending.set(message.id, pending);
      signal.addEventListener("abort", abort, { once: true });
      delay(timeout, { signal: timer.signal }).then(
        () => {
          pending.reject(new SandboxChannelError("unavailable"));
        },
        () => {
          /* Owned timer cancellation after every terminal outcome. */
        },
      );
      try {
        if (
          !this.write(
            epoch,
            message,
            () => {
              return pending.reject(new SandboxChannelError("busy"));
            },
            () => {
              return !settled && !signal.aborted;
            },
          )
        )
          pending.reject(new SandboxChannelError("busy"));
      } catch (error) {
        pending.reject(
          error instanceof Error
            ? error
            : new SandboxChannelError("unavailable"),
        );
      }
    });
  }

  private gate(epoch: Epoch, category: string, version: number): void {
    const local = this.categories.get(category),
      remote = epoch.peerCategories.get(category);
    if (local === undefined || remote === undefined)
      throw new SandboxChannelError("unsupported_category", { category });
    if (local !== version || remote !== version)
      throw new SandboxChannelError("category_version_mismatch", {
        category,
        expectedVersion: local,
        receivedVersion: local !== version ? version : remote,
      });
  }
  private receive(frame: ArrayBuffer): void {
    const epoch = this.epoch;
    if (!epoch || !this.current(epoch)) return;
    try {
      const message = decodeSandboxChannelFrame(frame);
      if (message.type === "response") {
        epoch.pending.get(message.requestId)?.complete(message);
        return;
      }
      if (!epoch.ready || message.type === "hello")
        throw new SandboxChannelError("invalid_request");
      if (message.type === "request") this.receiveRequest(epoch, message);
      else this.receiveEvent(epoch, message);
    } catch (error) {
      this.fail(
        error instanceof SandboxChannelError
          ? error
          : new SandboxChannelError("invalid_request"),
      );
    }
  }
  private response(
    epoch: Epoch,
    requestId: string,
    body: { result: unknown } | { error: SandboxChannelWireError },
  ): void {
    if (!this.current(epoch)) return;
    const message: ResponseMessage = {
      schemaVersion: limits.schemaVersion,
      type: "response",
      id: this.id(),
      requestId,
      ...body,
    };
    if (
      !this.write(epoch, message, () => {
        if (this.current(epoch))
          this.fail(new SandboxChannelError("unavailable"));
      }) &&
      this.current(epoch)
    )
      this.fail(new SandboxChannelError("unavailable"));
  }
  private receiveRequest(epoch: Epoch, message: BusinessRequest): void {
    if (epoch.incoming.has(message.id))
      throw new SandboxChannelError("invalid_request");
    let handler: SandboxChannelHandler;
    let operation: SandboxChannelOperation;
    try {
      this.gate(epoch, message.category, message.categoryVersion);
      const selected = this.operations.get(
        key(message.category, message.operation),
      );
      if (!selected) throw new SandboxChannelError("unknown_operation");
      operation = selected;
      if (operation.origin === "external")
        throw new SandboxChannelError("forbidden");
      if (!operation.params.safeParse(message.params).success)
        throw new SandboxChannelError("invalid_params");
      const installed = this.handlers.get(
        key(message.category, message.operation),
      );
      if (!installed) throw new SandboxChannelError("unknown_operation");
      handler = installed;
      if (epoch.incoming.size + epoch.eventWork >= limits.maxIncoming)
        throw new SandboxChannelError("busy");
    } catch (error) {
      this.response(epoch, message.id, {
        error: this.requestError(error, "invalid_params"),
      });
      return;
    }
    epoch.incoming.add(message.id);
    const work = async () => {
      try {
        const result = operation.result.safeParse(
          await handler.handle(message.params, {
            signal: epoch.owner.signal,
            peer: this,
          }),
        );
        if (!result.success) throw new SandboxChannelError("unavailable");
        if (this.current(epoch))
          this.response(epoch, message.id, { result: result.data });
      } catch (error) {
        if (this.current(epoch))
          this.response(epoch, message.id, {
            error: this.requestError(error, "unavailable"),
          });
      } finally {
        epoch.incoming.delete(message.id);
      }
    };
    work().catch(() => {
      if (this.current(epoch))
        this.fail(new SandboxChannelError("unavailable"));
    });
  }

  private requestError(
    error: unknown,
    fallback: SandboxChannelErrorCode,
  ): SandboxChannelWireError {
    try {
      if (error instanceof SandboxChannelError) {
        const parsed = sandboxChannelErrorSchema.safeParse({
          code: error.code,
          ...error.details,
        });
        if (parsed.success) return parsed.data;
      }
    } catch {
      // Consumer error inspection is rejected at the business boundary.
    }
    return { code: fallback };
  }

  private receiveEvent(epoch: Epoch, message: EventMessage): void {
    try {
      this.gate(epoch, message.category, message.categoryVersion);
    } catch (error) {
      if (error instanceof SandboxChannelError) return;
      throw error;
    }
    const contract = this.eventContracts.get(
      key(message.category, message.event),
    );
    if (!contract) return;
    if (contract.origin === "external") {
      this.reportEventError(epoch, message, "forbidden");
      return;
    }
    try {
      if (!contract.data.safeParse(message.data).success) {
        this.reportEventError(epoch, message, "invalid_params");
        return;
      }
    } catch {
      this.reportEventError(epoch, message, "invalid_params");
      return;
    }
    const handler = this.events.get(key(message.category, message.event));
    if (!handler) return;
    if (epoch.incoming.size + epoch.eventWork >= limits.maxIncoming) {
      this.reportEventError(epoch, message, "busy");
      return;
    }
    epoch.eventWork += 1;
    const work = async () => {
      try {
        await handler.handle(message.data, {
          signal: epoch.owner.signal,
          peer: this,
        });
      } finally {
        epoch.eventWork -= 1;
      }
    };
    work().catch(() => {
      this.reportEventError(epoch, message, "unavailable");
    });
  }

  private reportEventError(
    epoch: Epoch,
    message: EventMessage,
    code: SandboxChannelErrorCode,
  ): void {
    if (!this.current(epoch)) return;
    try {
      this.eventErrorObserver?.({
        category: message.category,
        event: message.event,
        code,
      });
    } catch {
      // Observer faults must not convert a local event rejection into teardown.
      this.eventErrorObserver = undefined;
    }
  }

  private write(
    epoch: Epoch,
    message: SandboxChannelMessage,
    failure: () => void,
    valid: () => boolean = () => {
      return true;
    },
  ): boolean {
    if (!this.current(epoch)) return false;
    const frame = encodeSandboxChannelFrame(message);
    if (
      epoch.queue.length >= limits.maxQueuedFrames ||
      epoch.queuedBytes + frame.byteLength > limits.maxQueuedBytes
    )
      return false;
    epoch.queue.push({
      frame,
      failure,
      valid,
      deadline: Date.now() + limits.writeTimeoutMs,
    });
    epoch.queuedBytes += frame.byteLength;
    if (epoch.writing) return true;
    epoch.writing = true;
    try {
      while (epoch.queue.length && this.current(epoch)) {
        const entry = epoch.queue.shift();
        if (!entry) break;
        epoch.queuedBytes -= entry.frame.byteLength;
        if (!entry.valid()) {
          entry.failure();
          continue;
        }
        if (Date.now() >= entry.deadline) {
          entry.failure();
          this.fail(new SandboxChannelError("unavailable"));
          break;
        }
        if (!this.transport.send(entry.frame)) entry.failure();
      }
    } finally {
      epoch.writing = false;
    }
    return this.current(epoch);
  }
}

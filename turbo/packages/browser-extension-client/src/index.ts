/** Native browser control over an existing, caller-owned CDP connection. */
export const BRIDGE_NAME = "__okouBrowser";
export const EVENT_BINDING = "__okouBrowserEvent";
export const PROTOCOL_VERSION = 1;

export interface NativeTab {
  readonly id: number;
  readonly windowId: number;
  readonly index: number;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly discarded: boolean;
  readonly url?: string;
  readonly pendingUrl?: string;
  readonly title?: string;
  readonly openerTabId?: number;
}

export interface NativeWindow {
  readonly id: number;
  readonly focused: boolean;
  readonly type?: string;
  readonly state?: string;
  readonly tabs?: readonly NativeTab[];
}

export interface ProbeEvidence {
  readonly tabId: number;
  readonly windowId: number;
  readonly documentId?: string;
}

export interface Operations {
  hello: {
    args: Record<string, never>;
    result: { protocol: number; capabilities: readonly string[] };
  };
  getWindow: {
    args: { windowId: number; populate?: boolean };
    result: NativeWindow | null;
  };
  listWindows: {
    args: { populate?: boolean };
    result: readonly NativeWindow[];
  };
  listTabs: { args: { windowId: number }; result: readonly NativeTab[] };
  getTab: { args: { tabId: number }; result: NativeTab | null };
  createTab: {
    args: { windowId?: number; url: string; active?: boolean };
    result: NativeTab;
  };
  moveTabs: {
    args: { tabIds: readonly number[]; windowId: number; index: number };
    result: readonly NativeTab[];
  };
  activateTab: { args: { tabId: number }; result: NativeTab };
  closeTab: { args: { tabId: number }; result: null };
  closeWindow: { args: { windowId: number }; result: null };
  beginProbe: { args: { nonce: string }; result: null };
  takeProbe: { args: { nonce: string }; result: ProbeEvidence | null };
  cancelProbe: { args: { nonce: string }; result: null };
}

export type BridgeRequest = {
  [M in keyof Operations]: { method: M } & Operations[M]["args"];
}[keyof Operations];

export interface Observation<T> {
  readonly epoch: string;
  /** An intervening native invalidation requires the caller to refresh. */
  readonly startedSequence: number;
  readonly sequence: number;
  readonly value: T;
}

export interface NativeEvent {
  readonly epoch: string;
  readonly sequence: number;
  readonly kind: string;
  readonly tabId?: number;
  readonly windowId?: number;
  readonly oldWindowId?: number;
  readonly removedTabId?: number;
}

export interface CdpEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface CdpTransport {
  /** The caller owns request IDs, IO deadlines and the underlying connection. */
  readonly request: (
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ) => Promise<unknown>;
  readonly onEvent: (listener: (event: CdpEvent) => void) => () => void;
}

export interface TargetIdentity extends ProbeEvidence {
  readonly targetId: string;
  readonly frameId: string;
  readonly loaderId: string;
  readonly epoch: string;
}

export type BridgeStage =
  | "attach-browser"
  | "discover-targets"
  | "list-targets"
  | "start-worker"
  | "enable-runtime"
  | "bind-events"
  | "hello"
  | "ready";

export type BridgeFailureReason =
  | "bootstrap-failed"
  | "cdp-request-failed"
  | "cdp-connection-failed"
  | "cdp-protocol-failed"
  | "invalid-response"
  | "worker-unobserved"
  | "worker-readiness-timeout"
  | "bridge-missing"
  | "protocol-mismatch"
  | "capability-missing"
  | "native-operation-failed"
  | "closed"
  | "browser-session-detached"
  | "worker-crashed"
  | "worker-detached"
  | "worker-context-cleared"
  | "worker-target-destroyed"
  | "worker-session-detached"
  | "worker-target-replaced"
  | "binding-malformed"
  | "bootstrap-event-overflow"
  | "epoch-changed"
  | "sequence-gap"
  | "response-sequence-ahead";

type BridgeCdpMethod =
  | "Target.attachToBrowserTarget"
  | "Target.attachToTarget"
  | "Target.setDiscoverTargets"
  | "Target.getTargets"
  | "ServiceWorker.enable"
  | "Extensions.triggerAction"
  | "Runtime.enable"
  | "Runtime.addBinding"
  | "Runtime.evaluate";

/** Only observations selected by this client; never transport messages or IDs. */
export interface BridgeDiagnostics {
  readonly stage?: BridgeStage;
  readonly reason: BridgeFailureReason;
  readonly request?: {
    readonly method: BridgeCdpMethod;
    readonly code?: number;
  };
}

export class BrowserBridgeError extends Error {
  readonly kind: "unavailable" | "protocol" | "native";
  readonly diagnostics: BridgeDiagnostics;

  constructor(
    kind: BrowserBridgeError["kind"],
    diagnostics: BridgeDiagnostics = {
      reason: kind === "protocol" ? "invalid-response" : "closed",
    },
  ) {
    const message =
      kind === "unavailable"
        ? "The Okou Browser bridge is unavailable."
        : kind === "native"
          ? "The native browser operation failed; its outcome may be uncertain."
          : "The Okou Browser bridge returned an invalid response.";
    const context = [
      `reason=${diagnostics.reason}`,
      ...(diagnostics.stage ? [`stage=${diagnostics.stage}`] : []),
      ...(diagnostics.request ? [`method=${diagnostics.request.method}`] : []),
      ...(diagnostics.request?.code !== undefined
        ? [`code=${diagnostics.request.code}`]
        : []),
    ].join(", ");
    // Linked-error reporters retain Error.message even when custom fields are omitted.
    super(`${message} (${context})`);
    this.name = "BrowserBridgeError";
    this.kind = kind;
    this.diagnostics = Object.freeze({
      ...diagnostics,
      ...(diagnostics.request
        ? { request: Object.freeze({ ...diagnostics.request }) }
        : {}),
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BrowserBridgeError("protocol");
  return value as Record<string, unknown>;
}

function session(value: unknown): string {
  const id = record(value).sessionId;
  if (typeof id !== "string" || !id) throw new BrowserBridgeError("protocol");
  return id;
}

interface Target {
  targetId: string;
  type: string;
  url: string;
}

interface ReadinessObserver {
  readonly targetId: string;
  sessionId?: string;
  lost: boolean;
}

/** Each client owns only its CDP sessions; closing it never closes a tab. */
export class OkouBrowserClient {
  /** Unexpected loss retains a safe BrowserBridgeError; intentional close cancels. */
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private readonly transport: CdpTransport;
  private readonly runtimeId: string;
  private readonly unsubscribe: () => void;
  private readonly releaseOwner: () => void;
  private readonly listeners = new Set<(event: NativeEvent) => void>();
  private readonly pages = new Set<string>();
  private browserSession: string | undefined;
  private readinessObserver: ReadinessObserver | undefined;
  private observingReadiness = false;
  private workerSession: string | undefined;
  private workerTarget: Target | undefined;
  private workerChanged: (() => void) | undefined;
  private epoch: string | undefined;
  private sequence: number | undefined;
  private readonly bootstrapEvents: NativeEvent[] = [];
  private workerAlive = true;
  private closing: Promise<void> | undefined;
  private stage: BridgeStage = "attach-browser";

  private constructor(
    transport: CdpTransport,
    runtimeId: string,
    ownerSignal?: AbortSignal,
  ) {
    this.transport = transport;
    this.runtimeId = runtimeId;
    this.signal = this.lifetime.signal;
    this.unsubscribe = transport.onEvent((event) => {
      return this.event(event);
    });
    const abort = () => {
      return void this.close();
    };
    ownerSignal?.addEventListener("abort", abort, { once: true });
    this.releaseOwner = () => {
      return ownerSignal?.removeEventListener("abort", abort);
    };
    if (ownerSignal?.aborted) abort();
  }

  static async connect(options: {
    transport: CdpTransport;
    /** Chrome runtime ID, not the provider's uploaded-extension UUID. */
    runtimeId: string;
    signal?: AbortSignal;
    readinessTimeoutMs?: number;
    /** Wake the known Okou extension; stopped workers may retain a CDP target. */
    wakeWorker?: boolean;
  }): Promise<OkouBrowserClient> {
    const client = new OkouBrowserClient(
      options.transport,
      options.runtimeId,
      options.signal,
    );
    try {
      await client.initialize(
        options.readinessTimeoutMs ?? 10_000,
        options.wakeWorker ?? true,
      );
      return client;
    } catch (error) {
      const reason: unknown = client.signal.aborted
        ? client.signal.reason
        : error;
      const failure =
        reason instanceof BrowserBridgeError
          ? reason.diagnostics.stage
            ? reason
            : new BrowserBridgeError(reason.kind, {
                ...reason.diagnostics,
                stage: client.stage,
              })
          : client.failure(
              "unavailable",
              client.signal.aborted ? "closed" : "bootstrap-failed",
            );
      await client.close(failure);
      throw failure;
    }
  }

  private current(): void {
    if (this.signal.aborted) {
      const reason: unknown = this.signal.reason;
      throw reason instanceof BrowserBridgeError
        ? reason
        : this.failure("unavailable", "closed");
    }
  }

  private failure(
    kind: BrowserBridgeError["kind"],
    reason: BridgeFailureReason,
    request?: BridgeDiagnostics["request"],
  ): BrowserBridgeError {
    return new BrowserBridgeError(kind, {
      stage: this.stage,
      reason,
      ...(request ? { request } : {}),
    });
  }

  private invalidate(reason: BridgeFailureReason): void {
    void this.close(this.failure("unavailable", reason));
  }

  private async request(
    method: BridgeCdpMethod,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
    kind: BrowserBridgeError["kind"] = "unavailable",
  ): Promise<unknown> {
    try {
      return await this.transport.request(method, params, sessionId);
    } catch (error) {
      this.current();
      const code =
        error instanceof Error && "code" in error ? error.code : undefined;
      const observedKind =
        error instanceof Error && "kind" in error ? error.kind : undefined;
      throw this.failure(
        kind,
        observedKind === "connection"
          ? "cdp-connection-failed"
          : observedKind === "protocol"
            ? "cdp-protocol-failed"
            : "cdp-request-failed",
        {
          method,
          ...(typeof code === "number" && Number.isSafeInteger(code)
            ? { code }
            : {}),
        },
      );
    }
  }

  private workerUrl(value: unknown): boolean {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "chrome-extension:" && url.hostname === this.runtimeId
      );
    } catch {
      return false;
    }
  }

  private worker(info: unknown): Target | undefined {
    if (!info || typeof info !== "object" || Array.isArray(info))
      return undefined;
    const target = info as Record<string, unknown>;
    if (
      target.type !== "service_worker" ||
      typeof target.targetId !== "string" ||
      typeof target.url !== "string"
    )
      return undefined;
    return this.workerUrl(target.url)
      ? { targetId: target.targetId, type: target.type, url: target.url }
      : undefined;
  }

  private async attach(
    kind: "browser" | "worker" | "page",
    targetId?: string,
  ): Promise<string> {
    this.current();
    const parent = kind === "browser" ? undefined : this.browserSession;
    const id = session(
      await this.request(
        kind === "browser"
          ? "Target.attachToBrowserTarget"
          : "Target.attachToTarget",
        kind === "browser" ? {} : { targetId, flatten: true },
        parent,
      ),
    );
    if (this.signal.aborted) {
      await this.detach(id, parent);
      this.current();
    }
    if (kind === "browser") this.browserSession = id;
    else if (kind === "worker") this.workerSession = id;
    else this.pages.add(id);
    return id;
  }

  private async initialize(
    timeoutMs: number,
    wakeWorker: boolean,
  ): Promise<void> {
    await this.attach("browser");
    this.current();
    this.stage = "discover-targets";
    await this.request(
      "Target.setDiscoverTargets",
      { discover: true, filter: [{ exclude: false }] },
      this.browserSession,
    );
    this.current();
    this.stage = "list-targets";
    const targets = await this.listTargets();
    for (const info of targets) this.workerTarget ??= this.worker(info);
    this.stage = "start-worker";
    const worker = await this.startWorker(targets, timeoutMs, wakeWorker);
    this.current();
    this.stage = "enable-runtime";
    await this.request("Runtime.enable", {}, worker);
    this.current();
    this.stage = "bind-events";
    await this.request("Runtime.addBinding", { name: EVENT_BINDING }, worker);
    this.current();
    this.stage = "hello";
    const hello = await this.call("hello", {});
    if (hello.value.protocol !== PROTOCOL_VERSION)
      throw this.failure("unavailable", "protocol-mismatch");
    if (
      !["windows", "tabs", "events"].every((capability) => {
        return hello.value.capabilities.includes(capability);
      })
    )
      throw this.failure("unavailable", "capability-missing");
    this.epoch = hello.epoch;
    this.sequence = hello.sequence;
    for (const event of this.bootstrapEvents.splice(0)) this.acceptEvent(event);
    this.current();
    this.stage = "ready";
  }

  private async listTargets(): Promise<unknown[]> {
    const result = record(
      await this.request(
        "Target.getTargets",
        { filter: [{ exclude: false }] },
        this.browserSession,
      ),
    );
    this.current();
    if (!Array.isArray(result.targetInfos))
      throw new BrowserBridgeError("protocol");
    return result.targetInfos;
  }

  private async startWorker(
    targets: unknown[],
    timeoutMs: number,
    wakeWorker: boolean,
  ): Promise<string> {
    const browser = this.browserSession;
    let woken = false;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => {
      this.invalidate("worker-readiness-timeout");
    }, timeoutMs);
    try {
      for (;;) {
        this.current();
        if (performance.now() >= deadline)
          throw this.failure("unavailable", "worker-readiness-timeout");
        const observer = this.observePage(targets);
        let replacementTargets: unknown[] | undefined;
        try {
          if (observer) {
            replacementTargets = await this.enableReadiness(observer);
            this.current();
          }
          if (!observer?.lost) {
            const tab = targets.find((info) => {
              return record(info).type === "tab";
            });
            if (wakeWorker && tab && !woken) {
              // Wake once; observer recovery never replays an uncertain action.
              woken = true;
              await this.request(
                "Extensions.triggerAction",
                { id: this.runtimeId, targetId: record(tab).targetId },
                browser,
              );
              this.current();
            }
            if (!this.workerTarget && !observer && (!wakeWorker || !tab))
              throw this.failure("unavailable", "worker-unobserved");
            await this.waitForWorker(observer);
            this.current();
            if (!observer?.lost) break;
          }
        } finally {
          // Retire before detach: its late events cannot affect the next owner.
          this.readinessObserver = undefined;
          const session = observer?.sessionId;
          if (session && this.pages.delete(session))
            await this.detach(session, browser);
        }
        targets = replacementTargets ?? (await this.listTargets());
      }
      this.current();
      if (!this.workerTarget)
        throw this.failure("unavailable", "worker-unobserved");
      return await this.attach("worker", this.workerTarget.targetId);
    } finally {
      clearTimeout(timer);
      this.observingReadiness = false;
    }
  }

  private observePage(targets: unknown[]): ReadinessObserver | undefined {
    const page = targets.find((info) => {
      return record(info).type === "page";
    });
    if (!page) {
      // Target discovery cannot substitute for a lost native observer.
      if (this.observingReadiness)
        throw this.failure("unavailable", "worker-unobserved");
      return;
    }
    const id = record(page).targetId;
    if (typeof id !== "string") throw new BrowserBridgeError("protocol");
    const observer = { targetId: id, lost: false };
    this.readinessObserver = observer;
    this.observingReadiness = true;
    // Retained targets and Runtime contexts can precede module evaluation.
    // Each observer must supply its own native running status.
    this.workerTarget = undefined;
    return observer;
  }

  private async enableReadiness(
    observer: ReadinessObserver,
  ): Promise<unknown[] | undefined> {
    try {
      observer.sessionId = await this.attach("page", observer.targetId);
      this.current();
      if (!observer.lost)
        await this.request("ServiceWorker.enable", {}, observer.sessionId);
    } catch (error) {
      this.current();
      if (
        !(error instanceof BrowserBridgeError) ||
        error.diagnostics.reason !== "cdp-request-failed"
      )
        throw error;
      if (!observer.lost) {
        // The target may have vanished before this observer existed.
        // A command error alone is never proof that retry is safe.
        const targets = await this.listTargets();
        if (
          targets.some((info) => {
            return record(info).targetId === observer.targetId;
          })
        )
          throw error;
        observer.lost = true;
        this.workerTarget = undefined;
        return targets;
      }
    }
    return undefined;
  }

  private async waitForWorker(observer?: ReadinessObserver): Promise<void> {
    if (this.workerTarget || observer?.lost) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.workerChanged = undefined;
        this.signal.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        finish();
        reject(this.signal.reason);
      };
      this.workerChanged = () => {
        finish();
        resolve();
      };
      this.signal.addEventListener("abort", aborted, { once: true });
    });
  }

  private event(event: CdpEvent): void {
    if (this.signal.aborted) return;
    this.readinessEvent(event);
    if (this.signal.aborted) return;
    this.lifecycleEvent(event);
    if (!this.signal.aborted) this.bindingEvent(event);
  }

  private readinessEvent(event: CdpEvent): void {
    const observer = this.readinessObserver;
    if (!observer || observer.lost) return;
    if (this.readinessLost(event, observer)) {
      observer.lost = true;
      this.workerTarget = undefined;
      this.workerChanged?.();
      return;
    }
    if (
      !observer.sessionId ||
      event.sessionId !== observer.sessionId ||
      event.method !== "ServiceWorker.workerVersionUpdated" ||
      !Array.isArray(event.params.versions)
    )
      return;
    for (const info of event.params.versions) {
      if (!info || typeof info !== "object" || Array.isArray(info)) continue;
      const version = info as Record<string, unknown>;
      if (!this.workerUrl(version.scriptURL)) continue;
      const target =
        version.runningStatus === "running"
          ? this.worker({
              type: "service_worker",
              url: version.scriptURL,
              targetId: version.targetId,
            })
          : undefined;
      this.workerTarget = target;
      if (target) this.workerChanged?.();
    }
  }

  private readinessLost(event: CdpEvent, observer: ReadinessObserver): boolean {
    if (event.sessionId !== this.browserSession) return false;
    if (event.method === "Target.targetDestroyed")
      return event.params.targetId === observer.targetId;
    return (
      event.method === "Target.detachedFromTarget" &&
      observer.sessionId !== undefined &&
      event.params.sessionId === observer.sessionId
    );
  }

  private lifecycleEvent(event: CdpEvent): void {
    if (
      this.browserSession &&
      event.method === "Target.detachedFromTarget" &&
      event.params.sessionId === this.browserSession
    ) {
      this.workerAlive = false;
      this.invalidate("browser-session-detached");
      return;
    }
    if (
      event.sessionId === this.workerSession &&
      (event.method === "Inspector.targetCrashed" ||
        event.method === "Inspector.detached" ||
        event.method === "Runtime.executionContextsCleared")
    ) {
      this.workerAlive = false;
      this.invalidate(
        event.method === "Inspector.targetCrashed"
          ? "worker-crashed"
          : event.method === "Inspector.detached"
            ? "worker-detached"
            : "worker-context-cleared",
      );
      return;
    }
    if (event.sessionId === this.browserSession) {
      if (event.method === "Target.targetCreated") {
        this.workerCreated(event.params.targetInfo);
      } else if (
        (event.method === "Target.targetDestroyed" &&
          event.params.targetId === this.workerTarget?.targetId) ||
        (event.method === "Target.detachedFromTarget" &&
          event.params.sessionId === this.workerSession)
      ) {
        this.invalidate(
          event.method === "Target.targetDestroyed"
            ? "worker-target-destroyed"
            : "worker-session-detached",
        );
      }
    }
  }

  private workerCreated(info: unknown): void {
    if (this.observingReadiness) return;
    const target = this.worker(info);
    if (!target) return;
    if (this.workerSession && target.targetId !== this.workerTarget?.targetId) {
      this.workerAlive = false;
      this.invalidate("worker-target-replaced");
      return;
    }
    this.workerTarget = target;
    this.workerChanged?.();
  }

  private bindingEvent(event: CdpEvent): void {
    if (
      event.sessionId !== this.workerSession ||
      event.method !== "Runtime.bindingCalled" ||
      event.params.name !== EVENT_BINDING
    )
      return;
    if (typeof event.params.payload !== "string") {
      this.invalidate("binding-malformed");
      return;
    }
    try {
      const value = record(JSON.parse(event.params.payload));
      if (
        typeof value.epoch !== "string" ||
        !Number.isSafeInteger(value.sequence) ||
        (value.sequence as number) < 0 ||
        typeof value.kind !== "string" ||
        !value.kind
      ) {
        this.invalidate("binding-malformed");
        return;
      }
      const native = value as unknown as NativeEvent;
      if (this.sequence === undefined) {
        if (this.bootstrapEvents.length >= 256)
          this.invalidate("bootstrap-event-overflow");
        else this.bootstrapEvents.push(native);
      } else {
        this.acceptEvent(native);
      }
    } catch {
      // A malformed event on our owned binding cannot retain inventory authority.
      this.invalidate("binding-malformed");
    }
  }

  private acceptEvent(event: NativeEvent): void {
    if (this.signal.aborted) return;
    if (event.epoch !== this.epoch) {
      this.invalidate("epoch-changed");
      return;
    }
    if (event.sequence <= this.sequence!) return;
    if (event.sequence !== this.sequence! + 1) {
      this.invalidate("sequence-gap");
      return;
    }
    this.sequence = event.sequence;
    // Reentrant subscriptions cannot extend an in-flight dispatch.
    const observers = [...this.listeners];
    for (const listener of observers) {
      if (!this.listeners.has(listener)) continue;
      try {
        listener(event);
      } catch {
        // A consumer observer cannot interrupt the owning transport.
      }
    }
  }

  onEvent(listener: (event: NativeEvent) => void): () => void {
    this.current();
    this.listeners.add(listener);
    return () => {
      return this.listeners.delete(listener);
    };
  }

  async call<M extends keyof Operations>(
    method: M,
    args: Operations[M]["args"],
  ): Promise<Observation<Operations[M]["result"]>> {
    this.current();
    if (!this.workerSession)
      throw this.failure("unavailable", "worker-unobserved");
    const response = await this.request(
      "Runtime.evaluate",
      {
        expression: `globalThis.${BRIDGE_NAME}?.invoke(${JSON.stringify({ method, ...args })})`,
        awaitPromise: true,
        returnByValue: true,
      },
      this.workerSession,
      "native",
    );
    this.current();
    const result = record(response);
    if (result.exceptionDetails)
      throw this.failure("native", "native-operation-failed");
    const remote = record(result.result);
    if (method === "hello" && remote.type === "undefined")
      throw this.failure("unavailable", "bridge-missing");
    const value = record(remote.value);
    if (this.epoch !== undefined && this.epoch !== value.epoch) {
      this.invalidate("epoch-changed");
      this.current();
    }
    if (
      (value.ok !== true && value.ok !== false) ||
      typeof value.epoch !== "string" ||
      !Number.isSafeInteger(value.startedSequence) ||
      !Number.isSafeInteger(value.sequence) ||
      (value.startedSequence as number) < 0 ||
      (value.sequence as number) < (value.startedSequence as number)
    )
      throw this.failure("protocol", "invalid-response");
    // A response cannot repair a missed event. Native binding notifications
    // precede their operation response on the same ordered worker session.
    if (
      this.sequence !== undefined &&
      (value.sequence as number) > this.sequence
    ) {
      this.invalidate("response-sequence-ahead");
      this.current();
    }
    if (value.ok === false)
      throw this.failure("native", "native-operation-failed");
    return value as unknown as Observation<Operations[M]["result"]>;
  }

  /** Read-only correlation; unavailable contexts return null, never guessed IDs. */
  async identifyTarget(targetId: string): Promise<TargetIdentity | null> {
    const pageSession = await this.attach("page", targetId);
    const nonce = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => {
        return byte.toString(16).padStart(2, "0");
      },
    ).join("");
    const browserSession = this.browserSession;
    const frame = async () => {
      const tree = record(
        await this.transport.request("Page.getFrameTree", {}, pageSession),
      );
      return record(record(tree.frameTree).frame);
    };
    const window = async () => {
      return record(
        await this.transport.request(
          "Browser.getWindowForTarget",
          { targetId },
          browserSession,
        ),
      ).windowId;
    };
    try {
      const before = await frame();
      const beforeWindow = await window();
      await this.call("beginProbe", { nonce });
      await this.transport.request(
        "Runtime.evaluate",
        {
          expression: `new Promise(resolve => { const runtime = globalThis.chrome?.runtime; if (!runtime?.sendMessage) return resolve(false); runtime.sendMessage(${JSON.stringify(this.runtimeId)}, {kind: "okou-browser-identify", nonce: ${JSON.stringify(nonce)}}, () => resolve(!runtime.lastError)); })`,
          awaitPromise: true,
          returnByValue: true,
        },
        pageSession,
      );
      const evidence = (await this.call("takeProbe", { nonce })).value;
      const after = await frame();
      const afterWindow = await window();
      this.current();
      if (
        !evidence ||
        before.id !== after.id ||
        before.loaderId !== after.loaderId ||
        beforeWindow !== afterWindow ||
        evidence.windowId !== afterWindow ||
        typeof after.id !== "string" ||
        typeof after.loaderId !== "string" ||
        !this.epoch
      )
        return null;
      return {
        ...evidence,
        targetId,
        frameId: after.id,
        loaderId: after.loaderId,
        epoch: this.epoch,
      };
    } finally {
      if (!this.signal.aborted)
        await this.call("cancelProbe", { nonce }).catch(() => {});
      if (this.pages.delete(pageSession))
        await this.detach(pageSession, browserSession);
    }
  }

  private async detach(id: string, parent?: string): Promise<void> {
    await this.transport
      .request("Target.detachFromTarget", { sessionId: id }, parent)
      .catch(() => {});
  }

  close(reason?: BrowserBridgeError): Promise<void> {
    if (this.closing) return this.closing;
    const browser = this.browserSession;
    const worker = this.workerSession;
    const pages = [...this.pages];
    this.browserSession = undefined;
    this.workerSession = undefined;
    this.pages.clear();
    // Publish the completion before abort observers can re-enter close().
    this.closing = Promise.resolve().then(async () => {
      if (worker && this.workerAlive) {
        await this.transport
          .request("Runtime.removeBinding", { name: EVENT_BINDING }, worker)
          .catch(() => {});
      }
      if (worker) await this.detach(worker, browser);
      await Promise.all(
        pages.map((id) => {
          return this.detach(id, browser);
        }),
      );
      if (browser) await this.detach(browser);
    });
    this.lifetime.abort(reason);
    this.unsubscribe();
    this.releaseOwner();
    this.listeners.clear();
    return this.closing;
  }
}

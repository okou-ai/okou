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

export class BrowserBridgeError extends Error {
  readonly kind: "unavailable" | "protocol" | "native";

  constructor(kind: BrowserBridgeError["kind"]) {
    super(
      kind === "unavailable"
        ? "The Okou Browser bridge is unavailable."
        : kind === "native"
          ? "The native browser operation failed; its outcome may be uncertain."
          : "The Okou Browser bridge returned an invalid response.",
    );
    this.name = "BrowserBridgeError";
    this.kind = kind;
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

/** Each client owns only its CDP sessions; closing it never closes a tab. */
export class OkouBrowserClient {
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private readonly transport: CdpTransport;
  private readonly runtimeId: string;
  private readonly unsubscribe: () => void;
  private readonly releaseOwner: () => void;
  private readonly listeners = new Set<(event: NativeEvent) => void>();
  private readonly pages = new Set<string>();
  private browserSession: string | undefined;
  private readinessSession: string | undefined;
  private workerSession: string | undefined;
  private workerTarget: Target | undefined;
  private workerChanged: (() => void) | undefined;
  private epoch: string | undefined;
  private sequence: number | undefined;
  private readonly bootstrapEvents: NativeEvent[] = [];
  private workerAlive = true;
  private closing: Promise<void> | undefined;

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
      await client.close();
      throw error instanceof BrowserBridgeError
        ? error
        : new BrowserBridgeError("unavailable");
    }
  }

  private current(): void {
    if (this.signal.aborted) throw new BrowserBridgeError("unavailable");
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
      await this.transport.request(
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
    await this.transport.request(
      "Target.setDiscoverTargets",
      { discover: true, filter: [{ exclude: false }] },
      this.browserSession,
    );
    this.current();
    const result = record(
      await this.transport.request(
        "Target.getTargets",
        { filter: [{ exclude: false }] },
        this.browserSession,
      ),
    );
    this.current();
    if (!Array.isArray(result.targetInfos))
      throw new BrowserBridgeError("protocol");
    for (const info of result.targetInfos)
      this.workerTarget ??= this.worker(info);
    const worker = await this.startWorker(
      result.targetInfos,
      timeoutMs,
      wakeWorker,
    );
    this.current();
    await this.transport.request("Runtime.enable", {}, worker);
    this.current();
    await this.transport.request(
      "Runtime.addBinding",
      { name: EVENT_BINDING },
      worker,
    );
    this.current();
    const hello = await this.call("hello", {});
    if (hello.value.protocol !== PROTOCOL_VERSION)
      throw new BrowserBridgeError("unavailable");
    if (
      !["windows", "tabs", "events"].every((capability) => {
        return hello.value.capabilities.includes(capability);
      })
    )
      throw new BrowserBridgeError("unavailable");
    this.epoch = hello.epoch;
    this.sequence = hello.sequence;
    for (const event of this.bootstrapEvents.splice(0)) this.acceptEvent(event);
    this.current();
  }

  private async startWorker(
    targets: unknown[],
    timeoutMs: number,
    wakeWorker: boolean,
  ): Promise<string> {
    const tab = targets.find((info) => {
      return record(info).type === "tab";
    });
    const page = targets.find((info) => {
      return record(info).type === "page";
    });
    const browser = this.browserSession;
    try {
      if (page) {
        const id = record(page).targetId;
        if (typeof id !== "string") throw new BrowserBridgeError("protocol");
        this.readinessSession = await this.attach("page", id);
        this.current();
        // A retained target and even a new Runtime context can precede module
        // evaluation. Native running status is published after script startup.
        this.workerTarget = undefined;
        await this.transport.request(
          "ServiceWorker.enable",
          {},
          this.readinessSession,
        );
        this.current();
      }
      if (wakeWorker && tab) {
        await this.transport.request(
          "Extensions.triggerAction",
          { id: this.runtimeId, targetId: record(tab).targetId },
          browser,
        );
        this.current();
      }
      if (!this.workerTarget && !this.readinessSession && (!wakeWorker || !tab))
        throw new BrowserBridgeError("unavailable");
      if (!this.workerTarget) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            this.workerChanged = undefined;
            this.signal.removeEventListener("abort", aborted);
          };
          const aborted = () => {
            finish();
            reject(new BrowserBridgeError("unavailable"));
          };
          const timer = setTimeout(aborted, timeoutMs);
          this.workerChanged = () => {
            finish();
            resolve();
          };
          this.signal.addEventListener("abort", aborted, { once: true });
        });
      }
      this.current();
      if (!this.workerTarget) throw new BrowserBridgeError("unavailable");
      return await this.attach("worker", this.workerTarget.targetId);
    } finally {
      const page = this.readinessSession;
      this.readinessSession = undefined;
      if (page && this.pages.delete(page)) await this.detach(page, browser);
    }
  }

  private event(event: CdpEvent): void {
    if (this.signal.aborted) return;
    this.readinessEvent(event);
    if (this.signal.aborted) return;
    this.lifecycleEvent(event);
    if (!this.signal.aborted) this.bindingEvent(event);
  }

  private readinessEvent(event: CdpEvent): void {
    if (!this.readinessSession) return;
    if (
      event.sessionId === this.browserSession &&
      event.method === "Target.detachedFromTarget" &&
      event.params.sessionId === this.readinessSession
    ) {
      void this.close();
      return;
    }
    if (
      event.sessionId !== this.readinessSession ||
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
      if (
        this.workerSession &&
        target?.targetId !== this.workerTarget?.targetId
      ) {
        this.workerAlive = false;
        void this.close();
        return;
      }
      this.workerTarget = target;
      if (target) this.workerChanged?.();
    }
  }

  private lifecycleEvent(event: CdpEvent): void {
    if (
      this.browserSession &&
      event.method === "Target.detachedFromTarget" &&
      event.params.sessionId === this.browserSession
    ) {
      this.workerAlive = false;
      void this.close();
      return;
    }
    if (
      event.sessionId === this.workerSession &&
      (event.method === "Inspector.targetCrashed" ||
        event.method === "Inspector.detached" ||
        event.method === "Runtime.executionContextsCleared")
    ) {
      this.workerAlive = false;
      void this.close();
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
        void this.close();
      }
    }
  }

  private workerCreated(info: unknown): void {
    if (this.readinessSession) return;
    const target = this.worker(info);
    if (!target) return;
    if (this.workerSession && target.targetId !== this.workerTarget?.targetId) {
      this.workerAlive = false;
      void this.close();
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
      void this.close();
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
        void this.close();
        return;
      }
      const native = value as unknown as NativeEvent;
      if (this.sequence === undefined) {
        if (this.bootstrapEvents.length >= 256) void this.close();
        else this.bootstrapEvents.push(native);
      } else {
        this.acceptEvent(native);
      }
    } catch {
      // A malformed event on our owned binding cannot retain inventory authority.
      void this.close();
    }
  }

  private acceptEvent(event: NativeEvent): void {
    if (this.signal.aborted) return;
    if (event.epoch !== this.epoch) {
      void this.close();
      return;
    }
    if (event.sequence <= this.sequence!) return;
    if (event.sequence !== this.sequence! + 1) {
      void this.close();
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
    if (!this.workerSession) throw new BrowserBridgeError("unavailable");
    let response: unknown;
    try {
      response = await this.transport.request(
        "Runtime.evaluate",
        {
          expression: `globalThis.${BRIDGE_NAME}?.invoke(${JSON.stringify({ method, ...args })})`,
          awaitPromise: true,
          returnByValue: true,
        },
        this.workerSession,
      );
    } catch {
      this.current();
      throw new BrowserBridgeError("native");
    }
    const result = record(response);
    this.current();
    if (result.exceptionDetails) throw new BrowserBridgeError("native");
    const remote = record(result.result);
    if (method === "hello" && remote.type === "undefined")
      throw new BrowserBridgeError("unavailable");
    const value = record(remote.value);
    if (this.epoch !== undefined && this.epoch !== value.epoch) {
      void this.close();
      throw new BrowserBridgeError("unavailable");
    }
    if (
      (value.ok !== true && value.ok !== false) ||
      typeof value.epoch !== "string" ||
      !Number.isSafeInteger(value.startedSequence) ||
      !Number.isSafeInteger(value.sequence) ||
      (value.startedSequence as number) < 0 ||
      (value.sequence as number) < (value.startedSequence as number)
    )
      throw new BrowserBridgeError("protocol");
    // A response cannot repair a missed event. Native binding notifications
    // precede their operation response on the same ordered worker session.
    if (
      this.sequence !== undefined &&
      (value.sequence as number) > this.sequence
    ) {
      void this.close();
      throw new BrowserBridgeError("unavailable");
    }
    if (value.ok === false) throw new BrowserBridgeError("native");
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

  close(): Promise<void> {
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
    this.lifetime.abort();
    this.unsubscribe();
    this.releaseOwner();
    this.listeners.clear();
    return this.closing;
  }
}

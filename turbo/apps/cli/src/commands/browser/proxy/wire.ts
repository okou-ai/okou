import type { CdpEvent, CdpTransport } from "@okouai/browser-extension-client";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ProtocolError extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super("Browser protocol operation failed");
  }
}

export function scopedError(message: string): ProtocolError {
  return new ProtocolError({ code: -32000, message });
}

interface ControlRequest {
  readonly kind: "control";
  readonly sessionId: string | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  expired: boolean;
}
interface PeerRequest {
  readonly kind: "peer";
  readonly peer: PeerWire;
  readonly id: number;
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly parent: string;
}
interface LifetimeRequest {
  readonly kind: "lifetime";
  readonly peer: PeerWire;
}
interface DetachRequest {
  readonly kind: "detach";
  readonly timer: ReturnType<typeof setTimeout>;
}

type PeerLifetime =
  | { readonly kind: "acquiring" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "attached"; readonly root: string }
  | { readonly kind: "releasing"; readonly root: string }
  | { readonly kind: "retired" };

/** Own the native root from acquisition through confirmed retirement. */
export class PeerWire {
  private readonly messages = new Set<
    (message: Record<string, unknown>, raw: string) => void
  >();
  private readonly closing = new Set<() => void>();
  private lifetime: PeerLifetime = { kind: "acquiring" };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolveOpened!: () => void;
  private rejectOpened!: (error: Error) => void;
  readonly opened: Promise<void>;

  constructor(private readonly owner: ControlWire) {
    this.opened = new Promise<void>((resolve, reject) => {
      this.resolveOpened = resolve;
      this.rejectOpened = reject;
    });
  }

  get closed(): boolean {
    return (
      this.lifetime.kind !== "acquiring" && this.lifetime.kind !== "attached"
    );
  }

  acquire(): void {
    this.deadline();
    this.owner.requestPeer(this, "Target.attachToBrowserTarget", {});
  }

  private deadline(): void {
    clearTimeout(this.timer);
    // An unknown native acquisition/release still belongs to this transport.
    this.timer = setTimeout(() => {
      this.owner.close();
    }, 15_000);
  }

  ownsRoot(id: string): boolean {
    return (
      (this.lifetime.kind === "attached" ||
        this.lifetime.kind === "releasing") &&
      this.lifetime.root === id
    );
  }

  confirm(message: Record<string, unknown>): void {
    if (this.lifetime.kind === "releasing") {
      if (record(message.error)) this.owner.close();
      else this.retire();
      return;
    }
    const cancelled = this.lifetime.kind === "cancelled";
    if (record(message.error)) {
      this.retire(new ProtocolError(message.error));
      return;
    }
    if (
      !record(message.result) ||
      typeof message.result.sessionId !== "string" ||
      !message.result.sessionId
    ) {
      this.owner.close();
      return;
    }
    const root = message.result.sessionId;
    this.lifetime = { kind: cancelled ? "releasing" : "attached", root };
    this.owner.admitPeer(this, root);
    if (cancelled) {
      this.deadline();
      this.owner.release(this, root);
    } else {
      clearTimeout(this.timer);
      this.resolveOpened();
    }
  }

  /** The caller supplies the already-authorized canonical channel. */
  send(raw: string, channel?: string): void {
    const message: unknown = JSON.parse(raw);
    if (
      !record(message) ||
      typeof message.id !== "number" ||
      typeof message.method !== "string"
    )
      throw new Error("Invalid Browser peer request");
    if (this.lifetime.kind !== "attached")
      throw new Error("Browser peer connection closed");
    this.owner.forward(
      this,
      this.lifetime.root,
      message.id,
      message.method,
      message,
      channel,
    );
  }

  onMessage(
    listener: (message: Record<string, unknown>, raw: string) => void,
  ): () => void {
    this.messages.add(listener);
    return () => {
      this.messages.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.closing.add(listener);
    return () => {
      this.closing.delete(listener);
    };
  }

  receive(
    message: Record<string, unknown>,
    raw = JSON.stringify(message),
  ): void {
    if (this.closed) return;
    const observers = [...this.messages];
    for (const listener of observers)
      if (this.messages.has(listener)) listener(message, raw);
  }

  close(): void {
    if (this.closed) return;
    const lifetime = this.lifetime;
    if (lifetime.kind === "acquiring") {
      // Keep the acquisition receipt and deadline after the caller leaves.
      this.lifetime = { kind: "cancelled" };
    } else if (lifetime.kind === "attached") {
      this.lifetime = { kind: "releasing", root: lifetime.root };
      this.deadline();
      this.owner.release(this, lifetime.root);
    }
    this.end();
  }

  retire(error = new Error("Browser peer connection closed")): void {
    if (this.lifetime.kind === "retired") return;
    this.lifetime = { kind: "retired" };
    clearTimeout(this.timer);
    this.owner.retirePeer(this);
    this.rejectOpened(error);
    this.end();
  }

  private end(): void {
    this.rejectOpened(new Error("Browser peer connection closed"));
    for (const listener of this.closing) listener();
    this.closing.clear();
    this.messages.clear();
  }
}

/** One Guest-owned provider socket; logical peers retain independent CDP roots. */
export class ControlWire implements CdpTransport {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    ControlRequest | PeerRequest | LifetimeRequest | DetachRequest
  >();
  private readonly peers = new Set<PeerWire>();
  private readonly sessions = new Map<
    string,
    { peer: PeerWire; parent: string | undefined }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private releaseOwner: (() => void) | undefined;
  private closed = false;

  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", ({ data }: { data: unknown }) => {
      if (typeof data !== "string") return this.close();
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return this.close();
      }
      if (!record(value)) return this.close();
      if (typeof value.id === "number") this.response(value.id, value);
      else if (typeof value.method === "string")
        this.event(value.method, value, data);
    });
    socket.addEventListener("close", () => {
      this.fail();
    });
    socket.addEventListener("error", () => {
      return this.close();
    });
  }

  private response(id: number, value: Record<string, unknown>): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.kind === "lifetime") {
      entry.peer.confirm(value);
    } else if (entry.kind === "detach") {
      clearTimeout(entry.timer);
      // An unconfirmed release can leave native selectors pausing future pages.
      if (record(value.error)) this.close();
    } else if (entry.kind === "control") {
      clearTimeout(entry.timer);
      if (entry.expired) {
        if (record(value.result) && typeof value.result.sessionId === "string")
          this.detach(value.result.sessionId, entry.sessionId);
      } else if (record(value.error))
        entry.reject(new ProtocolError(value.error));
      else entry.resolve(value.result);
    } else {
      if (
        (entry.method === "Target.attachToTarget" ||
          entry.method === "Target.attachToBrowserTarget") &&
        record(value.result) &&
        typeof value.result.sessionId === "string"
      )
        this.sessions.set(value.result.sessionId, {
          peer: entry.peer,
          parent: entry.parent,
        });
      entry.peer.receive({
        ...value,
        id: entry.id,
        sessionId: entry.sessionId,
      });
    }
  }

  private event(
    method: string,
    value: Record<string, unknown>,
    data: string,
  ): void {
    const channel =
      typeof value.sessionId === "string" ? value.sessionId : undefined;
    const params = record(value.params) ? value.params : {};
    const owner = channel ? this.sessions.get(channel) : undefined;
    if (owner) {
      if (
        value.method === "Target.attachedToTarget" &&
        typeof params.sessionId === "string"
      )
        this.sessions.set(params.sessionId, {
          peer: owner.peer,
          parent: channel,
        });
      if (channel && owner.peer.ownsRoot(channel))
        owner.peer.receive({ ...value, sessionId: undefined });
      else owner.peer.receive(value, data);
      if (
        value.method === "Target.detachedFromTarget" &&
        typeof params.sessionId === "string"
      )
        this.forget(params.sessionId);
      return;
    }
    if (
      value.method === "Target.detachedFromTarget" &&
      typeof params.sessionId === "string"
    ) {
      const detached = this.sessions.get(params.sessionId);
      if (detached?.peer.ownsRoot(params.sessionId)) {
        detached.peer.retire();
        return;
      }
    }
    const event: CdpEvent = {
      method,
      params,
      ...(typeof value.sessionId === "string"
        ? { sessionId: value.sessionId }
        : {}),
    };
    const observers = [...this.listeners];
    for (const listener of observers)
      if (this.listeners.has(listener)) listener(event);
  }

  static async connect(url: string, signal: AbortSignal): Promise<ControlWire> {
    signal.throwIfAborted();
    const socket = new WebSocket(url);
    const wire = new ControlWire(socket);
    const abort = () => {
      return wire.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    wire.releaseOwner = () => {
      return signal.removeEventListener("abort", abort);
    };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        wire.close();
        reject(new Error("Browser control connection timed out"));
      }, 15_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new Error("Browser control connection unavailable"));
        },
        { once: true },
      );
    });
    signal.throwIfAborted();
    return wire;
  }

  request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error("Browser control connection unavailable"),
      );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry?.kind === "control") {
          entry.expired = true;
          // A cancelled attachment still owns a late native session receipt.
          if (
            method !== "Target.attachToBrowserTarget" &&
            method !== "Target.attachToTarget"
          )
            this.pending.delete(id);
        }
        reject(new Error("Browser control operation timed out"));
      }, 15_000);
      this.pending.set(id, {
        kind: "control",
        sessionId,
        resolve,
        reject,
        timer,
        expired: false,
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Browser control connection unavailable"));
      }
    });
  }

  openPeer(): PeerWire {
    const peer = new PeerWire(this);
    this.peers.add(peer);
    if (this.closed) peer.retire();
    else peer.acquire();
    return peer;
  }

  requestPeer(
    peer: PeerWire,
    method: "Target.attachToBrowserTarget" | "Target.detachFromTarget",
    params: Record<string, unknown>,
  ): void {
    const id = ++this.nextId;
    this.pending.set(id, { kind: "lifetime", peer });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch {
      this.close();
    }
  }

  admitPeer(peer: PeerWire, root: string): void {
    this.sessions.set(root, { peer, parent: undefined });
  }

  forward(
    peer: PeerWire,
    root: string,
    originalId: number,
    method: string,
    message: Record<string, unknown>,
    sessionId?: string,
  ): void {
    if (this.closed || peer.closed)
      throw new Error("Browser peer connection closed");
    const id = ++this.nextId;
    const parent = sessionId ?? root;
    this.pending.set(id, {
      kind: "peer",
      peer,
      id: originalId,
      method,
      sessionId,
      parent,
    });
    try {
      this.socket.send(JSON.stringify({ ...message, id, sessionId: parent }));
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }

  release(peer: PeerWire, root: string): void {
    for (const [id, request] of this.pending)
      if (request.kind === "peer" && request.peer === peer)
        this.pending.delete(id);
    this.requestPeer(peer, "Target.detachFromTarget", { sessionId: root });
  }

  retirePeer(peer: PeerWire): void {
    this.peers.delete(peer);
    for (const [id, request] of this.pending)
      if (
        (request.kind === "peer" || request.kind === "lifetime") &&
        request.peer === peer
      )
        this.pending.delete(id);
    for (const [id, owner] of this.sessions)
      if (owner.peer === peer) this.sessions.delete(id);
  }

  private detach(sessionId: string, parent?: string): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    const id = ++this.nextId;
    const timer = setTimeout(() => {
      this.close();
    }, 15_000);
    this.pending.set(id, { kind: "detach", timer });
    try {
      this.socket.send(
        JSON.stringify({
          id,
          method: "Target.detachFromTarget",
          params: { sessionId },
          sessionId: parent,
        }),
      );
    } catch {
      this.close();
    }
  }

  private forget(sessionId: string): void {
    for (const [id, owner] of this.sessions)
      if (owner.parent === sessionId) this.forget(id);
    this.sessions.delete(sessionId);
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.fail();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close();
  }

  private fail(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseOwner?.();
    this.releaseOwner = undefined;
    for (const entry of this.pending.values()) {
      if (entry.kind === "control" || entry.kind === "detach")
        clearTimeout(entry.timer);
      if (entry.kind === "control") {
        entry.reject(new Error("Browser control connection closed"));
      }
    }
    this.pending.clear();
    for (const peer of this.peers) peer.retire();
    this.listeners.clear();
  }
}

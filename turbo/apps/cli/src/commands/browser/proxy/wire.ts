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
}

/** A peer owns a browser session, never the shared provider connection. */
export class PeerWire {
  private readonly messages = new Set<
    (message: Record<string, unknown>, raw: string) => void
  >();
  private readonly closing = new Set<() => void>();
  closed = false;

  constructor(
    private readonly owner: ControlWire,
    readonly root: string,
  ) {}

  send(raw: string): void {
    const message: unknown = JSON.parse(raw);
    if (
      !record(message) ||
      typeof message.id !== "number" ||
      typeof message.method !== "string"
    )
      throw new Error("Invalid Browser peer request");
    if (this.closed) throw new Error("Browser peer connection closed");
    this.owner.forward(this, message.id, message.method, message);
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
    this.closed = true;
    this.owner.release(this);
    for (const listener of this.closing) listener();
    this.closing.clear();
    this.messages.clear();
  }
}

/** One Guest-owned provider socket; logical peers retain independent CDP roots. */
export class ControlWire implements CdpTransport {
  private nextId = 0;
  private readonly pending = new Map<number, ControlRequest | PeerRequest>();
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
    if (entry.kind === "control") {
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
          parent: entry.sessionId ?? entry.peer.root,
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
      if (channel === owner.peer.root)
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
      if (detached && params.sessionId === detached.peer.root) {
        detached.peer.close();
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

  async openPeer(): Promise<PeerWire> {
    const result = await this.request("Target.attachToBrowserTarget", {});
    if (!record(result) || typeof result.sessionId !== "string")
      throw new Error("Invalid Browser peer session");
    if (this.closed) throw new Error("Browser control connection closed");
    const peer = new PeerWire(this, result.sessionId);
    this.peers.add(peer);
    this.sessions.set(peer.root, { peer, parent: undefined });
    return peer;
  }

  forward(
    peer: PeerWire,
    originalId: number,
    method: string,
    message: Record<string, unknown>,
  ): void {
    if (this.closed || !this.peers.has(peer))
      throw new Error("Browser peer connection closed");
    const id = ++this.nextId;
    const sessionId =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    this.pending.set(id, {
      kind: "peer",
      peer,
      id: originalId,
      method,
      sessionId,
    });
    try {
      this.socket.send(
        JSON.stringify({ ...message, id, sessionId: sessionId ?? peer.root }),
      );
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
  }

  release(peer: PeerWire): void {
    if (!this.peers.delete(peer)) return;
    for (const [id, request] of this.pending)
      if (request.kind === "peer" && request.peer === peer)
        this.pending.delete(id);
    for (const [id, owner] of this.sessions)
      if (owner.peer === peer) this.sessions.delete(id);
    this.detach(peer.root);
  }

  private detach(sessionId: string, parent?: string): void {
    if (!this.closed && this.socket.readyState === WebSocket.OPEN)
      this.socket.send(
        JSON.stringify({
          id: ++this.nextId,
          method: "Target.detachFromTarget",
          params: { sessionId },
          sessionId: parent,
        }),
      );
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
      if (entry.kind === "control") {
        clearTimeout(entry.timer);
        entry.reject(new Error("Browser control connection closed"));
      }
    }
    this.pending.clear();
    for (const peer of this.peers) peer.close();
    this.listeners.clear();
  }
}

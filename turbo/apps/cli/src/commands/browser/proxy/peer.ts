import type { WebSocket as ClientSocket } from "ws";
import { ProtocolError, record } from "./wire";
import {
  WindowScope,
  targetInfo,
  outsideWindow,
  type TargetInfo,
} from "./scope";

type Message = Record<string, unknown>;
interface Session {
  readonly target: string | null;
  readonly parent?: string;
  readonly flatten: boolean;
}
interface Pending {
  readonly command: Message;
  readonly channel?: string;
}
interface Internal {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface AutoAttachment {
  readonly params: Message;
  readonly roots: Set<string>;
  readonly flatten: boolean;
}
const key = (channel: string | undefined, id: unknown) => {
  return (channel ?? "") + ":" + String(id);
};
const TARGET_ADDRESSES = new Set([
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.getTargetInfo",
  "Target.autoAttachRelated",
  "Target.exposeDevToolsProtocol",
  "Browser.getWindowForTarget",
]);
const ADAPTED_REPLIES = new Set([
  "Target.getTargets",
  "Target.getTargetInfo",
  "Target.attachToTarget",
  "Target.attachToBrowserTarget",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.autoAttachRelated",
]);

/** Only target/session/window boundaries are adapted; ordinary CDP remains opaque. */
export class ProxyPeer {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, Pending>();
  private readonly reserved = new Set<string>();
  private readonly internal = new Map<string, Internal>();
  private readonly visible = new Map<string | undefined, Set<string>>();
  private readonly discovery = new Map<string | undefined, Message>();
  private readonly autoAttach = new Map<string | undefined, AutoAttachment>();
  private internalId = -1;
  private events = Promise.resolve();
  private control = Promise.resolve();
  private ended = false;
  private readonly off: () => void;

  constructor(
    private readonly downstream: ClientSocket,
    private readonly upstream: WebSocket,
    private readonly scope: WindowScope,
    private readonly finished: () => void,
  ) {
    this.off = scope.onChange(() => {
      this.control = this.control
        .then(() => {
          return this.reconcile();
        })
        .catch(() => {
          return this.close();
        });
    });
    downstream.on("message", (data, binary) => {
      if (binary) return this.close();
      this.client(data.toString()).catch(() => {
        return this.close();
      });
    });
    downstream.on("error", () => {
      return this.close();
    });
    downstream.on("close", () => {
      return this.close();
    });
    upstream.addEventListener("error", () => {
      return this.close();
    });
    upstream.addEventListener("close", () => {
      return this.close();
    });
    upstream.addEventListener("message", ({ data }: { data: unknown }) => {
      if (typeof data !== "string") return this.close();
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return this.close();
      }
      if (!record(value)) return this.close();
      const channel =
        typeof value.sessionId === "string" ? value.sessionId : undefined;
      const internal = this.internal.get(key(channel, value.id));
      if (value.id !== undefined && internal) {
        this.internal.delete(key(channel, value.id));
        clearTimeout(internal.timer);
        if (record(value.error))
          internal.reject(new ProtocolError(value.error));
        else internal.resolve(value.result);
        return;
      }
      const request = this.requests.get(key(channel, value.id));
      // Do not put input replies/events behind discovery or creation IO.
      if (
        value.id !== undefined &&
        (!request || !ADAPTED_REPLIES.has(String(request.command.method)))
      ) {
        this.requests.delete(key(channel, value.id));
        if (
          channel &&
          this.sessions.has(channel) &&
          !this.liveSession(channel)
        ) {
          this.scope
            .stable()
            .then(() => {
              return this.emit(channel, value, data);
            })
            .catch(() => {
              return this.close();
            });
        } else this.emit(channel, value, data);
      } else if (
        typeof value.method === "string" &&
        !value.method.startsWith("Target.") &&
        (!channel || this.liveSession(channel))
      ) {
        this.emit(channel, value, data);
      } else {
        this.events = this.events
          .then(() => {
            return this.server(value, data);
          })
          .catch(() => {
            return this.close();
          });
      }
    });
  }

  private send(raw: string): void {
    if (!this.ended && this.downstream.readyState === this.downstream.OPEN)
      this.downstream.send(raw);
  }

  private liveSession(id: string): boolean {
    const session = this.sessions.get(id);
    return (
      session !== undefined &&
      (session.target === null || this.scope.admits(session.target))
    );
  }

  private forgetSession(id: string): boolean {
    if (!this.sessions.delete(id)) return false;
    for (const [child, session] of this.sessions)
      if (session.parent === id) this.forgetSession(child);
    this.autoAttach.delete(id);
    this.discovery.delete(id);
    this.visible.delete(id);
    return true;
  }

  private emit(
    channel: string | undefined,
    message: Message,
    raw?: string,
  ): void {
    if (!channel) {
      this.send(raw ?? JSON.stringify(message));
      return;
    }
    const session = this.sessions.get(channel);
    if (!session || !this.liveSession(channel)) return;
    if (session.flatten) {
      this.send(raw ?? JSON.stringify({ ...message, sessionId: channel }));
    } else {
      const { sessionId: _sessionId, ...inner } = message;
      this.emit(session.parent, {
        method: "Target.receivedMessageFromTarget",
        params: { sessionId: channel, message: JSON.stringify(inner) },
      });
    }
  }

  private async client(raw: string): Promise<void> {
    const message: unknown = JSON.parse(raw);
    if (
      !record(message) ||
      !Number.isSafeInteger(message.id) ||
      typeof message.method !== "string"
    )
      throw new Error("Invalid CDP command");
    await this.command(message, raw);
  }

  private async authorize(
    method: string,
    params: Message,
    channel?: string,
  ): Promise<void> {
    if (channel && this.sessions.has(channel) && !this.liveSession(channel))
      await this.scope.stable();
    if (channel && !this.liveSession(channel)) throw outsideWindow();
    if (
      TARGET_ADDRESSES.has(method) &&
      typeof params.targetId === "string" &&
      !(await this.scope.allows(params.targetId))
    )
      throw outsideWindow();
    if (
      ["Target.detachFromTarget", "Target.sendMessageToTarget"].includes(
        method,
      ) &&
      typeof params.sessionId === "string" &&
      !this.liveSession(params.sessionId)
    )
      throw outsideWindow();
    if (method === "Target.openDevTools") throw outsideWindow();
  }
  private async nested(
    params: Message,
    channel: string | undefined,
    respond: (value: Message) => void,
  ): Promise<void> {
    let child =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!child && typeof params.targetId === "string") {
      const candidates = [...this.sessions].filter(([, session]) => {
        return session.target === params.targetId && session.parent === channel;
      });
      if (candidates.length === 1) child = candidates[0]![0];
    }
    if (!child || !this.liveSession(child)) throw outsideWindow();
    const raw = String(params.message);
    const nested: unknown = JSON.parse(raw);
    if (
      !record(nested) ||
      !Number.isSafeInteger(nested.id) ||
      typeof nested.method !== "string"
    )
      throw new ProtocolError({
        code: -32602,
        message: "Invalid nested protocol command",
      });
    respond({ result: {} });
    await this.command(nested, raw, child);
  }
  private async configureAutomatic(
    params: Message,
    channel?: string,
  ): Promise<void> {
    await this.inject(
      "Target.setAutoAttach",
      { ...params, autoAttach: false, flatten: true },
      channel,
    );
    this.autoAttach.delete(channel);
    if (params.autoAttach !== true) return;
    const auto = {
      params,
      roots: new Set<string>(),
      flatten: params.flatten === true,
    };
    this.autoAttach.set(channel, auto);
    try {
      await this.relate(channel, auto);
    } catch (error) {
      this.autoAttach.delete(channel);
      try {
        await this.inject(
          "Target.setAutoAttach",
          { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
          channel,
        );
      } catch {
        this.close();
      }
      throw error;
    }
  }
  private async controlCommand(
    method: string,
    params: Message,
    channel: string | undefined,
    respond: (value: Message) => void,
  ): Promise<boolean> {
    if (method === "Target.createTarget") {
      respond({
        result: await this.scope.create(params, (value) => {
          return this.inject(method, value, channel);
        }),
      });
      return true;
    }
    if (
      method === "Browser.close" ||
      (method === "Target.closeTarget" &&
        typeof params.targetId === "string" &&
        this.scope.targets.get(params.targetId)?.type === "browser")
    ) {
      await this.scope.native.call("closeWindow", {
        windowId: this.scope.windowId,
      });
      respond({ result: {} });
      return true;
    }
    const browser = !channel || this.sessions.get(channel)?.target === null;
    if (
      method === "Target.setAutoAttach" &&
      browser &&
      typeof params.autoAttach === "boolean" &&
      (params.flatten === undefined || typeof params.flatten === "boolean")
    ) {
      const operation = this.control.then(() => {
        return this.configureAutomatic(params, channel);
      });
      this.control = operation.catch(() => {});
      await operation;
      respond({ result: {} });
      return true;
    }
    return false;
  }
  private async rewrite(
    message: Message,
    raw: string,
    channel?: string,
  ): Promise<string> {
    const method = String(message.method);
    const params = record(message.params) ? message.params : {};
    if (
      [
        "Browser.getWindowBounds",
        "Browser.setWindowBounds",
        "Browser.setContentsSize",
      ].includes(method)
    ) {
      if (params.windowId !== this.scope.windowId)
        return JSON.stringify({
          ...message,
          params: { ...params, windowId: this.scope.windowId },
        });
    } else if (
      method === "Browser.getWindowForTarget" &&
      params.targetId === undefined
    ) {
      const target = channel ? this.sessions.get(channel)?.target : null;
      return JSON.stringify({
        ...message,
        params: {
          ...params,
          targetId: target ?? (await this.scope.firstPage()),
        },
      });
    } else if (
      ["Target.attachToTarget", "Target.setAutoAttach"].includes(method) &&
      (params.flatten === undefined || params.flatten === false)
    ) {
      return JSON.stringify({
        ...message,
        params: { ...params, flatten: true },
      });
    }
    return raw;
  }
  private async command(
    message: Message,
    raw: string,
    inherited?: string,
  ): Promise<void> {
    const channel =
      typeof message.sessionId === "string" ? message.sessionId : inherited;
    const params = record(message.params) ? message.params : {};
    const method = String(message.method);
    const respond = (value: Message) => {
      this.emit(channel, { id: message.id, ...value });
    };
    const requestKey = key(channel, message.id);
    // Reserve before authorization yields so private control IDs cannot race ingress.
    this.reserved.add(requestKey);
    try {
      const conflict = this.internal.get(key(channel, message.id));
      // Only wait for private ID release; its outcome belongs to its caller.
      if (conflict)
        await conflict.promise.then(
          () => {},
          () => {},
        );
      await this.authorize(method, params, channel);
      if (
        method === "Target.sendMessageToTarget" &&
        typeof params.message === "string"
      ) {
        await this.nested(params, channel, respond);
        return;
      }
      if (await this.controlCommand(method, params, channel, respond)) return;
      raw = await this.rewrite(message, raw, channel);
      if (inherited && message.sessionId === undefined)
        raw = JSON.stringify({
          ...(JSON.parse(raw) as Message),
          sessionId: channel,
        });
      this.requests.set(key(channel, message.id), {
        command: message,
        channel,
      });
      this.upstream.send(raw);
    } catch (error) {
      const failure = {
        id: message.id,
        error:
          error instanceof ProtocolError
            ? error.detail
            : {
                code: -32000,
                message:
                  "Scoped Browser operation could not be confirmed; inspect before retrying",
              },
      };
      if (typeof message.sessionId === "string")
        this.send(JSON.stringify({ ...failure, sessionId: channel }));
      else this.emit(channel, failure);
    } finally {
      this.reserved.delete(requestKey);
    }
  }

  private rememberResponse(
    request: Message,
    result: Message,
    channel?: string,
  ): void {
    const requested = record(request.params) ? request.params : {};
    if (request.method === "Target.getTargetInfo") {
      const info = targetInfo(result.targetInfo);
      if (info) this.scope.targets.set(info.targetId, info);
    }
    if (
      (request.method === "Target.attachToTarget" ||
        request.method === "Target.attachToBrowserTarget") &&
      typeof result.sessionId === "string"
    ) {
      const target =
        typeof requested.targetId === "string" ? requested.targetId : null;
      this.sessions.set(result.sessionId, {
        target:
          target && this.scope.targets.get(target)?.type !== "browser"
            ? target
            : null,
        parent: channel,
        flatten:
          request.method === "Target.attachToBrowserTarget" ||
          requested.flatten === true,
      });
    }

    this.rememberSelectors(String(request.method), requested, channel);
  }

  private rememberSelectors(
    method: string,
    requested: Message,
    channel?: string,
  ): void {
    if (method === "Target.setDiscoverTargets") {
      if (requested.discover === true) this.discovery.set(channel, requested);
      else this.discovery.delete(channel);
    }
    if (method === "Target.setAutoAttach") {
      if (requested.autoAttach === true)
        this.autoAttach.set(channel, {
          params: requested,
          roots: new Set(),
          flatten: requested.flatten === true,
        });
      else this.autoAttach.delete(channel);
    }
    if (
      method === "Target.autoAttachRelated" &&
      typeof requested.targetId === "string"
    ) {
      let auto = this.autoAttach.get(channel);
      if (!auto) {
        auto = { params: requested, roots: new Set(), flatten: true };
        this.autoAttach.set(channel, auto);
      }
      auto.roots.add(requested.targetId);
    }
  }

  private async response(
    message: Message,
    raw: string,
    channel?: string,
  ): Promise<void> {
    const pending = this.requests.get(key(channel, message.id));
    this.requests.delete(key(channel, message.id));
    if (!message.error && pending) {
      const request = pending.command;
      const result = record(message.result) ? message.result : {};
      if (
        request.method === "Target.getTargets" &&
        Array.isArray(result.targetInfos)
      ) {
        const allowed: TargetInfo[] = [];
        for (const value of result.targetInfos) {
          const info = targetInfo(value);
          if (info && (await this.scope.contains(info)))
            allowed.push(this.scope.publicInfo(info));
        }
        this.emit(channel, {
          ...message,
          result: { ...result, targetInfos: allowed },
        });
        return;
      }

      this.rememberResponse(request, result, channel);
    }
    this.emit(channel, message, raw);
  }

  private provenance(info: TargetInfo, channel?: string): { flatten: boolean } {
    const auto = this.autoAttach.get(channel);
    const parent = channel ? this.sessions.get(channel)?.target : null;
    const pending = [...this.requests.values()].find((request) => {
      return (
        request.channel === channel &&
        record(request.command.params) &&
        ((request.command.method === "Target.attachToTarget" &&
          request.command.params.targetId === info.targetId) ||
          (request.command.method === "Target.setAutoAttach" &&
            request.command.params.autoAttach === true))
      );
    });
    const requested =
      pending && record(pending.command.params)
        ? pending.command.params
        : undefined;
    const related = [...this.requests.values()].some((request) => {
      return (
        request.command.method === "Target.autoAttachRelated" &&
        request.channel === channel &&
        record(request.command.params) &&
        typeof request.command.params.targetId === "string" &&
        this.scope.admits(request.command.params.targetId)
      );
    });
    if (parent || auto?.roots.size || related)
      this.scope.inherit(info, parent ?? undefined);

    return {
      flatten: requested ? requested.flatten === true : (auto?.flatten ?? true),
    };
  }

  private async attached(
    message: Message,
    raw: string,
    params: Message,
    channel?: string,
  ): Promise<void> {
    const info = targetInfo(params.targetInfo);
    if (!info || typeof params.sessionId !== "string") return;
    const { flatten } = this.provenance(info, channel);
    if (!(await this.scope.contains(info))) {
      if (params.waitingForDebugger === true)
        await this.inject(
          "Runtime.runIfWaitingForDebugger",
          {},
          params.sessionId,
        );
      await this.inject(
        "Target.detachFromTarget",
        { sessionId: params.sessionId },
        channel,
      );
      return;
    }
    this.sessions.set(params.sessionId, {
      target: info.type === "browser" ? null : info.targetId,
      parent: channel,
      flatten,
    });
    const publicInfo = this.scope.publicInfo(info);
    this.emit(
      channel,
      publicInfo === info
        ? message
        : { ...message, params: { ...params, targetInfo: publicInfo } },
      publicInfo === info ? raw : undefined,
    );
    return;
  }

  private async discovered(
    message: Message,
    raw: string,
    params: Message,
    channel?: string,
  ): Promise<void> {
    const info = targetInfo(params.targetInfo);
    if (!info || !(await this.scope.contains(info))) return;
    let visible = this.visible.get(channel);
    if (!visible) this.visible.set(channel, (visible = new Set()));
    visible.add(info.targetId);
    const publicInfo = this.scope.publicInfo(info);
    this.emit(
      channel,
      publicInfo === info
        ? message
        : { ...message, params: { ...params, targetInfo: publicInfo } },
      publicInfo === info ? raw : undefined,
    );
    return;
  }

  private async server(message: Message, raw: string): Promise<void> {
    const channel =
      typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (message.id !== undefined) {
      await this.response(message, raw, channel);
      return;
    }
    if (channel && this.sessions.has(channel) && !this.liveSession(channel))
      await this.scope.stable();
    if (channel && !this.liveSession(channel)) return;
    const params = record(message.params) ? message.params : {};
    switch (message.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        await this.discovered(message, raw, params, channel);
        return;
      case "Target.attachedToTarget":
        await this.attached(message, raw, params, channel);
        return;
      case "Target.targetDestroyed":
        if (
          typeof params.targetId !== "string" ||
          !this.visible.get(channel)?.delete(params.targetId)
        )
          return;
        break;
      case "Target.detachedFromTarget":
        if (
          typeof params.sessionId !== "string" ||
          !this.forgetSession(params.sessionId)
        )
          return;
        break;
    }
    this.emit(channel, message, raw);
  }

  private inject(
    method: string,
    params: Message,
    sessionId?: string,
  ): Promise<unknown> {
    let id = this.internalId--;
    while (
      this.requests.has(key(sessionId, id)) ||
      this.reserved.has(key(sessionId, id))
    )
      id = this.internalId--;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const timer = setTimeout(() => {
      this.internal.delete(key(sessionId, id));
      reject(new Error("Browser control operation timed out"));
    }, 15_000);
    this.internal.set(key(sessionId, id), { promise, resolve, reject, timer });
    try {
      this.upstream.send(JSON.stringify({ id, method, params, sessionId }));
    } catch {
      clearTimeout(timer);
      this.internal.delete(key(sessionId, id));
      reject(new Error("Browser peer connection closed"));
    }
    return promise;
  }

  private matches(info: TargetInfo, params: Message): boolean {
    const filter = Array.isArray(params.filter)
      ? params.filter
      : [
          { type: "browser", exclude: true },
          { type: "tab", exclude: true },
          {},
        ];
    for (const entry of filter)
      if (
        record(entry) &&
        (entry.type === undefined || entry.type === info.type)
      )
        return entry.exclude !== true;
    return false;
  }

  private async relate(
    channel: string | undefined,
    auto: AutoAttachment,
  ): Promise<void> {
    const roots: TargetInfo[] = [];
    for (const info of this.scope.targets.values())
      if (
        ["page", "tab", "service_worker", "shared_worker"].includes(
          info.type,
        ) &&
        this.matches(info, auto.params) &&
        (await this.scope.contains(info))
      )
        roots.push(info);
    if (
      [...auto.roots].some((id) => {
        return !roots.some((info) => {
          return info.targetId === id;
        });
      })
    ) {
      await this.inject(
        "Target.setAutoAttach",
        { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        channel,
      );
      auto.roots.clear();
    }
    for (const info of roots) {
      if (auto.roots.has(info.targetId)) continue;
      auto.roots.add(info.targetId);
      try {
        await this.inject(
          "Target.autoAttachRelated",
          {
            targetId: info.targetId,
            waitForDebuggerOnStart: auto.params.waitForDebuggerOnStart,
            ...(auto.params.filter !== undefined
              ? { filter: auto.params.filter }
              : {}),
          },
          channel,
        );
      } catch (error) {
        auto.roots.delete(info.targetId);
        throw error;
      }
    }
  }

  private async reconcile(): Promise<void> {
    if (this.ended) return;
    for (const [channel, visible] of this.visible) {
      if (channel && !this.liveSession(channel)) continue;
      for (const id of visible) {
        if (await this.scope.allows(id)) continue;
        visible.delete(id);
        this.emit(channel, {
          method: "Target.targetDestroyed",
          params: { targetId: id },
        });
      }
      const discover = this.discovery.get(channel);
      if (discover)
        for (const info of this.scope.targets.values()) {
          if (
            !visible.has(info.targetId) &&
            this.matches(info, discover) &&
            (await this.scope.contains(info))
          ) {
            visible.add(info.targetId);
            this.emit(channel, {
              method: "Target.targetCreated",
              params: { targetInfo: this.scope.publicInfo(info) },
            });
          }
        }
    }
    for (const [id, session] of this.sessions) {
      if (
        session.target !== null &&
        !(await this.scope.allows(session.target))
      ) {
        await this.inject(
          "Target.detachFromTarget",
          { sessionId: id },
          session.parent,
        );
      }
    }
    for (const [channel, auto] of this.autoAttach) {
      if (!channel || this.sessions.get(channel)?.target === null)
        await this.relate(channel, auto);
    }
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.off();
    this.downstream.terminate();
    this.upstream.close();
    for (const pending of this.internal.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser peer closed"));
    }
    this.internal.clear();
    this.requests.clear();
    this.reserved.clear();
    this.sessions.clear();
    this.autoAttach.clear();
    this.discovery.clear();
    this.visible.clear();
    this.finished();
  }
}

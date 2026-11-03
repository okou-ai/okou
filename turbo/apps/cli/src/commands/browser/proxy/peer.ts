import type { WebSocket as ClientSocket } from "ws";
import { ProtocolError, record, scopedError } from "./wire";
import {
  WindowScope,
  targetInfo,
  unavailableTarget,
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
  readonly reply: (message: Message) => void;
}
interface Internal {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
type AutoAttachment =
  | {
      readonly kind: "automatic";
      readonly params: Message;
      readonly roots: Map<string, boolean>;
      readonly flatten: boolean;
    }
  | {
      readonly kind: "related";
      // Latest handler filter/opaque parameters, independent of root wait flags.
      readonly params: Message;
      readonly selectors: Map<string, boolean>;
      // Applied subscriptions, not a second copy of selector/filter intent.
      readonly roots: Map<string, boolean>;
      // null retains an explicitly detached root until an explicit reselection.
      readonly direct: Map<string, string | null>;
      readonly flatten: true;
    };
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
const CLOSE_COMMANDS = new Set([
  "Browser.close",
  "Browser.crash",
  "Target.closeTarget",
  "Target.disposeBrowserContext",
  "Page.close",
]);

const UNCONFIRMED_OPERATION =
  "Scoped Browser operation could not be confirmed; inspect before retrying";

function unavailableSession(): ProtocolError {
  return scopedError(
    "The session is unavailable in this chat's Browser connection; attach to a current target before sending session commands",
  );
}

function relatedParameters(params: Message): boolean {
  return (
    typeof params.waitForDebuggerOnStart === "boolean" &&
    (params.filter === undefined ||
      (Array.isArray(params.filter) &&
        params.filter.every((entry: unknown) => {
          return (
            record(entry) &&
            (entry.type === undefined || typeof entry.type === "string") &&
            (entry.exclude === undefined || typeof entry.exclude === "boolean")
          );
        })))
  );
}

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
        if (channel && request && !this.liveSession(channel)) {
          this.settleRetiredReply(request, value, channel)
            .then((settled) => {
              if (!settled) this.emit(channel, value, data);
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
    for (const auto of this.autoAttach.values())
      if (auto.kind === "related")
        for (const [target, session] of auto.direct)
          if (session === id) auto.direct.set(target, null);
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

  /** Capture encoding, not authority: accepted requests must settle after retirement. */
  private replyRoute(channel?: string): (message: Message) => void {
    if (!channel)
      return (message) => {
        return this.send(JSON.stringify(message));
      };
    const session = this.sessions.get(channel);
    if (!session) throw unavailableSession();
    if (session.flatten)
      return (message) => {
        return this.send(JSON.stringify({ ...message, sessionId: channel }));
      };
    const parent = this.replyRoute(session.parent);
    return (message) => {
      return parent({
        method: "Target.receivedMessageFromTarget",
        params: { sessionId: channel, message: JSON.stringify(message) },
      });
    };
  }

  private async settleRetiredReply(
    pending: Pending,
    message: Message,
    channel?: string,
  ): Promise<boolean> {
    if (!channel || this.liveSession(channel)) return false;
    const session = this.sessions.get(channel);
    // Definitive native retirement must not wait for unrelated discovery IO.
    if (session?.target && this.scope.targets.has(session.target))
      await this.scope.stable();
    if (this.liveSession(channel)) return false;
    pending.reply({
      id: message.id,
      error: record(message.error)
        ? message.error
        : scopedError(UNCONFIRMED_OPERATION).detail,
    });
    return true;
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
    if (channel && !this.liveSession(channel)) throw unavailableSession();
    if (
      TARGET_ADDRESSES.has(method) &&
      typeof params.targetId === "string" &&
      !(await this.scope.allows(params.targetId))
    )
      throw unavailableTarget();
    if (
      ["Target.detachFromTarget", "Target.sendMessageToTarget"].includes(
        method,
      ) &&
      typeof params.sessionId === "string" &&
      !this.liveSession(params.sessionId)
    )
      throw unavailableSession();
    if (method === "Target.openDevTools")
      throw scopedError(
        "Opening DevTools is not supported by this chat's Browser connection",
      );
  }
  private async nested(
    params: Message,
    channel: string | undefined,
    respond: (value: Message) => Promise<void>,
  ): Promise<void> {
    let child =
      typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (!child && typeof params.targetId === "string") {
      const candidates = [...this.sessions].filter(([, session]) => {
        return session.target === params.targetId && session.parent === channel;
      });
      if (candidates.length === 1) child = candidates[0]![0];
    }
    if (!child || !this.liveSession(child)) throw unavailableSession();
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
    await respond({ result: {} });
    await this.command(nested, raw, child);
  }
  private async configureAutomatic(
    params: Message,
    channel?: string,
  ): Promise<void> {
    // A native disable operation cannot carry a nonempty filter. The caller's
    // filter controls root selection below, not this cancellation command.
    const { filter: _filter, ...reset } = params;
    await this.disableAutomatic(channel, this.autoAttach.get(channel), {
      ...reset,
      autoAttach: false,
      flatten: true,
    });
    this.autoAttach.delete(channel);
    if (params.autoAttach !== true) return;
    const auto: AutoAttachment = {
      kind: "automatic",
      params,
      roots: new Map(),
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
  private async disableAutomatic(
    channel: string | undefined,
    auto: AutoAttachment | undefined,
    params: Message = {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    },
  ): Promise<void> {
    await this.inject("Target.setAutoAttach", params, channel);
    auto?.roots.clear();
    if (auto?.kind !== "related") return;
    // Browser-self sessions are explicit attachments, never global sources.
    // Native cancellation must release these owned sessions separately.
    try {
      for (const sessionId of auto.direct.values())
        if (sessionId !== null)
          await this.inject("Target.detachFromTarget", { sessionId }, channel);
      auto.direct.clear();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private async configureRelated(
    targetId: string,
    params: Message,
    channel?: string,
  ): Promise<unknown> {
    const previous = this.autoAttach.get(channel);
    // Native autoAttachRelated replaces setAutoAttach, whose window-scoped
    // implementation uses related selectors too. Cancel those before switching.
    if (previous?.kind === "automatic") {
      await this.disableAutomatic(channel, previous);
    }
    const selectors = new Map(
      previous?.kind === "related" ? previous.selectors : [],
    );
    selectors.set(targetId, params.waitForDebuggerOnStart === true);
    const auto: AutoAttachment = {
      kind: "related",
      params,
      selectors,
      roots: new Map(previous?.kind === "related" ? previous.roots : []),
      direct: new Map(previous?.kind === "related" ? previous.direct : []),
      flatten: true,
    };
    this.autoAttach.set(channel, auto);
    try {
      const result = await this.relate(channel, auto, targetId);
      if (!auto.selectors.has(targetId)) throw unavailableTarget();
      return result;
    } catch (error) {
      try {
        await this.disableAutomatic(channel, auto);
        if (previous) {
          previous.roots.clear();
          if (previous.kind === "related") previous.direct.clear();
          this.autoAttach.set(channel, previous);
          await this.relate(channel, previous);
        } else this.autoAttach.delete(channel);
      } catch {
        this.close();
      }
      throw error;
    }
  }
  private async closesWindow(
    method: string,
    params: Message,
  ): Promise<boolean> {
    if (["Browser.close", "Browser.crash"].includes(method)) return true;
    if (method === "Target.closeTarget")
      return (
        typeof params.targetId === "string" &&
        this.scope.targets.get(params.targetId)?.type === "browser"
      );
    if (
      method === "Target.disposeBrowserContext" &&
      typeof params.browserContextId === "string"
    )
      return (
        this.scope.targets.get(await this.scope.firstPage())
          ?.browserContextId === params.browserContextId
      );
    return false;
  }

  private async closeCommand(
    method: string,
    params: Message,
    channel: string | undefined,
    respond: (value: Message) => Promise<void>,
  ): Promise<boolean> {
    if (await this.closesWindow(method, params)) {
      throw new ProtocolError({
        code: -32000,
        message:
          "This chat's Browser window must remain open; close individual tabs instead",
      });
    }
    const closingTarget =
      method === "Target.closeTarget" && typeof params.targetId === "string"
        ? params.targetId
        : method === "Page.close" && channel
          ? this.sessions.get(channel)?.target
          : undefined;
    const closingInfo = closingTarget
      ? this.scope.targets.get(closingTarget)
      : undefined;
    if (
      closingTarget &&
      (closingInfo?.type === "page" ||
        (method === "Target.closeTarget" && closingInfo?.type === "tab"))
    ) {
      await respond({
        result: await this.scope.closeTarget(closingTarget, () => {
          if (this.ended) throw new Error("Browser peer connection closed");
          return this.inject(method, params, channel);
        }),
      });
      return true;
    }
    return false;
  }

  private async controlCommand(
    method: string,
    params: Message,
    channel: string | undefined,
    respond: (value: Message) => Promise<void>,
  ): Promise<boolean> {
    if (
      CLOSE_COMMANDS.has(method) &&
      (await this.closeCommand(method, params, channel, respond))
    )
      return true;
    if (method === "Target.createTarget") {
      await respond({
        result: await this.scope.create(params, (value) => {
          return this.inject(method, value, channel);
        }),
      });
      return true;
    }
    const browser = !channel || this.sessions.get(channel)?.target === null;
    if (
      method === "Target.autoAttachRelated" &&
      browser &&
      typeof params.targetId === "string" &&
      // Let Chrome reject malformed parameters before changing any selectors.
      relatedParameters(params)
    ) {
      const targetId = params.targetId;
      const operation = this.control.then(() => {
        return this.configureRelated(targetId, params, channel);
      });
      this.control = operation.then(
        () => {},
        () => {},
      );
      await respond({ result: await operation });
      return true;
    }
    if (
      method === "Target.setAutoAttach" &&
      browser &&
      typeof params.autoAttach === "boolean" &&
      (params.flatten === undefined || typeof params.flatten === "boolean") &&
      this.automaticParameters(params)
    ) {
      const operation = this.control.then(() => {
        return this.configureAutomatic(params, channel);
      });
      this.control = operation.catch(() => {});
      await operation;
      await respond({ result: {} });
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
    let reply: ((message: Message) => void) | undefined;
    const requestKey = key(channel, message.id);
    // Reserve before authorization yields so private control IDs cannot race ingress.
    this.reserved.add(requestKey);
    try {
      // Authorization and private-ID release can yield across native retirement.
      // Keep only the accepted request's encoding, never its old admission.
      const accepted: Pending = {
        command: message,
        channel,
        reply: this.replyRoute(channel),
      };
      reply = accepted.reply;
      const respond = async (value: Message) => {
        const response = { id: message.id, ...value };
        // A close may itself retire its reply channel. Other completed control
        // commands keep the same admission checks as ordinary upstream replies.
        if (
          method !== "Page.close" &&
          method !== "Target.closeTarget" &&
          (await this.settleRetiredReply(accepted, response, channel))
        )
          return;
        accepted.reply(response);
      };
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
      this.requests.set(key(channel, message.id), accepted);
      this.upstream.send(raw);
    } catch (error) {
      const failure = {
        id: message.id,
        error:
          error instanceof ProtocolError
            ? error.detail
            : {
                code: -32000,
                message: UNCONFIRMED_OPERATION,
              },
      };
      if (reply) reply(failure);
      else if (typeof message.sessionId === "string")
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
      else {
        this.discovery.delete(channel);
        this.visible.delete(channel);
      }
    }
    if (method === "Target.setAutoAttach") {
      if (requested.autoAttach === true)
        this.autoAttach.set(channel, {
          kind: "automatic",
          params: requested,
          roots: new Map(),
          flatten: requested.flatten === true,
        });
      else this.autoAttach.delete(channel);
    }
  }

  private async response(
    message: Message,
    raw: string,
    channel?: string,
  ): Promise<void> {
    const pending = this.requests.get(key(channel, message.id));
    this.requests.delete(key(channel, message.id));
    if (pending && (await this.settleRetiredReply(pending, message, channel)))
      return;
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
        const reply = {
          ...message,
          result: { ...result, targetInfos: allowed },
        };
        if (!(await this.settleRetiredReply(pending, reply, channel)))
          this.emit(channel, reply);
        return;
      }

      this.rememberResponse(request, result, channel);
    }
    if (!pending || !(await this.settleRetiredReply(pending, message, channel)))
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
    const related = [...this.requests.values()].flatMap((request) => {
      return request.command.method === "Target.autoAttachRelated" &&
        request.channel === channel &&
        record(request.command.params) &&
        typeof request.command.params.targetId === "string" &&
        this.scope.admits(request.command.params.targetId)
        ? [request.command.params.targetId]
        : [];
    });
    const roots =
      typeof info.parentId === "string" && this.scope.admits(info.parentId)
        ? [info.parentId]
        : parent
          ? [parent]
          : [...(auto?.roots.keys() ?? []), ...related];
    if (roots.length) this.scope.inherit(info, roots);

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
    await this.scope.stable();
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

  private automaticParameters(params: Message): boolean {
    if (!relatedParameters(params)) return false;
    if (
      params.autoAttach === false &&
      Array.isArray(params.filter) &&
      params.filter.length > 0
    )
      return false;
    // Let native validation reject the root protocol's incompatible page/tab
    // combination without changing any already-active scoped subscriptions.
    return !(
      this.matches({ type: "tab" }, params) &&
      this.matches({ type: "page" }, params)
    );
  }

  private filter(params: Message): unknown[] {
    return Array.isArray(params.filter)
      ? params.filter
      : [
          { type: "browser", exclude: true },
          { type: "tab", exclude: true },
          {},
        ];
  }

  private matches(info: Pick<TargetInfo, "type">, params: Message): boolean {
    for (const entry of this.filter(params))
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
    refresh?: string,
  ): Promise<unknown> {
    const revision = this.scope.revision;
    const roots = new Map<string, Message>();
    if (auto.kind === "automatic") {
      for (const info of this.scope.targets.values())
        if (
          ["page", "tab", "service_worker", "shared_worker"].includes(
            info.type,
          ) &&
          this.matches(info, auto.params) &&
          (await this.scope.contains(info))
        )
          roots.set(info.targetId, {
            targetId: info.targetId,
            waitForDebuggerOnStart: auto.params.waitForDebuggerOnStart,
            // Related selectors are recursive. Browser-level auto-attach is
            // not: descendants are attached by their own parent sessions.
            filter: [{ type: info.type }, { exclude: true }],
          });
    } else await this.relatedRoots(auto, roots);
    // A later root lookup can cross a native move and invalidate earlier choices.
    // Rebuild that observation before changing any native subscriptions.
    if (revision !== this.scope.revision)
      return this.relate(channel, auto, refresh);
    // Destroyed native sources retire their own subscriptions. Only a still-
    // live source leaving this window requires cancelling the remaining roots.
    for (const id of auto.roots.keys())
      if (!this.scope.targets.has(id)) auto.roots.delete(id);
    if (
      [...auto.roots.keys()].some((id) => {
        return !roots.has(id);
      })
    ) {
      await this.inject(
        "Target.setAutoAttach",
        { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
        channel,
      );
      auto.roots.clear();
    }
    let response: unknown = {};
    for (const [targetId, params] of roots) {
      if (revision !== this.scope.revision)
        return this.relate(channel, auto, refresh);
      if (!this.scope.targets.has(targetId)) continue;
      if (
        !this.refreshedRoot(targetId, refresh) &&
        auto.roots.get(targetId) === (params.waitForDebuggerOnStart === true)
      )
        continue;
      auto.roots.set(targetId, params.waitForDebuggerOnStart === true);
      try {
        const result = await this.inject(
          "Target.autoAttachRelated",
          params,
          channel,
        );
        if (targetId === refresh) response = result;
      } catch (error) {
        auto.roots.delete(targetId);
        throw error;
      }
    }
    if (revision !== this.scope.revision)
      return this.relate(channel, auto, refresh);
    if (auto.kind === "related")
      await this.attachBrowserRoots(channel, auto, refresh);
    return response;
  }

  private async attachBrowserRoots(
    channel: string | undefined,
    auto: Extract<AutoAttachment, { kind: "related" }>,
    refresh?: string,
  ): Promise<void> {
    for (const id of auto.selectors.keys()) {
      if (
        this.scope.targets.get(id)?.type !== "browser" ||
        (auto.direct.has(id) &&
          !(id === refresh && auto.direct.get(id) === null)) ||
        !this.matches({ type: "browser" }, auto.params)
      )
        continue;
      const result = await this.inject(
        "Target.attachToTarget",
        { targetId: id, flatten: true },
        channel,
      );
      if (!record(result) || typeof result.sessionId !== "string")
        throw new Error("Invalid Browser attachment");
      auto.direct.set(id, result.sessionId);
    }
  }

  private refreshedRoot(id: string, selector?: string): boolean {
    if (id === selector) return true;
    const info = this.scope.targets.get(id);
    return (
      selector !== undefined &&
      this.scope.targets.get(selector)?.type === "browser" &&
      info !== undefined &&
      ["tab", "browser", "service_worker", "shared_worker"].includes(info.type)
    );
  }

  private async relatedRoots(
    auto: Extract<AutoAttachment, { kind: "related" }>,
    roots: Map<string, Message>,
  ): Promise<void> {
    for (const [id, waitForDebuggerOnStart] of auto.selectors) {
      if (!(await this.scope.allows(id))) {
        auto.selectors.delete(id);
        continue;
      }
      // Chromium shares the filter across this handler's watched roots.
      const params = { ...auto.params, waitForDebuggerOnStart };
      if (this.scope.targets.get(id)?.type !== "browser") {
        this.mergeRelatedRoot(roots, id, params);
        continue;
      }
      // A native browser selector is global. Tab roots preserve its page/tab
      // attachment level while keeping debugger waits inside this window.
      for (const info of this.scope.targets.values()) {
        if (info.type === "browser" && info.targetId !== id) continue;
        if (!(await this.scope.contains(info))) continue;
        if (info.type === "tab") {
          this.mergeRelatedRoot(roots, info.targetId, {
            ...params,
            targetId: info.targetId,
          });
        } else if (
          ["service_worker", "shared_worker"].includes(info.type) &&
          (this.matches(info, params) || auto.roots.has(info.targetId))
        ) {
          this.mergeRelatedRoot(roots, info.targetId, {
            ...params,
            targetId: info.targetId,
          });
        }
      }
    }
  }

  private mergeRelatedRoot(
    roots: Map<string, Message>,
    id: string,
    params: Message,
  ): void {
    const previous = roots.get(id);
    roots.set(id, {
      ...params,
      targetId: id,
      waitForDebuggerOnStart:
        previous?.waitForDebuggerOnStart === true ||
        params.waitForDebuggerOnStart === true,
    });
  }

  private async reconcile(): Promise<void> {
    if (this.ended) return;
    for (const [channel, visible] of this.visible) {
      if (channel && !this.liveSession(channel)) continue;
      for (const id of visible) {
        const allowed = await this.scope.allows(id);
        if (this.visible.get(channel) !== visible) break;
        if (allowed) continue;
        visible.delete(id);
        this.emit(channel, {
          method: "Target.targetDestroyed",
          params: { targetId: id },
        });
      }
      const discover = this.discovery.get(channel);
      if (discover)
        for (const info of this.scope.targets.values()) {
          if (visible.has(info.targetId) || !this.matches(info, discover))
            continue;
          const allowed = await this.scope.contains(info);
          if (
            this.visible.get(channel) !== visible ||
            this.discovery.get(channel) !== discover
          )
            break;
          if (allowed) {
            visible.add(info.targetId);
            this.emit(channel, {
              method: "Target.targetCreated",
              params: { targetInfo: this.scope.publicInfo(info) },
            });
          }
        }
    }
    await this.retireSessions();
    for (const [channel, auto] of this.autoAttach) {
      if (!channel || this.sessions.get(channel)?.target === null)
        await this.relate(channel, auto);
    }
  }

  private async retireSessions(): Promise<void> {
    for (const [id, session] of this.sessions) {
      // Detaching a native parent also detaches its descendants. Sending a
      // second command through that retired parent races its detach events.
      if (session.parent && !this.liveSession(session.parent)) continue;
      // Native target destruction owns its detach; revalidate the still-live
      // target/session after any asynchronous membership observation as well.
      if (
        session.target !== null &&
        this.scope.targets.has(session.target) &&
        !(await this.scope.allows(session.target)) &&
        this.scope.targets.has(session.target) &&
        this.sessions.get(id) === session
      ) {
        await this.inject(
          "Target.detachFromTarget",
          { sessionId: id },
          session.parent,
        );
      }
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

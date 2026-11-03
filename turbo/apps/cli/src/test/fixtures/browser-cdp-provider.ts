import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import {
  array,
  boolean,
  number,
  object,
  record,
  string,
  unknown as zUnknown,
} from "zod";

const commandSchema = object({
  id: number(),
  method: string(),
  params: record(string(), zUnknown()).default({}),
  sessionId: string().optional(),
});
const filterSchema = array(
  object({ type: string().optional(), exclude: boolean().optional() }),
);
const relatedSchema = object({
  targetId: string(),
  waitForDebuggerOnStart: boolean(),
  filter: filterSchema.optional(),
});
const automaticSchema = object({
  autoAttach: boolean(),
  waitForDebuggerOnStart: boolean(),
  flatten: boolean().optional(),
  filter: filterSchema.optional(),
});

function selectedType(type: string, filter: unknown): boolean {
  const entries = filterSchema.parse(
    filter ?? [
      { type: "browser", exclude: true },
      { type: "tab", exclude: true },
      {},
    ],
  );
  const selected = entries.find((entry) => {
    return entry.type === undefined || entry.type === type;
  });
  return selected !== undefined && selected.exclude !== true;
}
export const EXTENSION_RUNTIME = "abcdefghijklmnopabcdefghijklmnop";
interface Target {
  id: string;
  type: string;
  url: string;
  window: number;
  tab: number;
  page?: string;
  parent?: string;
}
interface Connection {
  socket: WebSocket;
  sessions: Map<string, string>;
  parents: Map<string, string | undefined>;
  discovery: Set<string | undefined>;
  automatic: Map<string | undefined, Set<string>>;
  related: Map<
    string | undefined,
    { filter: unknown; roots: Map<string, boolean> }
  >;
}
interface HeldWindowLookup {
  targetId: string;
  requested(): void;
  respond?: () => void;
}
interface HeldAction {
  requested(): void;
  respond?: (fail?: boolean) => void;
}
interface HeldClose extends HeldAction {
  readonly disconnect: boolean;
}
interface HeldReply {
  readonly method: string;
  readonly targetId: string;
  requested(): void;
  respond?: () => void;
}

/** External Chrome/extension protocol fixture, with real loopback WebSockets. */
export async function browserCdpProvider() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing fixture listener");
  const targets = new Map<string, Target>([
    [
      "BROWSER",
      { id: "BROWSER", type: "browser", url: "", window: -1, tab: -1 },
    ],
    [
      "TAB-A",
      { id: "TAB-A", type: "tab", url: "", window: 0, tab: 1, page: "A" },
    ],
    [
      "TAB-B",
      { id: "TAB-B", type: "tab", url: "", window: 1, tab: 2, page: "B" },
    ],
    [
      "A",
      {
        id: "A",
        type: "page",
        url: "https://example.test/a",
        window: 0,
        tab: 1,
      },
    ],
    [
      "B",
      {
        id: "B",
        type: "page",
        url: "https://example.test/b",
        window: 1,
        tab: 2,
      },
    ],
    [
      "IFRAME-A",
      {
        id: "IFRAME-A",
        type: "iframe",
        url: "https://frame.test/a",
        window: 0,
        tab: 1,
      },
    ],
    [
      "IFRAME-B",
      {
        id: "IFRAME-B",
        type: "iframe",
        url: "https://frame.test/b",
        window: 1,
        tab: 2,
      },
    ],
    [
      "WORKER",
      {
        id: "WORKER",
        type: "service_worker",
        url: `chrome-extension://${EXTENSION_RUNTIME}/background.js`,
        window: -1,
        tab: -1,
      },
    ],
    [
      "SHARED",
      {
        id: "SHARED",
        type: "shared_worker",
        url: "https://example.test/shared.js",
        window: -1,
        tab: -1,
      },
    ],
  ]);
  const connections = new Set<Connection>();
  const attachments: {
    targetId: string;
    waitingForDebugger: boolean;
  }[] = [];
  const commands: {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  let sequence = 0;
  let nextSession = 0;
  let nextTarget = 0;
  let rejectRelated = false;
  let rejectDetach = false;
  let heldWindowLookup: HeldWindowLookup | undefined;
  let heldNavigation: HeldAction | undefined;
  const heldCloses = new Map<string, HeldClose>();
  let heldReply: HeldReply | undefined;
  const bounds = new Map<number, Record<string, unknown>>([
    [0, {}],
    [1, {}],
  ]);
  const info = (target: Target) => {
    return {
      targetId: target.id,
      type: target.type,
      url: target.url,
      title: "private-title",
      browserContextId: "default",
      ...(target.parent ? { parentId: target.parent } : {}),
    };
  };
  const send = (connection: Connection, value: unknown) => {
    if (connection.socket.readyState === connection.socket.OPEN)
      connection.socket.send(JSON.stringify(value));
  };
  function broadcast(method: string, params: Record<string, unknown>) {
    for (const connection of connections)
      for (const sessionId of connection.discovery)
        send(connection, {
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        });
  }
  function native(kind: string, details: Record<string, unknown>) {
    sequence++;
    for (const connection of connections)
      for (const [sessionId, target] of connection.sessions)
        if (target === "WORKER")
          send(connection, {
            sessionId,
            method: "Runtime.bindingCalled",
            params: {
              name: "__okouBrowserEvent",
              payload: JSON.stringify({
                epoch: "fixture",
                sequence,
                kind,
                ...details,
              }),
            },
          });
  }
  function move(id: string, window: number) {
    const target = targets.get(id);
    if (!target) throw new Error("Missing external fixture target");
    const oldWindowId = target.window;
    for (const candidate of targets.values())
      if (candidate.tab === target.tab) candidate.window = window;
    native("tab-detached", { tabId: target.tab, oldWindowId });
    native("tab-attached", {
      tabId: target.tab,
      windowId: window,
      oldWindowId,
    });
    // A window move need not change CDP TargetInfo; native events own that fact.
  }
  function tab(target: Target) {
    return {
      id: target.tab,
      windowId: target.window,
      index: 0,
      active: true,
      pinned: false,
      discarded: false,
      url: target.url,
    };
  }
  function attach(
    connection: Connection,
    targetId: string,
    parent?: string,
    automatic = false,
    waitingForDebugger = false,
  ) {
    if (automatic)
      for (const id of connection.automatic.get(parent) ?? [])
        if (connection.sessions.get(id) === targetId) return { sessionId: id };
    const sessionId = "session-" + ++nextSession;
    connection.sessions.set(sessionId, targetId);
    connection.parents.set(sessionId, parent);
    if (automatic) {
      let entries = connection.automatic.get(parent);
      if (!entries) connection.automatic.set(parent, (entries = new Set()));
      entries.add(sessionId);
    }
    const target = targets.get(targetId);
    if (target) {
      attachments.push({ targetId, waitingForDebugger });
      send(connection, {
        method: "Target.attachedToTarget",
        sessionId: parent,
        params: {
          sessionId,
          targetInfo: info(target),
          waitingForDebugger,
        },
      });
    }
    return { sessionId };
  }
  function publish(target: Target) {
    targets.set(target.id, target);
    broadcast("Target.targetCreated", { targetInfo: info(target) });
    for (const connection of connections)
      for (const [channel, handler] of connection.related) {
        if (!selectedType(target.type, handler.filter)) continue;
        for (const [id, wait] of handler.roots) {
          const root = targets.get(id);
          if (
            root?.type === "browser" ||
            target.parent === id ||
            (root?.type === "tab" && target.tab === root.tab)
          )
            attach(connection, target.id, channel, true, wait);
        }
      }
  }
  function detach(
    connection: Connection,
    sessionId: string,
    parent = connection.parents.get(sessionId),
    notify = (message: unknown) => {
      return send(connection, message);
    },
  ) {
    for (const [child, owner] of connection.parents)
      if (owner === sessionId) detach(connection, child, sessionId, notify);
    connection.automatic.delete(sessionId);
    connection.related.delete(sessionId);
    connection.sessions.delete(sessionId);
    connection.parents.delete(sessionId);
    for (const entries of connection.automatic.values())
      entries.delete(sessionId);
    notify({
      method: "Target.detachedFromTarget",
      sessionId: parent,
      params: { sessionId },
    });
  }
  function destroyTarget(
    targetId: string,
    deferDetach = false,
    deferDestroyed = false,
  ) {
    const target = targets.get(targetId);
    const retired =
      target && ["page", "tab"].includes(target.type)
        ? [...targets.values()].filter((candidate) => {
            return candidate.tab === target.tab;
          })
        : target
          ? [target]
          : [];
    for (const candidate of retired) targets.delete(candidate.id);
    if (target && ["page", "tab"].includes(target.type))
      native("tab-removed", { tabId: target.tab, windowId: target.window });
    const notifications: (() => void)[] = [];
    for (const candidate of retired) {
      for (const connection of connections) {
        for (const handler of connection.related.values())
          handler.roots.delete(candidate.id);
        for (const [sessionId, target] of connection.sessions)
          if (target === candidate.id)
            detach(
              connection,
              sessionId,
              connection.parents.get(sessionId),
              (event) => {
                notifications.push(() => {
                  return send(connection, event);
                });
              },
            );
      }
      const notify = () => {
        return broadcast("Target.targetDestroyed", { targetId: candidate.id });
      };
      if (deferDestroyed) notifications.push(notify);
      else notify();
    }
    const resume = () => {
      for (const notify of notifications.splice(0)) notify();
    };
    if (!deferDetach) resume();
    if (
      target &&
      target.window >= 0 &&
      ![...targets.values()].some((candidate) => {
        return candidate.type === "page" && candidate.window === target.window;
      })
    )
      native("window-removed", { windowId: target.window });
    return { resume };
  }
  server.on("connection", (socket) => {
    const connection: Connection = {
      socket,
      sessions: new Map(),
      parents: new Map(),
      discovery: new Set(),
      automatic: new Map(),
      related: new Map(),
    };
    connections.add(connection);
    socket.on("close", () => {
      return connections.delete(connection);
    });
    socket.on("message", (data) => {
      const command = commandSchema.parse(JSON.parse(data.toString()));
      const { id, method, params, sessionId } = command;
      commands.push({ method, params, sessionId });
      const respond = (response: Record<string, unknown>) => {
        const held = heldReply;
        if (held && held.method === method && held.targetId === selected) {
          held.respond = () => {
            send(connection, { id, sessionId, ...response });
          };
          held.requested();
          return;
        }
        return send(connection, { id, sessionId, ...response });
      };
      const reply = (result: unknown) => {
        return respond({ result });
      };
      const fail = (code: number, message: string, extra?: unknown) => {
        return respond({
          error: {
            code,
            message,
            ...(extra === undefined ? {} : { data: extra }),
          },
        });
      };
      const selected = sessionId
        ? connection.sessions.get(sessionId)
        : "BROWSER";
      if (sessionId && !selected) {
        fail(-32001, "Native session not found");
        return;
      }
      const handlers: Record<string, () => void> = {
        "Target.attachToBrowserTarget": () => {
          const attached = "browser-" + ++nextSession;
          connection.sessions.set(attached, "BROWSER");
          connection.parents.set(attached, sessionId);
          reply({ sessionId: attached });
        },
        "Target.getTargets": () => {
          reply({
            targetInfos: [...targets.values()]
              .filter((target) => {
                return selectedType(target.type, params.filter);
              })
              .map(info),
            extra: "native-result-field",
          });
        },
        "Target.getTargetInfo": () => {
          const target = targets.get(String(params.targetId ?? selected));
          if (target) reply({ targetInfo: info(target) });
          else fail(-32000, "No target with given id");
        },
        "Target.setDiscoverTargets": () => {
          if (params.discover) {
            connection.discovery.add(sessionId);
            for (const target of targets.values()) {
              if (!selectedType(target.type, params.filter)) continue;
              send(connection, {
                sessionId,
                method: "Target.targetCreated",
                params: { targetInfo: info(target) },
              });
            }
          } else connection.discovery.delete(sessionId);
          reply({});
        },
        "Target.attachToTarget": () => {
          if (
            params.flatten !== undefined &&
            typeof params.flatten !== "boolean"
          ) {
            fail(-32602, "Native invalid flatten parameter");
            return;
          }
          if (!targets.has(String(params.targetId)))
            fail(-32000, "No target with given id");
          else reply(attach(connection, String(params.targetId), sessionId));
        },
        "Target.detachFromTarget": () => {
          if (rejectDetach) {
            rejectDetach = false;
            fail(-32000, "Native detach unavailable");
            return;
          }
          if (!connection.sessions.has(String(params.sessionId))) {
            fail(-32602, "No session with given id");
            return;
          }
          detach(connection, String(params.sessionId), sessionId);
          reply({});
        },
        "Target.setAutoAttach": () => {
          const valid = automaticSchema.safeParse(params);
          if (!valid.success) {
            fail(-32602, "Native invalid auto-attach parameters");
            return;
          }
          if (!params.autoAttach && valid.data.filter?.length) {
            fail(-32602, "Native filter when disabling auto-attach");
            return;
          }
          if (
            selected === "BROWSER" &&
            selectedType("tab", params.filter) &&
            selectedType("page", params.filter)
          ) {
            fail(-32602, "Native incompatible tab/page filter");
            return;
          }
          if (params.autoAttach === false) {
            for (const entry of connection.automatic.get(sessionId) ?? [])
              detach(connection, entry, sessionId);
            connection.automatic.delete(sessionId);
            connection.related.delete(sessionId);
            reply({});
          } else if (selected === "BROWSER")
            fail(-32000, "Global auto-attach would pause sibling pages");
          else {
            const child = targets.get("IFRAME-" + selected);
            if (child && selectedType(child.type, params.filter))
              attach(connection, child.id, sessionId, true);
            reply({});
          }
        },
        "Target.autoAttachRelated": () => {
          if (!relatedSchema.safeParse(params).success) {
            fail(-32602, "Native invalid related parameters");
            return;
          }
          if (rejectRelated) {
            rejectRelated = false;
            fail(-32000, "Native related selection unavailable", {
              original: true,
            });
            return;
          }
          const target = String(params.targetId);
          const root = targets.get(target);
          let handler = connection.related.get(sessionId);
          if (!handler) {
            handler = { filter: params.filter, roots: new Map() };
            connection.related.set(sessionId, handler);
          }
          const added = !handler.roots.has(target);
          handler.filter = params.filter;
          handler.roots.set(target, params.waitForDebuggerOnStart === true);
          if (root && selectedType(root.type, params.filter))
            attach(connection, target, sessionId, true);
          const child = targets.get(root?.page ?? "IFRAME-" + target);
          if (added && child && selectedType(child.type, params.filter))
            attach(
              connection,
              child.id,
              sessionId,
              true,
              params.waitForDebuggerOnStart === true,
            );
          reply({});
        },
        "ServiceWorker.enable": () => {
          send(connection, {
            sessionId,
            method: "ServiceWorker.workerVersionUpdated",
            params: {
              versions: [
                {
                  scriptURL: targets.get("WORKER")!.url,
                  runningStatus: "running",
                  targetId: "WORKER",
                },
              ],
            },
          });
          reply({});
        },
        "Browser.getWindowForTarget": () => {
          const respond = () => {
            const target = targets.get(String(params.targetId));
            if (target && target.window >= 0)
              reply({ windowId: target.window, bounds: {} });
            else fail(-32000, "No browser window for target");
          };
          const held = heldWindowLookup;
          if (held && held.targetId === params.targetId) {
            held.respond = respond;
            held.requested();
          } else respond();
        },
        "Browser.getWindowBounds": () => {
          reply({ bounds: bounds.get(Number(params.windowId)) });
        },
        "Browser.setWindowBounds": () => {
          bounds.set(
            Number(params.windowId),
            params.bounds as Record<string, unknown>,
          );
          reply({});
        },
        "Browser.setContentsSize": () => {
          bounds.set(Number(params.windowId), {
            width: params.width,
            height: params.height,
          });
          reply({});
        },
        "Target.createTarget": () => {
          const target: Target = {
            id: "new-" + ++nextTarget,
            type: "page",
            url: String(params.url),
            window: 1,
            tab: nextTarget + 10,
          };
          targets.set(target.id, target);
          broadcast("Target.targetCreated", { targetInfo: info(target) });
          reply({ targetId: target.id });
        },
        "Target.closeTarget": () => {
          if (!targets.has(String(params.targetId))) {
            fail(-32000, "No target with given id");
            return;
          }
          const held = heldCloses.get(String(params.targetId));
          if (held) {
            held.respond = () => {
              destroyTarget(String(params.targetId));
            };
            held.requested();
          } else destroyTarget(String(params.targetId));
          if (held?.disconnect) {
            connection.socket.close();
            return;
          }
          reply({ success: true });
        },
        "Page.close": () => {
          const target = targets.get(selected ?? "");
          if (target?.type === "iframe") {
            fail(-32000, "Command can only be executed on top-level targets");
            return;
          }
          const page = target;
          if (page?.type !== "page") {
            fail(-32601, "Page.close is unavailable");
            return;
          }
          const held = heldCloses.get(page.id);
          if (held) {
            held.respond = () => {
              destroyTarget(page.id);
            };
            held.requested();
          } else destroyTarget(page.id);
          if (held?.disconnect) {
            connection.socket.close();
            return;
          }
          reply({});
        },
        "Page.navigate": () => {
          const navigate = (reject = false) => {
            if (reject) {
              fail(-32000, "Native navigation failed");
              return;
            }
            const target = targets.get(selected ?? "");
            if (target) {
              target.url = String(params.url);
              broadcast("Target.targetInfoChanged", {
                targetInfo: info(target),
              });
            }
            reply({ frameId: selected });
          };
          if (heldNavigation && !heldNavigation.respond) {
            heldNavigation.respond = navigate;
            heldNavigation.requested();
          } else navigate();
        },
        "Runtime.evaluate": () => {
          if (
            typeof params.expression !== "string" ||
            !params.expression.startsWith("globalThis.__okouBrowser?.invoke(")
          ) {
            reply({ result: { type: "string", value: params.expression } });
            return;
          }
          const request = object({ method: string() })
            .passthrough()
            .parse(
              JSON.parse(
                params.expression.slice(
                  "globalThis.__okouBrowser?.invoke(".length,
                  -1,
                ),
              ),
            );
          let value: unknown;
          if (request.method === "hello")
            value = {
              protocol: 1,
              capabilities: ["windows", "tabs", "events"],
            };
          else if (request.method === "getWindow")
            value = [...targets.values()].some((target) => {
              return (
                target.type === "page" && target.window === request.windowId
              );
            })
              ? {
                  id: request.windowId,
                  tabs: [...targets.values()]
                    .filter((target) => {
                      return (
                        target.type === "page" &&
                        target.window === request.windowId
                      );
                    })
                    .map(tab),
                }
              : null;
          else if (request.method === "moveTabs") {
            const ids = request.tabIds;
            const candidate = [...targets.values()].find((target) => {
              return (
                target.type === "page" &&
                Array.isArray(ids) &&
                ids.includes(target.tab)
              );
            });
            if (candidate) {
              move(candidate.id, Number(request.windowId));
              value = [tab(candidate)];
            }
          } else if (request.method === "closeWindow") {
            for (const target of targets.values())
              if (target.window === request.windowId) targets.delete(target.id);
            native("window-removed", { windowId: request.windowId });
            value = null;
          }

          reply({
            result: {
              type: "object",
              value: {
                ok: true,
                epoch: "fixture",
                startedSequence: sequence,
                sequence,
                value,
              },
            },
          });
        },
        "Future.echo": () => {
          reply({ opaque: params });
        },
        "Future.error": () => {
          fail(-32601, "Native error remains unchanged", { original: true });
        },
      };
      const handler = handlers[method];
      if (handler) handler();
      else reply({});
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    commands,
    attachments,
    move,
    destroyTarget,
    addFrame(parent: string, id: string) {
      const page = targets.get(parent);
      if (!page) throw new Error("Missing parent fixture page");
      publish({
        id,
        type: "iframe",
        url: "https://frame.test/" + id,
        window: page.window,
        tab: page.tab,
        parent,
      });
    },
    addPage(id: string, window: number) {
      const tab = ++nextTarget + 100;
      publish({ id: "TAB-" + id, type: "tab", url: "", window, tab, page: id });
      publish({
        id,
        type: "page",
        url: "https://example.test/" + id,
        window,
        tab,
      });
    },
    rejectNextRelated() {
      rejectRelated = true;
    },
    rejectNextDetach() {
      rejectDetach = true;
    },
    holdNextNavigation() {
      if (heldNavigation)
        throw new Error("A native navigation is already held");
      let requested!: () => void;
      const observed = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const held: HeldAction = { requested };
      heldNavigation = held;
      return {
        observed,
        resume(fail = false) {
          heldNavigation = undefined;
          const respond = held.respond;
          held.respond = undefined;
          respond?.(fail);
        },
      };
    },
    holdReply(method: string, targetId: string) {
      if (heldReply) throw new Error("A native reply is already held");
      let requested!: () => void;
      const observed = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const held: HeldReply = { method, targetId, requested };
      heldReply = held;
      return {
        observed,
        resume() {
          heldReply = undefined;
          const respond = held.respond;
          held.respond = undefined;
          respond?.();
        },
      };
    },
    holdClose(targetId: string, disconnect = false) {
      if (heldCloses.has(targetId))
        throw new Error("A native close is already held");
      let requested!: () => void;
      const observed = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const held: HeldClose = { requested, disconnect };
      heldCloses.set(targetId, held);
      return {
        observed,
        resume() {
          heldCloses.delete(targetId);
          const respond = held.respond;
          held.respond = undefined;
          respond?.();
        },
      };
    },
    holdWindowLookup(targetId: string) {
      if (heldWindowLookup) throw new Error("A window lookup is already held");
      let requested!: () => void;
      const observed = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const held: HeldWindowLookup = { targetId, requested };
      heldWindowLookup = held;
      return {
        observed,
        resume() {
          heldWindowLookup = undefined;
          held.respond?.();
        },
      };
    },
    hasWindow: (windowId: number) => {
      return [...targets.values()].some((target) => {
        return target.type === "page" && target.window === windowId;
      });
    },
    async close() {
      heldReply?.respond?.();
      heldReply = undefined;
      heldNavigation?.respond?.(true);
      heldNavigation = undefined;
      for (const held of heldCloses.values()) held.respond?.();
      heldCloses.clear();
      heldWindowLookup?.respond?.();
      heldWindowLookup = undefined;
      for (const connection of connections) connection.socket.terminate();
      await new Promise<void>((resolve, reject) => {
        return server.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
    },
  };
}

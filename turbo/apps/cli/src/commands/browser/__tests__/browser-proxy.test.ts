import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ws } from "msw";
import { server } from "../../../mocks/server";
import {
  browserCdpProvider,
  EXTENSION_RUNTIME,
} from "../../../test/fixtures/browser-cdp-provider";
import { startWindowProxy } from "../proxy/server";

interface Message {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}
const unavailableTargetError = {
  code: -32000,
  message:
    "The target is unavailable in this chat's Browser connection; get current targets from this connection",
};
const unavailableSessionError = {
  code: -32000,
  message:
    "The session is unavailable in this chat's Browser connection; attach to a current target before sending session commands",
};
const unconfirmedOperationError = {
  code: -32000,
  message:
    "Scoped Browser operation could not be confirmed; inspect before retrying",
};

async function client(endpoint: string) {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => {
        return resolve();
      },
      { once: true },
    );
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: unknown): void;
    }
  >();
  const listeners = new Set<(message: Message) => void>();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data)) as Message;
    const entry =
      message.id === undefined ? undefined : pending.get(message.id);
    if (entry) {
      pending.delete(message.id!);
      if (message.error) entry.reject(message.error);
      else entry.resolve(message.result ?? {});
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values())
      entry.reject(new Error("Fixture connection closed"));
    pending.clear();
  });
  return {
    socket,
    listeners,
    request(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
      id = ++sequence,
    ) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    event(predicate: (message: Message) => boolean) {
      return new Promise<Message>((resolve) => {
        const listener = (message: Message) => {
          if (predicate(message)) {
            listeners.delete(listener);
            resolve(message);
          }
        };
        listeners.add(listener);
      });
    },
    close() {
      socket.close();
    },
  };
}

/** Complex protocol/session state machine; Chrome/extension IO stays external. */
describe("chat-window CDP proxy protocol", () => {
  let provider: Awaited<ReturnType<typeof browserCdpProvider>>;
  let proxy: Awaited<ReturnType<typeof startWindowProxy>>;
  const clients: Awaited<ReturnType<typeof client>>[] = [];
  let connection: Awaited<ReturnType<typeof client>>;
  beforeEach(async () => {
    provider = await browserCdpProvider();
    server.use(
      ws
        .link(provider.endpoint)
        .addEventListener("connection", ({ server: remote }) => {
          return remote.connect();
        }),
    );
    proxy = await startWindowProxy(
      { cdpUrl: provider.endpoint, runtimeId: EXTENSION_RUNTIME, windowId: 0 },
      new AbortController().signal,
    );
    server.use(
      ws
        .link(proxy.endpoint)
        .addEventListener("connection", ({ server: remote }) => {
          return remote.connect();
        }),
    );
    connection = await client(proxy.endpoint);
    clients.push(connection);
  });
  afterEach(async () => {
    for (const connection of clients.splice(0)) connection.close();
    await proxy?.close();
    await provider?.close();
  });

  it("filters native page and unattributed iframe discovery while preserving result fields and global workers", async () => {
    const result = await connection.request("Target.getTargets");
    expect(result.extra).toBe("native-result-field");
    expect(result.targetInfos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: "A" }),
        expect.objectContaining({ targetId: "SHARED" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /IFRAME-B|IFRAME-A|chrome-extension|targetId":"B"/u,
    );
    await expect(
      connection.request("Target.attachToTarget", {
        targetId: "B",
        flatten: true,
      }),
    ).rejects.toStrictEqual(unavailableTargetError);
    await expect(
      connection.request("Target.attachToTarget", {
        targetId: "unknown-target",
        flatten: true,
      }),
    ).rejects.toStrictEqual(unavailableTargetError);
  });

  it("passes opaque identifiers/unknown methods and native error data unchanged", async () => {
    const params = {
      targetId: "B",
      frameId: "foreign-looking",
      sessionId: "opaque-business-id",
      nested: { objectId: "unchanged" },
    };
    expect(await connection.request("Future.echo", params)).toStrictEqual({
      opaque: params,
    });
    await expect(
      connection.request("Future.error", params),
    ).rejects.toStrictEqual({
      code: -32601,
      message: "Native error remains unchanged",
      data: { original: true },
    });
    await expect(
      connection.request("Runtime.enable", {}, "unknown-session"),
    ).rejects.toStrictEqual(unavailableSessionError);
  });

  it("explains unavailable child sessions without borrowing another peer's attachment", async () => {
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const { sessionId } = await peer.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    await expect(
      connection.request("Target.detachFromTarget", { sessionId }),
    ).rejects.toStrictEqual(unavailableSessionError);
    await expect(
      connection.request("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: 51, method: "Runtime.enable" }),
      }),
    ).rejects.toStrictEqual(unavailableSessionError);
    await expect(
      connection.request("Target.sendMessageToTarget", {
        targetId: "A",
        message: JSON.stringify({ id: 52, method: "Runtime.enable" }),
      }),
    ).rejects.toStrictEqual(unavailableSessionError);
    expect(
      provider.commands.filter((command) => {
        return (
          command.method === "Target.sendMessageToTarget" ||
          (command.method === "Target.detachFromTarget" &&
            command.params.sessionId === sessionId)
        );
      }),
    ).toStrictEqual([]);
    expect(
      await peer.request("Runtime.enable", {}, String(sessionId)),
    ).toStrictEqual({});
  });

  it.each([
    { browserSession: false, timing: "before" },
    { browserSession: true, timing: "before" },
    { browserSession: false, timing: "removal" },
    { browserSession: true, timing: "removal" },
    { browserSession: false, timing: "addition" },
    { browserSession: true, timing: "addition" },
  ])(
    "stops discovery notifications after cancellation (browser session=$browserSession, timing=$timing)",
    async ({ browserSession, timing }) => {
      const browser = String(
        (await connection.request("Target.attachToBrowserTarget")).sessionId,
      );
      const cancelled = browserSession ? browser : undefined;
      const active = browserSession ? undefined : browser;
      const created = await connection.request("Target.createTarget", {
        url: "about:blank",
      });
      for (const channel of [cancelled, active])
        await connection.request(
          "Target.setDiscoverTargets",
          { discover: true, filter: [{ type: "tab" }, { type: "page" }] },
          channel,
        );
      const cancel = () => {
        return connection.request(
          "Target.setDiscoverTargets",
          { discover: false },
          cancelled,
        );
      };
      if (timing === "before") await cancel();
      const cancelledEvents: Message[] = [];
      const listen = (message: Message) => {
        if (message.sessionId === cancelled) cancelledEvents.push(message);
      };
      connection.listeners.add(listen);
      const entering = timing === "addition";
      const reconciled = connection.event((message) => {
        return (
          message.method ===
            (entering ? "Target.targetCreated" : "Target.targetDestroyed") &&
          message.sessionId === active &&
          (entering
            ? (message.params?.targetInfo as { targetId?: string })
                ?.targetId === "TAB-B"
            : message.params?.targetId === "TAB-A")
        );
      });
      const held =
        timing === "before"
          ? undefined
          : provider.holdWindowLookup(entering ? "TAB-B" : "TAB-A");
      provider.move(entering ? "B" : "A", entering ? 0 : 1);
      if (held) {
        await held.observed;
        await cancel();
        held.resume();
      }
      // The other channel's synthetic event proves native reconciliation began.
      // Await this peer's queued control work before asserting cancellation.
      await reconciled;
      await connection.request("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      connection.listeners.delete(listen);
      expect(
        cancelledEvents.filter((message) => {
          return ["Target.targetCreated", "Target.targetDestroyed"].includes(
            String(message.method),
          );
        }),
      ).toStrictEqual([]);
      expect(
        (await connection.request("Target.getTargets")).targetInfos,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetId: created.targetId }),
        ]),
      );
    },
  );

  it("supports flat sessions without a membership request for every input", async () => {
    const { sessionId } = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    const lookups = provider.commands.filter((command) => {
      return command.method === "Browser.getWindowForTarget";
    }).length;
    for (let i = 0; i < 5; i++) {
      expect(
        await connection.request(
          "Runtime.evaluate",
          { expression: "opaque input" },
          String(sessionId),
        ),
      ).toStrictEqual({ result: { type: "string", value: "opaque input" } });
      await connection.request(
        "Input.insertText",
        { text: "中文" },
        String(sessionId),
      );
    }
    expect(
      provider.commands.filter((command) => {
        return command.method === "Browser.getWindowForTarget";
      }),
    ).toHaveLength(lookups);
  });

  it("preserves native errors for invalid adapted attachment parameters", async () => {
    await expect(
      connection.request("Target.setAutoAttach", {
        autoAttach: "invalid",
        waitForDebuggerOnStart: false,
      }),
    ).rejects.toStrictEqual({
      code: -32602,
      message: "Native invalid auto-attach parameters",
    });
    await expect(
      connection.request("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: "invalid",
      }),
    ).rejects.toStrictEqual({
      code: -32602,
      message: "Native invalid auto-attach parameters",
    });
    await expect(
      connection.request("Target.attachToTarget", {
        targetId: "A",
        flatten: "invalid",
      }),
    ).rejects.toStrictEqual({
      code: -32602,
      message: "Native invalid flatten parameter",
    });
    expect(
      await connection.request("Future.echo", { targetId: "still-opaque" }),
    ).toStrictEqual({ opaque: { targetId: "still-opaque" } });
  });

  it("keeps concurrent negative client IDs distinct from private creation requests", async () => {
    const [created, echoed, error] = await Promise.all([
      connection.request("Target.createTarget", { url: "about:blank" }),
      connection.request("Future.echo", { id: "opaque" }, undefined, -1),
      connection
        .request("Future.error", {}, undefined, -2)
        .catch((error: unknown) => {
          return error;
        }),
    ]);
    expect(created.targetId).toEqual(expect.any(String));
    expect(echoed).toStrictEqual({ opaque: { id: "opaque" } });
    expect(error).toStrictEqual({
      code: -32601,
      message: "Native error remains unchanged",
      data: { original: true },
    });
  });

  it("encodes legacy nested sessions while preserving nested command IDs", async () => {
    const { sessionId } = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: false,
    });
    const reply = connection.event((message) => {
      return (
        message.method === "Target.receivedMessageFromTarget" &&
        message.params?.sessionId === sessionId
      );
    });
    expect(
      await connection.request("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 771,
          method: "Future.echo",
          params: { targetId: "opaque" },
        }),
      }),
    ).toStrictEqual({});
    expect(JSON.parse(String((await reply).params?.message))).toStrictEqual({
      id: 771,
      result: { opaque: { targetId: "opaque" } },
    });
  });

  it("keeps browser attachment non-recursive and admits page-level iframe sessions", async () => {
    const roots: unknown[] = [];
    const observe = (message: Message) => {
      if (message.method === "Target.attachedToTarget" && !message.sessionId)
        roots.push(
          (message.params?.targetInfo as { targetId?: string })?.targetId,
        );
    };
    connection.listeners.add(observe);
    await connection.request("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await connection.request("Target.getTargets");
    connection.listeners.delete(observe);
    expect(roots).toStrictEqual(expect.arrayContaining(["A", "SHARED"]));
    expect(roots).not.toContain("IFRAME-A");
    const parent = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    const attached = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        message.sessionId === parent.sessionId &&
        (message.params?.targetInfo as { targetId?: string })?.targetId ===
          "IFRAME-A"
      );
    });
    await connection.request(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      String(parent.sessionId),
    );
    const event = await attached;
    await connection.request(
      "Runtime.enable",
      {},
      String(event.params?.sessionId),
    );
    expect(
      provider.commands
        .filter((command) => {
          return command.method === "Target.autoAttachRelated";
        })
        .map((command) => {
          return command.params.targetId;
        }),
    ).toEqual(expect.arrayContaining(["A"]));
    expect(
      provider.commands.filter((command) => {
        return (
          command.method === "Target.setAutoAttach" &&
          command.params.autoAttach === true &&
          command.sessionId === undefined
        );
      }),
    ).toStrictEqual([]);
    const inventory = await connection.request("Target.getTargets");
    expect(JSON.stringify(inventory)).not.toContain("IFRAME-B");
  });

  it.each([
    { filter: [{ type: "page" }, { exclude: true }], roots: ["A"] },
    { filter: [{ type: "iframe" }, { exclude: true }], roots: [] },
    { filter: [], roots: [] },
  ])(
    "supports native browser filters without recursive attachment: %j",
    async ({ filter, roots }) => {
      await connection.request("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter,
      });
      await connection.request("Target.getTargets");
      expect(
        provider.commands
          .filter((command) => {
            return command.method === "Target.autoAttachRelated";
          })
          .map((command) => {
            return command.params.targetId;
          }),
      ).toStrictEqual(roots);
    },
  );

  it.each([
    {
      autoAttach: true,
      filter: [{}],
      error: "Native incompatible tab/page filter",
    },
    {
      autoAttach: false,
      filter: [{ type: "page" }],
      error: "Native filter when disabling auto-attach",
    },
  ])(
    "preserves native filter errors and existing sessions: %j",
    async ({ autoAttach, filter, error }) => {
      const attached = connection.event((message) => {
        return (
          message.method === "Target.attachedToTarget" &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "A"
        );
      });
      await connection.request("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const original = await attached;
      await expect(
        connection.request("Target.setAutoAttach", {
          autoAttach,
          filter,
          waitForDebuggerOnStart: false,
          flatten: true,
        }),
      ).rejects.toStrictEqual({ code: -32602, message: error });
      expect(
        await connection.request(
          "Runtime.enable",
          {},
          String(original.params?.sessionId),
        ),
      ).toStrictEqual({});
    },
  );

  it("retains legacy envelope mode for child auto-attachments arriving before their response", async () => {
    const parent = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: false,
    });
    const attached = connection.event((message) => {
      return (
        message.method === "Target.receivedMessageFromTarget" &&
        message.params?.sessionId === parent.sessionId &&
        JSON.parse(String(message.params?.message)).method ===
          "Target.attachedToTarget"
      );
    });
    await connection.request("Target.sendMessageToTarget", {
      sessionId: parent.sessionId,
      message: JSON.stringify({
        id: 871,
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: false,
        },
      }),
    });
    const child = JSON.parse(String((await attached).params?.message)).params
      .sessionId;
    const replied = connection.event((message) => {
      if (
        message.method !== "Target.receivedMessageFromTarget" ||
        message.params?.sessionId !== parent.sessionId
      )
        return false;
      const nested = JSON.parse(String(message.params?.message));
      return (
        nested.method === "Target.receivedMessageFromTarget" &&
        nested.params.sessionId === child &&
        JSON.parse(nested.params.message).id === 872
      );
    });
    await connection.request("Target.sendMessageToTarget", {
      sessionId: child,
      message: JSON.stringify({
        id: 872,
        method: "Future.echo",
        params: { value: "nested-child" },
      }),
    });
    const nested = JSON.parse(String((await replied).params?.message));
    expect(JSON.parse(nested.params.message)).toStrictEqual({
      id: 872,
      result: { opaque: { value: "nested-child" } },
    });
    await connection.request("Target.detachFromTarget", {
      sessionId: parent.sessionId,
    });
    await expect(
      connection.request("Future.echo", {}, child),
    ).rejects.toMatchObject({ code: -32000 });
    expect(
      await connection.request("Future.echo", { value: "still-connected" }),
    ).toStrictEqual({ opaque: { value: "still-connected" } });
  });

  it.each([
    { channel: "root", automatic: false },
    { channel: "root", automatic: true },
    { channel: "browser", automatic: true },
  ])(
    "keeps an explicit related selector narrow ($channel, automatic=$automatic)",
    async ({ channel, automatic }) => {
      const session =
        channel === "browser"
          ? String(
              (await connection.request("Target.attachToBrowserTarget"))
                .sessionId,
            )
          : undefined;
      await connection.request(
        "Target.setDiscoverTargets",
        { discover: true },
        session,
      );
      if (automatic)
        await connection.request(
          "Target.setAutoAttach",
          {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
          },
          session,
        );
      const start = provider.commands.length;
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "A",
          waitForDebuggerOnStart: false,
        },
        session,
      );
      const discovered = connection.event((message) => {
        return (
          message.method === "Target.targetCreated" &&
          message.sessionId === session &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "B"
        );
      });
      provider.move("B", 0);
      // This synthetic discovery proves reconciliation has begun; disabling then
      // waits for that channel's current selector work to complete.
      await discovered;
      await connection.request(
        "Target.setAutoAttach",
        {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        session,
      );
      expect(
        provider.commands
          .slice(start)
          .filter((command) => {
            return command.method === "Target.autoAttachRelated";
          })
          .map((command) => {
            return command.params.targetId;
          }),
      ).toStrictEqual(["A"]);
    },
  );

  it.each([
    { filter: undefined, page: true, tab: false },
    { filter: [{}], page: true, tab: true },
    { filter: [{ type: "page" }], page: true, tab: false },
    { filter: [{ type: "iframe" }], page: false, tab: false },
    { filter: [{ type: "tab" }], page: false, tab: true },
  ])(
    "scopes explicit browser-root related selection without a global subscription: %j",
    async ({ filter, page, tab }) => {
      const seen = new Map<string, string>();
      const listener = (message: Message) => {
        if (message.method === "Target.attachedToTarget") {
          const target = message.params?.targetInfo as { targetId: string };
          seen.set(target.targetId, String(message.params?.sessionId));
        }
      };
      connection.listeners.add(listener);
      await connection.request("Target.autoAttachRelated", {
        targetId: "BROWSER",
        waitForDebuggerOnStart: true,
        ...(filter === undefined ? {} : { filter }),
      });
      await connection.request("Target.getTargets");
      connection.listeners.delete(listener);
      expect(seen.has("A")).toBe(page);
      expect(seen.has("TAB-A")).toBe(tab);
      expect(seen.has("B")).toBe(false);
      expect(seen.has("TAB-B")).toBe(false);
      expect(seen.has("IFRAME-A")).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps browser-root and explicit page/tab selectors active together (browser session=%s)",
    async (browserSession) => {
      const channel = browserSession
        ? String(
            (await connection.request("Target.attachToBrowserTarget"))
              .sessionId,
          )
        : undefined;
      const attached = connection.event((message) => {
        return (
          message.method === "Target.attachedToTarget" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "A"
        );
      });
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "BROWSER",
          waitForDebuggerOnStart: false,
        },
        channel,
      );
      const page = await attached;
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "A",
          waitForDebuggerOnStart: false,
          filter: [{ type: "iframe" }],
        },
        channel,
      );
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "TAB-A",
          waitForDebuggerOnStart: false,
          filter: [{ type: "iframe" }],
        },
        channel,
      );
      await connection.request("Target.getTargets", {}, channel);
      expect(
        await connection.request(
          "Runtime.enable",
          {},
          String(page.params?.sessionId),
        ),
      ).toStrictEqual({});
      await connection.request(
        "Target.setDiscoverTargets",
        { discover: true },
        channel,
      );
      const entered = connection.event((message) => {
        return (
          message.method === "Target.targetCreated" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "B"
        );
      });
      const start = provider.attachments.length;
      provider.move("B", 0);
      await entered;
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "TAB-A",
          waitForDebuggerOnStart: false,
          filter: [{ type: "iframe" }],
        },
        channel,
      );
      expect(
        provider.attachments.slice(start).some(({ targetId }) => {
          return targetId === "B";
        }),
      ).toBe(false);
    },
  );

  it("restores explicit subscriptions after browser-root selection fails", async () => {
    await connection.request("Target.autoAttachRelated", {
      targetId: "A",
      waitForDebuggerOnStart: false,
      filter: [{ type: "page" }],
    });
    const recovered = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId === "A"
      );
    });
    provider.rejectNextRelated();
    await expect(
      connection.request("Target.autoAttachRelated", {
        targetId: "BROWSER",
        waitForDebuggerOnStart: false,
      }),
    ).rejects.toStrictEqual({
      code: -32000,
      message: "Native related selection unavailable",
      data: { original: true },
    });
    expect(
      await connection.request(
        "Runtime.enable",
        {},
        String((await recovered).params?.sessionId),
      ),
    ).toStrictEqual({});
    await connection.request("Target.setDiscoverTargets", { discover: true });
    const entered = connection.event((message) => {
      return (
        message.method === "Target.targetCreated" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId === "B"
      );
    });
    const start = provider.commands.length;
    provider.move("B", 0);
    await entered;
    await connection.request("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    expect(
      provider.commands.slice(start).filter((command) => {
        return command.method === "Target.autoAttachRelated";
      }),
    ).toStrictEqual([]);
  });

  it.each([
    { browserSession: false, iframe: false },
    { browserSession: true, iframe: false },
    { browserSession: false, iframe: true },
    { browserSession: true, iframe: true },
  ])(
    "retains the latest handler filter and surviving root wait after a root leaves: %j",
    async ({ browserSession, iframe }) => {
      const channel = browserSession
        ? String(
            (await connection.request("Target.attachToBrowserTarget"))
              .sessionId,
          )
        : undefined;
      await connection.request(
        "Target.setDiscoverTargets",
        { discover: true },
        channel,
      );
      const entered = connection.event((message) => {
        return (
          message.method === "Target.targetCreated" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "B"
        );
      });
      provider.move("B", 0);
      await entered;
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "A",
          waitForDebuggerOnStart: false,
          filter: [{ type: "iframe" }],
        },
        channel,
      );
      await connection.request(
        "Target.autoAttachRelated",
        {
          targetId: "B",
          waitForDebuggerOnStart: true,
          filter: [{ type: iframe ? "iframe" : "page" }],
        },
        channel,
      );
      const rebuilt = connection.event((message) => {
        return (
          message.method === "Target.attachedToTarget" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            (iframe ? "IFRAME-A" : "A")
        );
      });
      provider.move("B", 1);
      await rebuilt;
      const added = iframe
        ? connection.event((message) => {
            return (
              message.method === "Target.attachedToTarget" &&
              message.sessionId === channel &&
              (message.params?.targetInfo as { targetId?: string })
                ?.targetId === "LATE-FRAME"
            );
          })
        : undefined;
      provider.addFrame("A", "LATE-FRAME");
      if (added) expect((await added).params?.waitingForDebugger).toBe(false);
      await connection.request("Target.getTargets", {}, channel);
      expect(
        provider.attachments.filter(({ targetId }) => {
          return targetId === "LATE-FRAME";
        }),
      ).toStrictEqual(
        iframe ? [{ targetId: "LATE-FRAME", waitingForDebugger: false }] : [],
      );
    },
  );

  it.each([
    { browserSession: false, deferDetach: false, deferDestroyed: false },
    { browserSession: true, deferDetach: false, deferDestroyed: false },
    { browserSession: false, deferDetach: true, deferDestroyed: false },
    { browserSession: true, deferDetach: true, deferDestroyed: false },
    { browserSession: false, deferDetach: true, deferDestroyed: true },
    { browserSession: true, deferDetach: true, deferDestroyed: true },
  ])(
    "preserves the other root's original session when a selected target dies: %j",
    async ({ browserSession, deferDetach, deferDestroyed }) => {
      const channel = browserSession
        ? String(
            (await connection.request("Target.attachToBrowserTarget"))
              .sessionId,
          )
        : undefined;
      await connection.request(
        "Target.setDiscoverTargets",
        { discover: true },
        channel,
      );
      const entered = connection.event((message) => {
        return (
          message.method === "Target.targetCreated" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "B"
        );
      });
      provider.move("B", 0);
      await entered;
      const attached = connection.event((message) => {
        return (
          message.method === "Target.attachedToTarget" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "A"
        );
      });
      for (const targetId of ["A", "B"])
        await connection.request(
          "Target.autoAttachRelated",
          {
            targetId,
            waitForDebuggerOnStart: false,
            filter: [{ type: "page" }],
          },
          channel,
        );
      const original = String((await attached).params?.sessionId);
      const lookup = deferDestroyed ? provider.holdWindowLookup("B") : null;
      const closed = provider.destroyTarget("B", deferDetach, deferDestroyed);
      try {
        if (lookup) {
          await lookup.observed;
          lookup.resume();
        }
        // The fresh target requires a scope-control observation after B died.
        provider.addPage("CONTROL-BARRIER", 1);
        await connection.request(
          "Target.getTargets",
          { filter: [{}] },
          channel,
        );
        await connection.request(
          "Target.autoAttachRelated",
          {
            targetId: "A",
            waitForDebuggerOnStart: false,
            filter: [{ type: "page" }],
          },
          channel,
        );
        expect(
          await connection.request("Runtime.enable", {}, original),
        ).toStrictEqual({});
      } finally {
        lookup?.resume();
        closed.resume();
      }
    },
  );

  it.each([
    { browserSession: false, survivor: "A" },
    { browserSession: true, survivor: "A" },
    { browserSession: false, survivor: "B" },
    { browserSession: true, survivor: "B" },
  ])(
    "preserves an owned session when another tab moves during root observation: %j",
    async ({ browserSession, survivor }) => {
      // Chrome removes a window when its last tab leaves; both destinations
      // must remain available throughout the round trip.
      provider.addPage("KEEP-ASSIGNED-WINDOW", 0);
      provider.addPage("KEEP-OTHER-WINDOW", 1);
      if (survivor === "B") {
        provider.move("A", 1);
        provider.move("B", 0);
      }
      const channel = browserSession
        ? String(
            (await connection.request("Target.attachToBrowserTarget"))
              .sessionId,
          )
        : undefined;
      const attached = connection.event((message) => {
        return (
          message.method === "Target.attachedToTarget" &&
          message.sessionId === channel &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            survivor
        );
      });
      const select = () => {
        return connection.request(
          "Target.autoAttachRelated",
          {
            targetId: "BROWSER",
            waitForDebuggerOnStart: false,
            filter: [{ type: "page" }],
          },
          channel,
        );
      };
      await select();
      const original = String((await attached).params?.sessionId);
      const lookup = provider.holdWindowLookup("TAB-" + survivor);
      const moving = survivor === "A" ? "B" : "A";
      try {
        provider.move(moving, 0);
        await lookup.observed;
        provider.move(moving, 1);
        lookup.resume();
        await select();
        expect(
          await connection.request("Runtime.enable", {}, original),
        ).toStrictEqual({});
      } finally {
        lookup.resume();
      }
    },
  );

  it("never attaches foreign pages through a browser-global source and releases only owned browser sessions", async () => {
    const explicit = String(
      (
        await connection.request("Target.attachToTarget", {
          targetId: "BROWSER",
          flatten: true,
        })
      ).sessionId,
    );
    const browser = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId ===
          "BROWSER"
      );
    });
    await connection.request("Target.autoAttachRelated", {
      targetId: "BROWSER",
      waitForDebuggerOnStart: true,
      filter: [{}],
    });
    let ownedBrowser = String((await browser).params?.sessionId);
    await connection.request("Target.detachFromTarget", {
      sessionId: ownedBrowser,
    });
    await connection.request("Target.getTargets");
    const reselected = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId ===
          "BROWSER"
      );
    });
    await connection.request("Target.autoAttachRelated", {
      targetId: "BROWSER",
      waitForDebuggerOnStart: true,
      filter: [{}],
    });
    ownedBrowser = String((await reselected).params?.sessionId);
    const own = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId === "C"
      );
    });
    provider.addPage("C", 0);
    await own;
    provider.addPage("D", 1);
    await connection.request("Target.getTargets", { filter: [{}] });
    expect(
      provider.attachments.filter(({ targetId }) => {
        return targetId === "D" || targetId === "TAB-D";
      }),
    ).toStrictEqual([]);
    await connection.request("Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await connection.request("Target.getTargets");
    expect(
      await connection.request("Runtime.enable", {}, explicit),
    ).toStrictEqual({});
    await expect(
      connection.request("Runtime.enable", {}, ownedBrowser),
    ).rejects.toStrictEqual(unavailableSessionError);
  });

  it.each([
    { waitForDebuggerOnStart: "invalid" },
    { waitForDebuggerOnStart: false, filter: [{ exclude: "invalid" }] },
  ])(
    "preserves native validation errors without resetting existing automatic sessions: %j",
    async (invalid) => {
      const original = connection.event((message) => {
        return (
          message.method === "Target.attachedToTarget" &&
          (message.params?.targetInfo as { targetId?: string })?.targetId ===
            "A"
        );
      });
      await connection.request("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      const event = await original;
      await expect(
        connection.request("Target.autoAttachRelated", {
          targetId: "A",
          ...invalid,
        }),
      ).rejects.toStrictEqual({
        code: -32602,
        message: "Native invalid related parameters",
      });
      expect(
        await connection.request(
          "Runtime.enable",
          {},
          String(event.params?.sessionId),
        ),
      ).toStrictEqual({});
    },
  );

  it("restores automatic selection after a native related-selector failure", async () => {
    await connection.request("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    provider.rejectNextRelated();
    await expect(
      connection.request("Target.autoAttachRelated", {
        targetId: "A",
        waitForDebuggerOnStart: false,
      }),
    ).rejects.toStrictEqual({
      code: -32000,
      message: "Native related selection unavailable",
      data: { original: true },
    });
    const attached = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId === "B"
      );
    });
    provider.move("B", 0);
    const event = await attached;
    expect(
      await connection.request(
        "Runtime.enable",
        {},
        String(event.params?.sessionId),
      ),
    ).toStrictEqual({});
  });

  it("places a blank-created target using exact native correlation and retires a moved session", async () => {
    const { sessionId } = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    const created = await connection.request("Target.createTarget", {
      url: "about:blank",
      background: true,
    });
    const detached = connection.event((message) => {
      return (
        message.method === "Target.detachedFromTarget" &&
        message.params?.sessionId === sessionId
      );
    });
    provider.move("A", 1);
    await detached;
    const inventory = await connection.request("Target.getTargets");
    expect(inventory.targetInfos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: created.targetId }),
      ]),
    );
    expect(JSON.stringify(inventory)).not.toContain('"targetId":"A"');
    await expect(
      connection.request(
        "Input.insertText",
        { text: "blocked" },
        String(sessionId),
      ),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it("retains owned iframe ancestry after an unrelated move and revokes it when its parent leaves", async () => {
    const parent = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    const attached = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        message.sessionId === parent.sessionId &&
        (message.params?.targetInfo as { targetId?: string })?.targetId ===
          "IFRAME-A"
      );
    });
    await connection.request(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      String(parent.sessionId),
    );
    const frame = (await attached).params?.sessionId;
    await connection.request("Target.setDiscoverTargets", { discover: true });
    const entered = connection.event((message) => {
      return (
        message.method === "Target.targetCreated" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId === "B"
      );
    });
    provider.move("B", 0);
    await entered;
    expect(
      await connection.request("Runtime.enable", {}, String(frame)),
    ).toStrictEqual({});
    const detached = connection.event((message) => {
      return (
        message.method === "Target.detachedFromTarget" &&
        message.params?.sessionId === parent.sessionId
      );
    });
    provider.move("A", 1);
    await detached;
    await expect(
      connection.request("Runtime.enable", {}, String(frame)),
    ).rejects.toMatchObject({ code: -32000 });
  });

  it("preserves native tab-session close errors without creating an unnecessary tab", async () => {
    const session = String(
      (
        await connection.request("Target.attachToTarget", {
          targetId: "TAB-A",
          flatten: true,
        })
      ).sessionId,
    );
    await expect(
      connection.request("Page.close", {}, session),
    ).rejects.toMatchObject({ code: -32601 });
    const targets = (await connection.request("Target.getTargets"))
      .targetInfos as { targetId: string; type: string }[];
    expect(
      targets.filter((target) => {
        return target.type === "page";
      }),
    ).toEqual([expect.objectContaining({ targetId: "A" })]);
  });

  it("preserves native child-frame close errors without creating an unnecessary tab", async () => {
    const attached = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId ===
          "IFRAME-A"
      );
    });
    await connection.request("Target.autoAttachRelated", {
      targetId: "A",
      waitForDebuggerOnStart: false,
      filter: [{ type: "iframe" }],
    });
    const session = String((await attached).params?.sessionId);
    await expect(
      connection.request("Page.close", {}, session),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Command can only be executed on top-level targets",
    });
    const targets = (await connection.request("Target.getTargets"))
      .targetInfos as { targetId: string; type: string; url: string }[];
    expect(
      targets.filter((target) => {
        return target.type === "page";
      }),
    ).toEqual([
      expect.objectContaining({ targetId: "A", url: "https://example.test/a" }),
    ]);
    expect(provider.hasWindow(0)).toBe(true);
    expect(provider.hasWindow(1)).toBe(true);
  });

  it.each(["A", "TAB-A"])(
    "preserves its assigned window after closing its final target %s",
    async (targetId) => {
      expect(
        await connection.request("Target.closeTarget", { targetId }),
      ).toStrictEqual({ success: true });
      const pages = (await connection.request("Target.getTargets"))
        .targetInfos as { targetId: string; type: string; url: string }[];
      const blank = pages.filter((target) => {
        return target.type === "page";
      });
      expect(blank).toHaveLength(1);
      expect(blank[0]?.url).toBe("about:blank");
      expect(blank[0]?.targetId).not.toBe("A");
      expect(
        (
          await connection.request("Browser.getWindowForTarget", {
            targetId: blank[0]!.targetId,
          })
        ).windowId,
      ).toBe(0);
      const session = await connection.request("Target.attachToTarget", {
        targetId: blank[0]!.targetId,
        flatten: true,
      });
      expect(
        await connection.request(
          "Runtime.evaluate",
          { expression: "continued input" },
          String(session.sessionId),
        ),
      ).toStrictEqual({ result: { type: "string", value: "continued input" } });
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    },
  );

  it.each([
    { method: "Page.close", targetId: undefined },
    { method: "Target.closeTarget", targetId: "A" },
    { method: "Target.closeTarget", targetId: "TAB-A" },
  ])(
    "preserves its assigned window and reply when its page session calls $method ($targetId)",
    async ({ method, targetId }) => {
      const session = await connection.request("Target.attachToTarget", {
        targetId: "A",
        flatten: true,
      });
      expect(
        await connection.request(
          method,
          targetId ? { targetId } : {},
          String(session.sessionId),
        ),
      ).toStrictEqual(method === "Page.close" ? {} : { success: true });
      const targets = (await connection.request("Target.getTargets"))
        .targetInfos as { targetId: string; type: string; url: string }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    },
  );

  it.each(["A", "TAB-A"])(
    "closes a non-final target %s without adding a blank",
    async (targetId) => {
      provider.addPage("C", 0);
      await connection.request("Target.closeTarget", { targetId });
      const targets = (await connection.request("Target.getTargets"))
        .targetInfos as { targetId: string; type: string }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ targetId: "C" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    },
  );

  it("coordinates overlapping closes across peers without blocking ordinary input", async () => {
    provider.addPage("C", 0);
    await connection.request("Target.getTargets");
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const session = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    const preparation = provider.holdNextNavigation();
    const closes = Promise.all([
      connection.request("Target.closeTarget", { targetId: "A" }),
      peer.request("Target.closeTarget", { targetId: "C" }),
    ]);
    try {
      await preparation.observed;
      expect(
        await connection.request(
          "Runtime.enable",
          {},
          String(session.sessionId),
        ),
      ).toStrictEqual({});
      expect(
        (
          await connection.request("Browser.getWindowForTarget", {
            targetId: "A",
          })
        ).windowId,
      ).toBe(0);
      preparation.resume();
      expect(await closes).toStrictEqual([
        { success: true },
        { success: true },
      ]);
      const targets = (await peer.request("Target.getTargets")).targetInfos as {
        targetId: string;
        type: string;
        url: string;
      }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      preparation.resume();
      await closes.catch(() => {});
    }
  });

  it.each(["Target.closeTarget", "Page.close"])(
    "does not count an acknowledged pending %s as a surviving tab",
    async (method) => {
      provider.addPage("C", 0);
      await connection.request("Target.getTargets");
      const peer = await client(proxy.endpoint);
      clients.push(peer);
      const held = provider.holdClose("A");
      const session =
        method === "Page.close"
          ? String(
              (
                await connection.request("Target.attachToTarget", {
                  targetId: "A",
                  flatten: true,
                })
              ).sessionId,
            )
          : undefined;
      try {
        await connection.request(
          method,
          method === "Target.closeTarget" ? { targetId: "A" } : {},
          session,
        );
        await held.observed;
        await peer.request("Target.closeTarget", { targetId: "C" });
        held.resume();
        const targets = (await peer.request("Target.getTargets"))
          .targetInfos as { targetId: string; type: string; url: string }[];
        expect(
          targets.filter((target) => {
            return target.type === "page";
          }),
        ).toEqual([expect.objectContaining({ url: "about:blank" })]);
        expect(provider.hasWindow(0)).toBe(true);
        expect(provider.hasWindow(1)).toBe(true);
      } finally {
        held.resume();
      }
    },
  );

  it("retains another peer's close reservation when an overlapping close of the same tab fails", async () => {
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const preparation = provider.holdNextNavigation();
    const first = expect(
      connection.request("Target.closeTarget", { targetId: "A" }),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Native navigation failed",
    });
    let second: Promise<Record<string, unknown>> | undefined;
    try {
      await preparation.observed;
      second = peer.request("Target.closeTarget", { targetId: "A" });
      await peer.request("Future.echo", { barrier: true });
      preparation.resume(true);
      await first;
      expect(await second).toStrictEqual({ success: true });
      const targets = (await peer.request("Target.getTargets")).targetInfos as {
        targetId: string;
        type: string;
        url: string;
      }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      preparation.resume(true);
      await first;
      await second?.catch(() => {});
    }
  });

  it("preserves the window when an earlier close loses its native acknowledgement", async () => {
    provider.addPage("C", 0);
    await connection.request("Target.getTargets");
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const held = provider.holdClose("A", true);
    try {
      await expect(
        connection.request("Target.closeTarget", { targetId: "A" }),
      ).rejects.toThrow("Fixture connection closed");
      await held.observed;
      await peer.request("Target.closeTarget", { targetId: "C" });
      held.resume();
      const targets = (await peer.request("Target.getTargets")).targetInfos as {
        targetId: string;
        type: string;
        url: string;
      }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      held.resume();
    }
  });

  it.each([
    { flatten: true, nativeError: false },
    { flatten: false, nativeError: false },
    { flatten: true, nativeError: true },
    { flatten: false, nativeError: true },
  ])(
    "settles a reply overtaken by tab retirement (flatten=$flatten, native error=$nativeError)",
    async ({ flatten, nativeError }) => {
      provider.addPage("C", 0);
      const session = String(
        (
          await connection.request("Target.attachToTarget", {
            targetId: "A",
            flatten,
          })
        ).sessionId,
      );
      const method = nativeError ? "Future.error" : "Runtime.evaluate";
      const expectedError = nativeError
        ? {
            code: -32601,
            message: "Native error remains unchanged",
            data: { original: true },
          }
        : unconfirmedOperationError;
      const held = provider.holdReply(method, "A");
      const peer = await client(proxy.endpoint);
      clients.push(peer);
      let result: Promise<void>;
      if (flatten) {
        result = expect(
          connection.request(method, { expression: "stale result" }, session),
        ).rejects.toStrictEqual(expectedError);
      } else {
        const reply = connection.event((message) => {
          return (
            message.method === "Target.receivedMessageFromTarget" &&
            message.params?.sessionId === session &&
            (JSON.parse(String(message.params?.message)) as Message).id === 49
          );
        });
        result = reply.then((message) => {
          expect(JSON.parse(String(message.params?.message))).toStrictEqual({
            id: 49,
            error: expectedError,
          });
        });
        await connection.request("Target.sendMessageToTarget", {
          sessionId: session,
          message: JSON.stringify({
            id: 49,
            method,
            params: { expression: "stale result" },
          }),
        });
      }
      try {
        await held.observed;
        await peer.request("Target.closeTarget", { targetId: "A" });
        held.resume();
        await result;
        expect(
          (await peer.request("Browser.getWindowForTarget", { targetId: "C" }))
            .windowId,
        ).toBe(0);
        expect(provider.hasWindow(1)).toBe(true);
      } finally {
        held.resume();
      }
    },
  );

  it("settles an accepted nested command when its session retires during authorization", async () => {
    provider.addPage("C", 0);
    const session = String(
      (
        await connection.request("Target.attachToTarget", {
          targetId: "A",
          flatten: false,
        })
      ).sessionId,
    );
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const lookup = provider.holdWindowLookup("LATE");
    provider.addPage("LATE", 1);
    const reply = connection.event((message) => {
      return (
        message.method === "Target.receivedMessageFromTarget" &&
        message.params?.sessionId === session &&
        (JSON.parse(String(message.params?.message)) as Message).id === 52
      );
    });
    try {
      await connection.request("Target.sendMessageToTarget", {
        sessionId: session,
        message: JSON.stringify({
          id: 52,
          method: "Target.getTargetInfo",
          params: { targetId: "LATE" },
        }),
      });
      await lookup.observed;
      await peer.request("Target.closeTarget", { targetId: "A" });
      lookup.resume();
      expect(JSON.parse(String((await reply).params?.message))).toStrictEqual({
        id: 52,
        error: unavailableTargetError,
      });
      expect(
        (await peer.request("Browser.getWindowForTarget", { targetId: "C" }))
          .windowId,
      ).toBe(0);
    } finally {
      lookup.resume();
    }
  });

  it.each([true, false])(
    "settles a control reply after its source session retires (flatten=%s)",
    async (flatten) => {
      const session = String(
        (
          await connection.request("Target.attachToTarget", {
            targetId: "A",
            flatten,
          })
        ).sessionId,
      );
      const peer = await client(proxy.endpoint);
      clients.push(peer);
      const preparation = provider.holdNextNavigation();
      let result: Promise<void>;
      if (flatten) {
        result = expect(
          connection.request(
            "Target.createTarget",
            { url: "https://example.test/new" },
            session,
          ),
        ).rejects.toStrictEqual(unconfirmedOperationError);
      } else {
        const reply = connection.event((message) => {
          return (
            message.method === "Target.receivedMessageFromTarget" &&
            message.params?.sessionId === session &&
            (JSON.parse(String(message.params?.message)) as Message).id === 53
          );
        });
        result = reply.then((message) => {
          expect(JSON.parse(String(message.params?.message))).toStrictEqual({
            id: 53,
            error: unconfirmedOperationError,
          });
        });
        await connection.request("Target.sendMessageToTarget", {
          sessionId: session,
          message: JSON.stringify({
            id: 53,
            method: "Target.createTarget",
            params: { url: "https://example.test/new" },
          }),
        });
      }
      try {
        await preparation.observed;
        await peer.request("Target.closeTarget", { targetId: "A" });
        preparation.resume();
        await result;
        const targets = (await peer.request("Target.getTargets"))
          .targetInfos as { targetId: string; type: string; url: string }[];
        expect(targets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "page",
              url: "https://example.test/new",
            }),
          ]),
        );
        expect(provider.hasWindow(0)).toBe(true);
        expect(provider.hasWindow(1)).toBe(true);
      } finally {
        preparation.resume();
      }
    },
  );

  it("settles a discovery reply when its page retires during window filtering", async () => {
    provider.addPage("C", 0);
    const session = String(
      (
        await connection.request("Target.attachToTarget", {
          targetId: "A",
          flatten: true,
        })
      ).sessionId,
    );
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const lookup = provider.holdWindowLookup("LATE");
    const reply = provider.holdReply("Target.getTargets", "A");
    provider.addPage("LATE", 0);
    const result = expect(
      connection.request("Target.getTargets", {}, session),
    ).rejects.toStrictEqual(unconfirmedOperationError);
    try {
      await Promise.all([lookup.observed, reply.observed]);
      reply.resume();
      // A later ordinary reply confirms ingress ran while discovery awaited IO.
      expect(
        await connection.request("Future.echo", { barrier: true }, session),
      ).toStrictEqual({ opaque: { barrier: true } });
      await peer.request("Target.closeTarget", { targetId: "A" });
      lookup.resume();
      await result;
      expect(
        (await peer.request("Browser.getWindowForTarget", { targetId: "C" }))
          .windowId,
      ).toBe(0);
    } finally {
      lookup.resume();
      reply.resume();
    }
  });

  it("keeps a usable blank instead of relying on an internal extension control tab", async () => {
    provider.addPage("CONTROL", 0);
    const native = await client(provider.endpoint);
    clients.push(native);
    const session = String(
      (
        await native.request("Target.attachToTarget", {
          targetId: "CONTROL",
          flatten: true,
        })
      ).sessionId,
    );
    await native.request(
      "Page.navigate",
      { url: `chrome-extension://${EXTENSION_RUNTIME}/control.html` },
      session,
    );
    await connection.request("Target.closeTarget", { targetId: "A" });
    const targets = (await connection.request("Target.getTargets"))
      .targetInfos as { targetId: string; type: string; url: string }[];
    expect(
      targets.filter((target) => {
        return target.type === "page";
      }),
    ).toEqual([expect.objectContaining({ url: "about:blank" })]);
    expect(provider.hasWindow(0)).toBe(true);
    expect(provider.hasWindow(1)).toBe(true);
  });

  it("does not count another client's unfinished creation as the surviving tab", async () => {
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const preparation = provider.holdNextNavigation();
    const created = expect(
      connection.request("Target.createTarget", {
        url: "https://example.test/new",
      }),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Native navigation failed",
    });
    try {
      await preparation.observed;
      await peer.request("Target.closeTarget", { targetId: "A" });
      preparation.resume(true);
      await created;
      const targets = (await peer.request("Target.getTargets")).targetInfos as {
        targetId: string;
        type: string;
        url: string;
      }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      preparation.resume(true);
      await created;
    }
  });

  it("does not count a navigated but unfinished creation as the surviving tab", async () => {
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const navigation = provider.holdReply("Page.navigate", "new-1");
    const created = expect(
      connection.request("Target.createTarget", {
        url: "https://example.test/new",
      }),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Native detach unavailable",
    });
    try {
      // The external page's URL is committed before its reply is released.
      await navigation.observed;
      await peer.request("Target.closeTarget", { targetId: "A" });
      provider.rejectNextDetach();
      navigation.resume();
      await created;
      const targets = (await peer.request("Target.getTargets")).targetInfos as {
        targetId: string;
        type: string;
        url: string;
      }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      navigation.resume();
      await created;
    }
  });

  it("does not count an acknowledged creation rollback as the surviving tab", async () => {
    const peer = await client(proxy.endpoint);
    clients.push(peer);
    const navigation = provider.holdReply("Page.navigate", "new-1");
    const rollback = provider.holdClose("new-1");
    const created = expect(
      connection.request("Target.createTarget", {
        url: "https://example.test/new",
      }),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Native detach unavailable",
    });
    try {
      await navigation.observed;
      provider.rejectNextDetach();
      navigation.resume();
      await created;
      await rollback.observed;
      await peer.request("Target.closeTarget", { targetId: "A" });
      rollback.resume();
      const targets = (await peer.request("Target.getTargets")).targetInfos as {
        targetId: string;
        type: string;
        url: string;
      }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      navigation.resume();
      rollback.resume();
      await created;
    }
  });

  it("retains the original page when blank preparation fails and permits a later explicit close", async () => {
    const session = await connection.request("Target.attachToTarget", {
      targetId: "A",
      flatten: true,
    });
    const held = provider.holdNextNavigation();
    const result = expect(
      connection.request("Target.closeTarget", { targetId: "A" }),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Native navigation failed",
    });
    try {
      await held.observed;
      held.resume(true);
      await result;
      expect(
        await connection.request(
          "Runtime.enable",
          {},
          String(session.sessionId),
        ),
      ).toStrictEqual({});
      const targets = (await connection.request("Target.getTargets"))
        .targetInfos as { targetId: string; type: string }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ targetId: "A" })]);
      await connection.request("Target.closeTarget", { targetId: "A" });
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      held.resume(true);
      await result;
    }
  });

  it("revalidates the source after replacement preparation instead of closing a moved page", async () => {
    const held = provider.holdNextNavigation();
    const result = expect(
      connection.request("Target.closeTarget", { targetId: "A" }),
    ).rejects.toMatchObject({ code: -32000 });
    try {
      await held.observed;
      provider.move("A", 1);
      held.resume();
      await result;
      const peer = await client(provider.endpoint);
      clients.push(peer);
      expect(
        (await peer.request("Browser.getWindowForTarget", { targetId: "A" }))
          .windowId,
      ).toBe(1);
      const targets = (await connection.request("Target.getTargets"))
        .targetInfos as { targetId: string; type: string; url: string }[];
      expect(
        targets.filter((target) => {
          return target.type === "page";
        }),
      ).toEqual([expect.objectContaining({ url: "about:blank" })]);
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    } finally {
      held.resume();
      await result;
    }
  });

  it.each([
    { method: "Page.close", targetId: undefined },
    { method: "Target.closeTarget", targetId: "A" },
    { method: "Target.closeTarget", targetId: "TAB-A" },
  ])(
    "delivers the nested $method ($targetId) reply even after native session retirement",
    async ({ method, targetId }) => {
      const session = await connection.request("Target.attachToTarget", {
        targetId: "A",
        flatten: false,
      });
      const id = 67;
      const reply = connection.event((message) => {
        return (
          message.method === "Target.receivedMessageFromTarget" &&
          message.params !== undefined &&
          message.params?.sessionId === session.sessionId &&
          (JSON.parse(String(message.params.message)) as Message).id === id
        );
      });
      await connection.request("Target.sendMessageToTarget", {
        sessionId: session.sessionId,
        message: JSON.stringify({
          id,
          method,
          params: targetId ? { targetId } : {},
        }),
      });
      expect(JSON.parse(String((await reply).params?.message))).toStrictEqual({
        id,
        result: method === "Page.close" ? {} : { success: true },
      });
      expect(provider.hasWindow(0)).toBe(true);
      expect(provider.hasWindow(1)).toBe(true);
    },
  );

  it("rejects physical window creation and destruction while keeping both windows usable", async () => {
    for (const [params, message] of [
      [
        { newWindow: true },
        "Creating a new Browser window is not allowed; create a tab in this chat instead",
      ],
      [
        { hidden: true },
        "Hidden targets are not supported in this chat; create a visible tab instead",
      ],
      [
        { browserContextId: "unrelated" },
        "Creating a target in another browser context is not allowed; use this chat's browser context",
      ],
    ] as const)
      await expect(
        connection.request("Target.createTarget", {
          url: "https://example.test/private?token=fixture-value",
          ...params,
        }),
      ).rejects.toStrictEqual({ code: -32000, message });
    expect(
      provider.commands.filter((command) => {
        return command.method === "Target.createTarget";
      }),
    ).toStrictEqual([]);
    await expect(
      connection.request("Target.openDevTools", { targetId: "A" }),
    ).rejects.toStrictEqual({
      code: -32000,
      message:
        "Opening DevTools is not supported by this chat's Browser connection",
    });
    expect(
      provider.commands.some((command) => {
        return command.method === "Target.openDevTools";
      }),
    ).toBe(false);
    await expect(connection.request("Browser.crash")).rejects.toMatchObject({
      code: -32000,
    });
    await expect(
      connection.request("Target.disposeBrowserContext", {
        browserContextId: "default",
      }),
    ).rejects.toMatchObject({ code: -32000 });
    expect(
      await connection.request("Target.disposeBrowserContext", {
        browserContextId: "unrelated",
      }),
    ).toStrictEqual({});
    await expect(connection.request("Browser.close")).rejects.toMatchObject({
      code: -32000,
    });
    await expect(
      connection.request("Target.closeTarget", { targetId: "BROWSER" }),
    ).rejects.toMatchObject({ code: -32000 });
    expect(
      (
        await connection.request("Browser.getWindowForTarget", {
          targetId: "A",
        })
      ).windowId,
    ).toBe(0);
    expect(provider.hasWindow(0)).toBe(true);
    expect(provider.hasWindow(1)).toBe(true);
  });

  it("applies native bounds and content-size operations to its assigned window", async () => {
    await connection.request("Browser.setContentsSize", {
      windowId: 1,
      width: 800,
      height: 600,
    });
    expect(
      await connection.request("Browser.getWindowBounds", { windowId: 1 }),
    ).toStrictEqual({ bounds: { width: 800, height: 600 } });
    await connection.request("Browser.setWindowBounds", {
      windowId: 1,
      bounds: { width: 1024 },
    });
    expect(
      await connection.request("Browser.getWindowBounds", { windowId: 0 }),
    ).toStrictEqual({ bounds: { width: 1024 } });
    expect(
      provider.commands
        .filter((command) => {
          return [
            "Browser.getWindowBounds",
            "Browser.setWindowBounds",
            "Browser.setContentsSize",
          ].includes(command.method);
        })
        .every((command) => {
          return command.params.windowId === 0;
        }),
    ).toBe(true);
  });
});

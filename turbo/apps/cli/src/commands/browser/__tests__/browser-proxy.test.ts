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
    ).rejects.toMatchObject({ code: -32000 });
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
    ).rejects.toMatchObject({ code: -32000 });
  });

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

  it("uses native per-owned-root selectors and admits only their related iframe sessions", async () => {
    const attached = connection.event((message) => {
      return (
        message.method === "Target.attachedToTarget" &&
        (message.params?.targetInfo as { targetId?: string })?.targetId ===
          "IFRAME-A"
      );
    });
    await connection.request("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
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

  it("rejects creating a physical window and closes only its assigned window", async () => {
    await expect(
      connection.request("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      }),
    ).rejects.toMatchObject({ code: -32000 });
    await expect(
      connection.request("Target.openDevTools", { targetId: "A" }),
    ).rejects.toMatchObject({ code: -32000 });
    expect(
      provider.commands.some((command) => {
        return command.method === "Target.openDevTools";
      }),
    ).toBe(false);
    const closed = new Promise((resolve) => {
      return connection.socket.addEventListener("close", resolve, {
        once: true,
      });
    });
    void connection.request("Browser.close").catch(() => {});
    await closed;
    expect(provider.hasWindow(0)).toBe(false);
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

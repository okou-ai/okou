import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SANDBOX_CHANNEL_LIMITS,
  SandboxChannelError,
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  sandboxChannelIdSchema,
  sandboxChannelObjectSchema,
  type SandboxChannelCategoryContract,
  type SandboxChannelMessage,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import {
  sandboxFsCategory,
  sandboxFsList,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import {
  sandboxDiagnosticsCategory,
  sandboxDiagnosticsEcho,
  sandboxDiagnosticsNotice,
} from "@okouai/api-contracts/contracts/sandbox-channel-diagnostics";
import {
  RunWssTransport,
  RUN_WSS_MAX_BUFFERED_BYTES,
} from "../run-wss-transport";
import {
  SandboxChannelPeer,
  sandboxChannelHandler,
  sandboxChannelEventHandler,
  type SandboxChannelEventError,
  type SandboxChannelPeerOptions,
} from "../sandbox-channel-peer";

const uuid = (value: number) => {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}` as const;
};
class Queue<T> {
  private readonly items: T[] = [];
  private readonly readers: ((value: T) => void)[] = [];
  put(value: T): void {
    const reader = this.readers.shift();
    if (reader) reader(value);
    else this.items.push(value);
  }
  next(): Promise<T> {
    const value = this.items.shift();
    return value !== undefined
      ? Promise.resolve(value)
      : new Promise((resolve) => {
          return this.readers.push(resolve);
        });
  }
}

/** External WebSocket boundary; the real transport/peer handles all framing. */
class Socket extends EventTarget {
  binaryType: BinaryType = "arraybuffer";
  bufferedAmount = 0;
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  readonly frames = new Queue<SandboxChannelMessage>();
  readonly application: SandboxChannelMessage[] = [];
  onSend?: (message: SandboxChannelMessage) => void;
  private finishClose: () => void = () => {
    return undefined;
  };
  readonly closed = new Promise<void>((resolve) => {
    this.finishClose = resolve;
  });
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.receiveRaw('{"type":"auth.ok"}');
    });
  }
  send(data: unknown): void {
    if (typeof data === "string") {
      expect(JSON.parse(data)).toMatchObject({
        runId: uuid(99),
        ticket: "t".repeat(43),
      });
      return;
    }
    if (!(data instanceof ArrayBuffer))
      throw new Error("binary application frame required");
    const message = decodeSandboxChannelFrame(data);
    this.application.push(message);
    this.frames.put(message);
    this.onSend?.(message);
  }
  receive(message: SandboxChannelMessage): void {
    this.receiveRaw(encodeSandboxChannelFrame(message));
  }
  receiveRaw(data: string | ArrayBuffer): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  reply(
    request: Extract<SandboxChannelMessage, { type: "hello" | "request" }>,
    result: unknown,
  ): void {
    this.receive({
      schemaVersion: 1,
      type: "response",
      id: uuid(900),
      requestId: request.id,
      result,
    });
  }
  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
    this.finishClose();
  }
}

const owned: { peer: SandboxChannelPeer; controller: AbortController }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.peer.close();
    item.controller.abort();
  }
  vi.restoreAllMocks();
});
function harness(options: Partial<SandboxChannelPeerOptions> = {}) {
  const controller = new AbortController(),
    sockets = new Queue<Socket>();
  const peer = new SandboxChannelPeer(
    (callbacks) => {
      return new RunWssTransport(
        uuid(99),
        async () => {
          return {
            kind: "success",
            body: {
              wssUrl: `wss://runner.example.com:443/ws/${uuid(99)}`,
              ticket: "t".repeat(43),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          };
        },
        {
          ...callbacks,
          createSocket: () => {
            const socket = new Socket();
            sockets.put(socket);
            return socket;
          },
        },
      );
    },
    {
      categories: [sandboxFsCategory, sandboxDiagnosticsCategory],
      handlers: [
        sandboxChannelHandler(sandboxDiagnosticsEcho, (params) => {
          return params;
        }),
      ],
      ...options,
    },
  );
  owned.push({ peer, controller });
  const start = async () => {
    const connected = peer.connect(controller.signal);
    const socket = await sockets.next();
    const hello = await socket.frames.next();
    if (hello.type !== "hello") throw new Error("hello first");
    return { socket, hello, connected };
  };
  const ready = async (
    categories: Record<string, number> = { fs: 3, diagnostics: 1 },
  ) => {
    const started = await start();
    started.socket.reply(started.hello, { categories });
    await started.connected;
    return started.socket;
  };
  return { peer, controller, sockets, start, ready };
}
async function nextRequest(socket: Socket) {
  const message = await socket.frames.next();
  if (message.type !== "request")
    throw new Error(`expected request, got ${message.type}`);
  return message;
}
function incoming(
  value: number,
  payload = "aGk=",
): Extract<SandboxChannelMessage, { type: "request" }> {
  return {
    schemaVersion: 1,
    type: "request",
    id: uuid(value),
    category: "diagnostics",
    categoryVersion: 1,
    operation: "echo",
    params: { payload },
  };
}

function notice(
  value: number,
  message: string,
): Extract<SandboxChannelMessage, { type: "event" }> {
  return {
    schemaVersion: 1,
    type: "event",
    id: uuid(value),
    category: "diagnostics",
    categoryVersion: 1,
    event: "notice",
    data: { message },
  };
}

describe("admitted application peer", () => {
  it("requires business hello and validates ready ordering for immediate reverse traffic", async () => {
    const h = harness();
    const { socket, hello, connected } = await h.start();
    expect(h.peer.state).toBe("connecting");
    socket.reply(hello, { categories: { fs: 3, diagnostics: 1 } });
    socket.receive(incoming(100));
    const reply = await socket.frames.next();
    expect(reply).toMatchObject({
      type: "response",
      requestId: uuid(100),
      result: { payload: "aGk=" },
    });
    expect(reply.id).not.toBe(uuid(100));
    expect(sandboxChannelIdSchema.safeParse(reply.id).success).toBe(true);
    await connected;
    expect(h.peer.state).toBe("ready");
  });

  it("registers pending before synchronous replies and never correlates response.id", async () => {
    const h = harness(),
      socket = await h.ready();
    socket.onSend = (message) => {
      if (message.type !== "request") return;
      socket.receive({
        schemaVersion: 1,
        type: "response",
        id: message.id,
        requestId: uuid(800),
        result: { payload: "YmFk" },
      });
      socket.reply(message, { payload: "aGk=" });
    };
    expect(
      await h.peer.call(
        sandboxDiagnosticsEcho,
        { payload: "aGk=" },
        h.controller.signal,
      ),
    ).toEqual({ payload: "aGk=" });
  });

  it("matches out-of-order replies and discards duplicate/completed correlations", async () => {
    const h = harness(),
      socket = await h.ready();
    const first = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    const second = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "Yg==" },
      h.controller.signal,
    );
    const a = await nextRequest(socket),
      b = await nextRequest(socket);
    socket.reply(b, { payload: "Yg==" });
    socket.reply(a, { payload: "YQ==" });
    expect(await Promise.all([first, second])).toEqual([
      { payload: "YQ==" },
      { payload: "Yg==" },
    ]);
    const third = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "Yw==" },
      h.controller.signal,
    );
    const c = await nextRequest(socket);
    socket.reply(a, { payload: "YmFk" });
    socket.reply(c, { payload: "Yw==" });
    expect(await third).toEqual({ payload: "Yw==" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("keeps incoming ownership separate even with an equal outgoing UUID", async () => {
    const h = harness(),
      socket = await h.ready();
    const pending = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    const request = await nextRequest(socket);
    socket.receive({ ...incoming(1), id: request.id });
    const reversed = await socket.frames.next();
    expect(reversed).toMatchObject({
      type: "response",
      requestId: request.id,
      result: { payload: "aGk=" },
    });
    socket.reply(request, { payload: "YQ==" });
    expect(await pending).toEqual({ payload: "YQ==" });
  });

  it("routes nested reverse responses while rejecting saturation immediately", async () => {
    const h = harness({
      handlers: [
        sandboxChannelHandler(sandboxDiagnosticsEcho, (params, context) => {
          return context.peer.call(
            sandboxDiagnosticsEcho,
            params,
            context.signal,
          );
        }),
      ],
    });
    const socket = await h.ready();
    for (let i = 0; i < SANDBOX_CHANNEL_LIMITS.maxIncoming; i++)
      socket.receive(incoming(100 + i));
    const reverse = await Promise.all(
      Array.from({ length: SANDBOX_CHANNEL_LIMITS.maxIncoming }, () => {
        return nextRequest(socket);
      }),
    );
    socket.receive(incoming(200));
    expect(await socket.frames.next()).toMatchObject({
      type: "response",
      requestId: uuid(200),
      error: { code: "busy" },
    });
    await expect(
      h.peer.call(sandboxDiagnosticsEcho, { payload: "" }, h.controller.signal),
    ).rejects.toMatchObject({ code: "busy" });
    for (const request of reverse) socket.reply(request, { payload: "aGk=" });
    const results = await Promise.all(
      reverse.map(() => {
        return socket.frames.next();
      }),
    );
    expect(
      new Set(
        results.map((reply) => {
          return reply.type === "response" ? reply.requestId : "wrong";
        }),
      ).size,
    ).toBe(SANDBOX_CHANNEL_LIMITS.maxIncoming);
    for (const result of results)
      expect(result).toMatchObject({
        type: "response",
        result: { payload: "aGk=" },
      });
  });

  it("bounds complete local role installation", () => {
    expect(() => {
      return harness({ handlers: [] });
    }).toThrow(SandboxChannelError);
    expect(() => {
      return harness({ categories: [sandboxFsCategory, sandboxFsCategory] });
    }).toThrow(SandboxChannelError);
  });

  it("isolates absent/mismatched categories while matching businesses remain usable", async () => {
    const h = harness(),
      socket = await h.ready({ fs: 1, diagnostics: 1 });
    await expect(
      h.peer.call(sandboxFsList, { path: [] }, h.controller.signal),
    ).rejects.toMatchObject({
      code: "category_version_mismatch",
      details: { category: "fs", expectedVersion: 3, receivedVersion: 1 },
    });
    const echo = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "" });
    expect(await echo).toEqual({ payload: "" });
    socket.receive({ ...incoming(111), category: "constructor" });
    expect(await socket.frames.next()).toMatchObject({
      type: "response",
      error: { code: "unsupported_category" },
    });
    socket.receive({ ...incoming(112), operation: "unknown" });
    expect(await socket.frames.next()).toMatchObject({
      type: "response",
      error: { code: "unknown_operation" },
    });
    socket.receive({ ...incoming(113), params: { payload: "not base64" } });
    expect(await socket.frames.next()).toMatchObject({
      type: "response",
      error: { code: "invalid_params" },
    });
    socket.receive({
      schemaVersion: 1,
      type: "request",
      id: uuid(114),
      category: "fs",
      categoryVersion: 1,
      operation: "list",
      params: { path: [] },
    });
    expect(await socket.frames.next()).toMatchObject({
      type: "response",
      error: {
        code: "category_version_mismatch",
        category: "fs",
        expectedVersion: 3,
        receivedVersion: 1,
      },
    });
    expect(h.peer.state).toBe("ready");
  });

  it("rejects missing requestId, unsafe payloads, raw echo and unsupported schema", async () => {
    for (const raw of [
      { schemaVersion: 1, type: "response", id: uuid(501), result: {} },
      { schemaVersion: 2, type: "future" },
    ]) {
      const h = harness(),
        { socket, connected } = await h.start();
      const rejected = expect(connected).rejects.toBeInstanceOf(Error);
      socket.receiveRaw(new TextEncoder().encode(JSON.stringify(raw)).buffer);
      await rejected;
      expect(h.peer.state).toBe("failed");
    }
    const h = harness(),
      { socket, hello, connected } = await h.start();
    const rejected = expect(connected).rejects.toBeInstanceOf(Error);
    socket.receive(hello);
    await rejected;
    expect(h.peer.state).toBe("failed");
  });

  it("isolates invalid correlated business results while another category completes", async () => {
    const h = harness(),
      socket = await h.ready();
    const result = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "" },
      h.controller.signal,
    );
    const resultRejected = expect(result).rejects.toMatchObject({
      code: "invalid_request",
    });
    const listing = { listingId: "listing", entries: [], nextCursor: null };
    const other = h.peer
      .call(sandboxFsList, { path: [] }, h.controller.signal)
      .then(
        (value) => {
          return { result: value };
        },
        (error: unknown) => {
          return { error };
        },
      );
    const invalid = await nextRequest(socket),
      valid = await nextRequest(socket);
    socket.reply(invalid, { payload: "invalid" });
    await resultRejected;
    expect(h.peer.state).toBe("ready");
    socket.reply(valid, listing);
    expect(await other).toEqual({ result: listing });
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
  });

  it("events have fresh identity and no response or ACK, including ignored categories", async () => {
    const notices = new Queue<string>();
    const h = harness({
      events: [
        sandboxChannelEventHandler(sandboxDiagnosticsNotice, (value) => {
          return notices.put(value.message);
        }),
      ],
    });
    const socket = await h.ready();
    socket.receive({
      schemaVersion: 1,
      type: "event",
      id: uuid(300),
      category: "diagnostics",
      categoryVersion: 1,
      event: "notice",
      data: { message: "hello" },
    });
    expect(await notices.next()).toBe("hello");
    socket.receive({
      schemaVersion: 1,
      type: "event",
      id: uuid(301),
      category: "unknown",
      categoryVersion: 1,
      event: "notice",
      data: { message: "ignored" },
    });
    expect(
      h.peer.sendEvent(sandboxDiagnosticsNotice, { message: "local" }),
    ).toBe(true);
    const sent = await socket.frames.next();
    expect(sent).toMatchObject({ type: "event", data: { message: "local" } });
    expect(sandboxChannelIdSchema.safeParse(sent.id).success).toBe(true);
    expect(sent).not.toHaveProperty("requestId");
  });

  it("keeps invalid hello results fatal before establishing business readiness", async () => {
    const h = harness(),
      { socket, hello, connected } = await h.start();
    const rejected = expect(connected).rejects.toMatchObject({
      code: "invalid_request",
    });
    socket.reply(hello, { categories: { fs: 0 } });
    await rejected;
    await socket.closed;
    expect(h.peer.state).toBe("failed");
  });

  it("isolates throwing operation-result decoders and preserves subsequent calls", async () => {
    const faulty = {
      ...sandboxDiagnosticsEcho,
      operation: "decode.fault",
      origin: "external",
      result: {
        safeParse() {
          throw new Error("private decoder failure");
        },
      },
    } as const;
    const h = harness({
      categories: [
        sandboxFsCategory,
        {
          ...sandboxDiagnosticsCategory,
          operations: [...sandboxDiagnosticsCategory.operations, faulty],
        },
      ],
    });
    const socket = await h.ready();
    const call = h.peer.call(faulty, { payload: "" }, h.controller.signal),
      rejected = expect(call).rejects.toMatchObject({
        code: "invalid_request",
      });
    socket.reply(await nextRequest(socket), { payload: "" });
    await rejected;
    expect(h.peer.state).toBe("ready");
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
  });

  it("drops known event payload, direction and decoder failures with redacted local errors", async () => {
    const errors = new Queue<SandboxChannelEventError>();
    const restricted = {
      ...sandboxDiagnosticsNotice,
      event: "restricted",
      origin: "external",
    } as const;
    const faulty = {
      ...sandboxDiagnosticsNotice,
      event: "decode.fault",
      data: {
        safeParse() {
          throw new Error("secret path /private");
        },
      },
    } as const;
    const h = harness({
      categories: [
        sandboxFsCategory,
        {
          ...sandboxDiagnosticsCategory,
          events: [...sandboxDiagnosticsCategory.events, restricted, faulty],
        },
      ],
      onEventError(error) {
        errors.put(error);
      },
    });
    const socket = await h.ready();
    for (const [event, code] of [
      ["notice", "invalid_params"],
      ["restricted", "forbidden"],
      ["decode.fault", "invalid_params"],
    ] as const) {
      socket.receive({
        ...notice(410, ""),
        event,
        data: { message: "", secretPath: "/private" },
      });
      expect(h.peer.state).toBe("ready");
      expect(await errors.next()).toEqual({
        category: "diagnostics",
        event,
        code,
      });
    }
    const next = h.peer.call(sandboxFsList, { path: [] }, h.controller.signal);
    const listing = { listingId: "listing", entries: [], nextCursor: null };
    socket.reply(await nextRequest(socket), listing);
    expect(await next).toEqual(listing);
    expect(
      socket.application.some((message) => {
        return message.type === "response";
      }),
    ).toBe(false);
  });

  it("retires a throwing event-error observer while unrelated business remains usable", async () => {
    const reported: SandboxChannelEventError[] = [];
    const h = harness({
      onEventError(error) {
        reported.push(error);
        throw new Error("observer failure");
      },
    });
    const socket = await h.ready();
    socket.receive(notice(420, ""));
    socket.receive(notice(421, ""));
    expect(h.peer.state).toBe("ready");
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
    expect(reported).toEqual([
      { category: "diagnostics", event: "notice", code: "invalid_params" },
    ]);
  });

  it("suppresses retired-epoch event failures after a replacement becomes ready", async () => {
    const release = new Queue<string>(),
      started = new Queue<string>(),
      finished = new Queue<string>(),
      errors = new Queue<SandboxChannelEventError>();
    const reported: SandboxChannelEventError[] = [];
    const h = harness({
      onEventError(error) {
        reported.push(error);
        errors.put(error);
      },
      events: [
        sandboxChannelEventHandler(sandboxDiagnosticsNotice, async (value) => {
          if (value.message === "old") {
            started.put(value.message);
            try {
              await release.next();
              throw new Error("retired event failure");
            } finally {
              finished.put(value.message);
            }
          }
          throw new Error("current event failure");
        }),
      ],
    });
    const socket = await h.ready();
    socket.receive(notice(430, "old"));
    expect(await started.next()).toBe("old");
    socket.close();
    const ready = h.peer.whenReady(h.controller.signal),
      replacement = await h.sockets.next(),
      hello = await replacement.frames.next();
    if (hello.type !== "hello") throw new Error("fresh hello");
    replacement.reply(hello, { categories: { fs: 3, diagnostics: 1 } });
    await ready;
    release.put("finish old handler");
    expect(await finished.next()).toBe("old");
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    replacement.reply(await nextRequest(replacement), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
    expect(reported).toEqual([]);
    replacement.receive(notice(431, "current"));
    expect(await errors.next()).toEqual({
      category: "diagnostics",
      event: "notice",
      code: "unavailable",
    });
    expect(h.peer.state).toBe("ready");
  });

  it("returns safe handler errors without exposing private details", async () => {
    const h = harness({
      handlers: [
        sandboxChannelHandler(sandboxDiagnosticsEcho, () => {
          throw new Error("secret path /private");
        }),
      ],
    });
    const socket = await h.ready();
    socket.receive(incoming(400));
    const reply = await socket.frames.next();
    expect(reply).toMatchObject({
      type: "response",
      error: { code: "unavailable" },
    });
    expect(JSON.stringify(reply)).not.toContain("private");
    expect(h.peer.state).toBe("ready");
  });

  it("contains malformed structured handler errors without closing unrelated business", async () => {
    const { proxy, revoke } = Proxy.revocable(
      new SandboxChannelError("unavailable"),
      {},
    );
    revoke();
    for (const failure of [
      new SandboxChannelError("category_version_mismatch", {
        category: "/private",
        expectedVersion: 0,
        receivedVersion: 1,
      }),
      new SandboxChannelError("unavailable", {
        get category(): string {
          throw new Error("private error metadata failure");
        },
      }),
      proxy,
    ]) {
      const h = harness({
        handlers: [
          sandboxChannelHandler(sandboxDiagnosticsEcho, () => {
            throw failure;
          }),
        ],
      });
      const socket = await h.ready();
      socket.receive(incoming(460));
      const reply = await Promise.race([
        socket.frames.next(),
        socket.closed.then(() => {
          throw new Error("invalid handler error closed the shared peer");
        }),
      ]);
      expect(reply).toMatchObject({
        type: "response",
        requestId: uuid(460),
        error: { code: "unavailable" },
      });
      if (reply.type !== "response") throw new Error("expected response");
      expect(reply.error).toEqual({ code: "unavailable" });
      expect(reply).not.toHaveProperty("result");
      expect(h.peer.state).toBe("ready");
      const next = h.peer.call(
        sandboxFsList,
        { path: [] },
        h.controller.signal,
      );
      const listing = { listingId: "listing", entries: [], nextCursor: null };
      socket.reply(await nextRequest(socket), listing);
      expect(await next).toEqual(listing);
    }
  });

  it("contains malformed structured decoder errors before request dispatch", async () => {
    const faulty = {
      ...sandboxDiagnosticsEcho,
      operation: "decode.error",
      origin: "guest",
      params: {
        safeParse() {
          throw new SandboxChannelError("invalid_params", {
            category: "/private",
          });
        },
      },
    } as const;
    const h = harness({
      categories: [
        sandboxFsCategory,
        {
          ...sandboxDiagnosticsCategory,
          operations: [...sandboxDiagnosticsCategory.operations, faulty],
        },
      ],
      handlers: [
        sandboxChannelHandler(sandboxDiagnosticsEcho, (params) => {
          return params;
        }),
        {
          operation: faulty,
          async handle() {
            return { payload: "" };
          },
        },
      ],
    });
    const socket = await h.ready();
    socket.receive({ ...incoming(461), operation: faulty.operation });
    const reply = await Promise.race([
      socket.frames.next(),
      socket.closed.then(() => {
        throw new Error("invalid decoder error closed the shared peer");
      }),
    ]);
    expect(reply).toMatchObject({
      type: "response",
      requestId: uuid(461),
      error: { code: "invalid_params" },
    });
    if (reply.type !== "response") throw new Error("expected response");
    expect(reply.error).toEqual({ code: "invalid_params" });
    expect(reply).not.toHaveProperty("result");
    expect(h.peer.state).toBe("ready");
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
  });

  it("isolates synchronous and asynchronous event handler failures with safe local errors", async () => {
    for (const synchronous of [true, false]) {
      const errors = new Queue<SandboxChannelEventError>(),
        notices = new Queue<string>();
      const h = harness({
        onEventError(error) {
          errors.put(error);
        },
        events: [
          {
            event: sandboxDiagnosticsNotice,
            handle(data) {
              if (typeof data !== "object" || data === null)
                throw new Error("expected object");
              if ("message" in data && data.message === "good") {
                notices.put(data.message);
                return Promise.resolve();
              }
              const error = new Error("secret event path /private");
              if (synchronous) throw error;
              return Promise.reject(error);
            },
          },
        ],
      });
      const socket = await h.ready();
      for (let i = 0; i <= SANDBOX_CHANNEL_LIMITS.maxIncoming; i++) {
        socket.receive(notice(401 + i, "bad"));
        expect(h.peer.state).toBe("ready");
        expect(await errors.next()).toEqual({
          category: "diagnostics",
          event: "notice",
          code: "unavailable",
        });
      }
      socket.receive(notice(440, "good"));
      expect(await notices.next()).toBe("good");
      const next = h.peer.call(
        sandboxDiagnosticsEcho,
        { payload: "YQ==" },
        h.controller.signal,
      );
      socket.reply(await nextRequest(socket), { payload: "YQ==" });
      expect(await next).toEqual({ payload: "YQ==" });
      expect(
        socket.application.some((message) => {
          return message.type === "response";
        }),
      ).toBe(false);
    }
  });

  it("validates the captured operation result for directly registered handlers", async () => {
    const h = harness({
      handlers: [
        {
          operation: sandboxDiagnosticsEcho,
          async handle() {
            return { payload: "not base64", privatePath: "/private" };
          },
        },
      ],
    });
    const socket = await h.ready();
    socket.receive(incoming(402));
    const reply = await socket.frames.next();
    expect(reply).toMatchObject({
      type: "response",
      requestId: uuid(402),
      error: { code: "unavailable" },
    });
    expect(reply).not.toHaveProperty("result");
    expect(h.peer.state).toBe("ready");
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
  });

  it("rejects a duplicate active inbound ID without executing it twice", async () => {
    const h = harness({
      handlers: [
        sandboxChannelHandler(sandboxDiagnosticsEcho, (params, context) => {
          return context.peer.call(
            sandboxDiagnosticsEcho,
            params,
            context.signal,
          );
        }),
      ],
    });
    const socket = await h.ready();
    socket.receive(incoming(450));
    await nextRequest(socket);
    socket.receive(incoming(450));
    await socket.closed;
    expect(h.peer.state).toBe("failed");
    expect(
      socket.application.filter((message) => {
        return message.type === "request";
      }),
    ).toHaveLength(1);
  });

  it("drops canceled queued calls before any external write", async () => {
    const h = harness(),
      socket = await h.ready();
    const controller = new AbortController();
    let cancelled: Promise<void> | undefined;
    socket.onSend = (message) => {
      if (message.type !== "request") return;
      const queued = h.peer.call(
        sandboxDiagnosticsEcho,
        { payload: "Yg==" },
        controller.signal,
      );
      cancelled = expect(queued).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      socket.reply(message, { payload: "YQ==" });
    };
    expect(
      await h.peer.call(
        sandboxDiagnosticsEcho,
        { payload: "YQ==" },
        h.controller.signal,
      ),
    ).toEqual({ payload: "YQ==" });
    await cancelled;
    expect(
      socket.application.filter((message) => {
        return message.type === "request";
      }),
    ).toHaveLength(1);
  });

  it("closes instead of retaining a writer frame beyond its finite queue age", async () => {
    const h = harness(),
      socket = await h.ready();
    let time = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => {
      return time;
    });
    socket.onSend = (message) => {
      if (message.type !== "request") return;
      expect(
        h.peer.sendEvent(sandboxDiagnosticsNotice, { message: "queued" }),
      ).toBe(true);
      time += SANDBOX_CHANNEL_LIMITS.writeTimeoutMs;
    };
    await expect(
      h.peer.call(sandboxDiagnosticsEcho, { payload: "" }, h.controller.signal),
    ).rejects.toMatchObject({ code: "unavailable" });
    await socket.closed;
    expect(h.peer.state).toBe("failed");
    expect(
      socket.application.map((message) => {
        return message.type;
      }),
    ).toEqual(["hello", "request"]);
  });

  it("rejects event overload locally without acknowledgments and recovers capacity", async () => {
    const errors = new Queue<SandboxChannelEventError>(),
      completed = new Queue<string>();
    const h = harness({
      onEventError(error) {
        errors.put(error);
      },
      events: [
        sandboxChannelEventHandler(
          sandboxDiagnosticsNotice,
          async (value, context) => {
            await context.peer.call(
              sandboxDiagnosticsEcho,
              { payload: "" },
              context.signal,
            );
            completed.put(value.message);
          },
        ),
      ],
    });
    const socket = await h.ready();
    for (let i = 0; i < SANDBOX_CHANNEL_LIMITS.maxIncoming; i++) {
      socket.receive({
        schemaVersion: 1,
        type: "event",
        id: uuid(600 + i),
        category: "diagnostics",
        categoryVersion: 1,
        event: "notice",
        data: { message: "held" },
      });
    }
    const reverse = await Promise.all(
      Array.from({ length: SANDBOX_CHANNEL_LIMITS.maxIncoming }, () => {
        return nextRequest(socket);
      }),
    );
    socket.receive({
      schemaVersion: 1,
      type: "event",
      id: uuid(700),
      category: "diagnostics",
      categoryVersion: 1,
      event: "notice",
      data: { message: "over budget" },
    });
    expect(h.peer.state).toBe("ready");
    expect(await errors.next()).toEqual({
      category: "diagnostics",
      event: "notice",
      code: "busy",
    });
    for (const request of reverse) socket.reply(request, { payload: "" });
    for (const _request of reverse) expect(await completed.next()).toBe("held");
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    socket.reply(await nextRequest(socket), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
    socket.receive(notice(701, "after recovery"));
    socket.reply(await nextRequest(socket), { payload: "" });
    expect(await completed.next()).toBe("after recovery");
    expect(
      socket.application.some((message) => {
        return message.type === "response";
      }),
    ).toBe(false);
  });

  it("rejects missing categories and forbidden directions without executing handlers", async () => {
    const h = harness(),
      socket = await h.ready({ diagnostics: 1 });
    await expect(
      h.peer.call(sandboxFsList, { path: [] }, h.controller.signal),
    ).rejects.toMatchObject({ code: "unsupported_category" });
    const other = harness(),
      remote = await other.ready();
    remote.receive({
      schemaVersion: 1,
      type: "request",
      id: uuid(750),
      category: "fs",
      categoryVersion: 2,
      operation: "list",
      params: { path: [] },
    });
    expect(await remote.frames.next()).toMatchObject({
      type: "response",
      requestId: uuid(750),
      error: { code: "forbidden" },
    });
    expect(other.peer.state).toBe("ready");
    expect(
      socket.application.map((message) => {
        return message.type;
      }),
    ).toEqual(["hello"]);
  });

  it("never replaces pending ownership on local UUID collisions", async () => {
    const h = harness(),
      socket = await h.ready();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uuid(500));
    const first = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "" },
      h.controller.signal,
    );
    const sent = await nextRequest(socket);
    await expect(
      h.peer.call(sandboxDiagnosticsEcho, { payload: "" }, h.controller.signal),
    ).rejects.toMatchObject({ code: "invalid_request" });
    socket.reply(sent, { payload: "" });
    expect(await first).toEqual({ payload: "" });
  });

  it("fails closed when the secure UUID source fails", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("unavailable");
    });
    const h = harness();
    await expect(h.peer.connect(h.controller.signal)).rejects.toBeInstanceOf(
      Error,
    );
    expect(h.peer.state).toBe("failed");
  });

  it("rejects backpressure without replay and closes on undeliverable terminal replies", async () => {
    const h = harness(),
      socket = await h.ready();
    socket.bufferedAmount = RUN_WSS_MAX_BUFFERED_BYTES;
    await expect(
      h.peer.call(
        sandboxDiagnosticsEcho,
        { payload: "YQ==" },
        h.controller.signal,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    socket.bufferedAmount = 0;
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "Yg==" },
      h.controller.signal,
    );
    const request = await nextRequest(socket);
    expect(request.params).toEqual({ payload: "Yg==" });
    socket.reply(request, { payload: "Yg==" });
    expect(await next).toEqual({ payload: "Yg==" });
    socket.bufferedAmount = RUN_WSS_MAX_BUFFERED_BYTES;
    socket.receive(incoming(550));
    await socket.closed;
    expect(h.peer.state).toBe("failed");
  });

  it("bounds reentrant writer frames and encoded bytes", async () => {
    const chunk = {
      category: "bulk",
      categoryVersion: 1,
      event: "chunk",
      origin: "either",
      data: sandboxChannelObjectSchema,
    } as const;
    const bulk = {
      category: "bulk",
      version: 1,
      operations: [],
      events: [chunk],
    } as const satisfies SandboxChannelCategoryContract;
    for (const [large, count] of [
      [false, 8],
      [true, 4],
    ] as const) {
      const h = harness({
        categories: [sandboxFsCategory, sandboxDiagnosticsCategory, bulk],
      });
      const started = await h.start();
      started.socket.reply(started.hello, {
        categories: { fs: 3, diagnostics: 1, bulk: 1 },
      });
      await started.connected;
      const socket = started.socket,
        accepted: boolean[] = [];
      socket.onSend = (message) => {
        if (message.type !== "request") return;
        for (let i = 0; i < 12; i++)
          accepted.push(
            h.peer.sendEvent(chunk, {
              payload: "x".repeat(large ? 60_000 : 1),
            }),
          );
        socket.reply(message, { payload: "" });
      };
      expect(
        await h.peer.call(
          sandboxDiagnosticsEcho,
          { payload: "" },
          h.controller.signal,
        ),
      ).toEqual({ payload: "" });
      expect(accepted.filter(Boolean)).toHaveLength(count);
      await nextRequest(socket);
      for (let i = 0; i < count; i++)
        expect(await socket.frames.next()).toMatchObject({
          type: "event",
          category: "bulk",
        });
    }
  });

  it("cancels waits and rebuilds readiness/ownership on reconnect", async () => {
    const h = harness(),
      socket = await h.ready();
    const first = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    const previous = await nextRequest(socket),
      rejected = expect(first).rejects.toBeInstanceOf(Error);
    socket.close();
    await rejected;
    const ready = h.peer.whenReady(h.controller.signal);
    const replacement = await h.sockets.next(),
      hello = await replacement.frames.next();
    if (hello.type !== "hello") throw new Error("fresh hello");
    replacement.reply(hello, { categories: { fs: 3, diagnostics: 1 } });
    await ready;
    const second = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "Yg==" },
      h.controller.signal,
    );
    const next = await nextRequest(replacement);
    expect(next.id).not.toBe(previous.id);
    replacement.reply(previous, { payload: "YmFk" });
    socket.reply(previous, { payload: "YmFk" });
    replacement.reply(next, { payload: "Yg==" });
    expect(await second).toEqual({ payload: "Yg==" });
    const controller = new AbortController();
    const cancelled = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "" },
      controller.signal,
    );
    await nextRequest(replacement);
    const abort = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await abort;
    const final = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "" },
      h.controller.signal,
    );
    await nextRequest(replacement);
    const finalAbort = expect(final).rejects.toMatchObject({
      name: "AbortError",
    });
    h.controller.abort();
    await finalAbort;
    expect(h.peer.state).toBe("closed");
  });

  it("retires queued terminal responses when their socket epoch disconnects", async () => {
    const h = harness(),
      socket = await h.ready();
    socket.onSend = (message) => {
      if (message.type !== "request") return;
      // This immediate error response queues behind the active external send.
      socket.receive({ ...incoming(810), operation: "unknown" });
      socket.close();
    };
    await expect(
      h.peer.call(sandboxDiagnosticsEcho, { payload: "" }, h.controller.signal),
    ).rejects.toBeInstanceOf(Error);
    expect(h.peer.state).toBe("reconnecting");
    const ready = h.peer.whenReady(h.controller.signal),
      replacement = await h.sockets.next(),
      hello = await replacement.frames.next();
    if (hello.type !== "hello") throw new Error("fresh hello");
    replacement.reply(hello, { categories: { fs: 3, diagnostics: 1 } });
    await ready;
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    replacement.reply(await nextRequest(replacement), { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
    expect(replacement.application[0]).toMatchObject({ type: "hello" });
    expect(
      socket.application.map((message) => {
        return message.type;
      }),
    ).toEqual(["hello", "request"]);
  });

  it("keeps a peer closed when an epoch-abort handler closes it during disconnect", async () => {
    const h = harness({
      handlers: [
        sandboxChannelHandler(sandboxDiagnosticsEcho, (params, context) => {
          context.signal.addEventListener(
            "abort",
            () => {
              context.peer.close();
            },
            { once: true },
          );
          return context.peer.call(
            sandboxDiagnosticsEcho,
            params,
            context.signal,
          );
        }),
      ],
    });
    const socket = await h.ready();
    socket.receive(incoming(811));
    await nextRequest(socket);
    socket.close();
    expect(h.peer.state).toBe("closed");
    await expect(h.peer.whenReady(h.controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("bounds hello silence with a stable terminal failure", async () => {
    const h = harness(),
      { connected, socket } = await h.start();
    await expect(connected).rejects.toMatchObject({ code: "unavailable" });
    await socket.closed;
    expect(h.peer.state).toBe("failed");
  }, 10_000);

  it("expires an unanswered call and releases capacity for a fresh attempt", async () => {
    const h = harness(),
      socket = await h.ready();
    const silent = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "" },
      h.controller.signal,
    );
    const expired = await nextRequest(socket);
    await expect(silent).rejects.toMatchObject({ code: "unavailable" });
    const next = h.peer.call(
      sandboxDiagnosticsEcho,
      { payload: "YQ==" },
      h.controller.signal,
    );
    const request = await nextRequest(socket);
    socket.reply(expired, { payload: "YmFk" });
    socket.reply(request, { payload: "YQ==" });
    expect(await next).toEqual({ payload: "YQ==" });
  }, 15_000);
});

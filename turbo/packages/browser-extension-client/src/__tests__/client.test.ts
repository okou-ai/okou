import { expect, it } from "vitest";
import {
  BrowserBridgeError,
  OkouBrowserClient,
  type CdpEvent,
  type CdpTransport,
} from "../index";

/** External CDP peer; all bridge parsing, lifecycle and cleanup code is real. */
function bridgePeer() {
  const runtimeId = "a".repeat(32);
  const requests: { method: string; sessionId?: string }[] = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const failures = new Map<string, Error>();
  let result: unknown = {
    result: {
      value: {
        ok: true,
        epoch: "private-epoch",
        startedSequence: 0,
        sequence: 0,
        value: { protocol: 1, capabilities: ["windows", "tabs", "events"] },
      },
    },
  };
  const transport: CdpTransport = {
    async request(method, _params, sessionId) {
      requests.push({ method, sessionId });
      const failure = failures.get(method);
      if (failure) throw failure;
      if (method === "Target.attachToBrowserTarget")
        return { sessionId: "private-browser-session" };
      if (method === "Target.attachToTarget")
        return { sessionId: "private-worker-session" };
      if (method === "Target.getTargets")
        return {
          targetInfos: [
            {
              targetId: "private-worker-target",
              type: "service_worker",
              url: `chrome-extension://${runtimeId}/worker.js`,
            },
          ],
        };
      if (method === "Runtime.evaluate") return result;
      return {};
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        return listeners.delete(listener);
      };
    },
  };
  return {
    requests,
    failures,
    listeners,
    connect(signal?: AbortSignal) {
      return OkouBrowserClient.connect({ transport, runtimeId, signal });
    },
    reply(value: unknown) {
      result = value;
    },
    event(event: CdpEvent) {
      for (const listener of listeners) listener(event);
    },
    native(value: unknown) {
      this.event({
        method: "Runtime.bindingCalled",
        sessionId: "private-worker-session",
        params: { name: "__okouBrowserEvent", payload: JSON.stringify(value) },
      });
    },
  };
}

it("bootstrap failure retains only safe method/code/stage through cleanup", async () => {
  const peer = bridgePeer();
  const original = Object.assign(
    new Error("wss://private-endpoint?token=private-credential"),
    { code: -32_001, cause: new Error("private-page-value") },
  );
  peer.failures.set("Runtime.addBinding", original);
  const error: unknown = await peer.connect().catch((failure: unknown) => {
    return failure;
  });
  expect(error).toMatchObject({
    name: "BrowserBridgeError",
    kind: "unavailable",
    diagnostics: {
      stage: "bind-events",
      reason: "cdp-request-failed",
      request: { method: "Runtime.addBinding", code: -32_001 },
    },
  });
  if (!(error instanceof BrowserBridgeError)) throw error;
  expect(error.message).toContain("method=Runtime.addBinding, code=-32001");
  expect(
    JSON.stringify({
      ...error,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    }),
  ).not.toMatch(/private-|chrome-extension:/);
  expect(peer.listeners.size).toBe(0);
  expect(
    peer.requests.filter((request) => {
      return request.method === "Target.detachFromTarget";
    }),
  ).toHaveLength(2);
});

it.each([
  { reply: { result: { type: "undefined" } }, reason: "bridge-missing" },
  {
    reply: {
      result: {
        value: {
          ok: true,
          epoch: "private-epoch",
          startedSequence: 0,
          sequence: 0,
          value: { protocol: 2, capabilities: [] },
        },
      },
    },
    reason: "protocol-mismatch",
  },
  {
    reply: {
      result: {
        value: {
          ok: true,
          epoch: "private-epoch",
          startedSequence: 0,
          sequence: 0,
          value: { protocol: 1, capabilities: ["tabs"] },
        },
      },
    },
    reason: "capability-missing",
  },
])("hello retains the observed $reason", async ({ reply, reason }) => {
  const peer = bridgePeer();
  peer.reply(reply);
  await expect(peer.connect()).rejects.toMatchObject({
    kind: "unavailable",
    diagnostics: { stage: "hello", reason },
  });
});

it.each([
  {
    method: "Target.detachedFromTarget",
    sessionId: undefined,
    params: { sessionId: "private-browser-session" },
    reason: "browser-session-detached",
  },
  {
    method: "Inspector.targetCrashed",
    sessionId: "private-worker-session",
    params: {},
    reason: "worker-crashed",
  },
  {
    method: "Runtime.executionContextsCleared",
    sessionId: "private-worker-session",
    params: {},
    reason: "worker-context-cleared",
  },
  {
    method: "Target.detachedFromTarget",
    sessionId: "private-browser-session",
    params: { sessionId: "private-worker-session" },
    reason: "worker-session-detached",
  },
  {
    method: "Target.targetDestroyed",
    sessionId: "private-browser-session",
    params: { targetId: "private-worker-target" },
    reason: "worker-target-destroyed",
  },
])(
  "lifetime retains $reason and cannot be overwritten by cleanup",
  async ({ reason, ...event }) => {
    const peer = bridgePeer();
    const client = await peer.connect();
    peer.event(event);
    const failure: unknown = client.signal.reason;
    expect(failure).toMatchObject({ diagnostics: { stage: "ready", reason } });
    await client.close();
    expect(client.signal.reason).toBe(failure);
    await expect(client.call("listWindows", {})).rejects.toBe(failure);
    expect(peer.listeners.size).toBe(0);
  },
);

it.each([
  {
    value: {
      epoch: "private-replacement-epoch",
      sequence: 1,
      kind: "tab-updated",
    },
    reason: "epoch-changed",
  },
  {
    value: { epoch: "private-epoch", sequence: 2, kind: "tab-updated" },
    reason: "sequence-gap",
  },
  { value: { secret: "private-binding-payload" }, reason: "binding-malformed" },
])(
  "binding invalidation retains $reason without payloads",
  async ({ value, reason }) => {
    const peer = bridgePeer();
    const client = await peer.connect();
    peer.native(value);
    expect(client.signal.reason).toMatchObject({
      diagnostics: { stage: "ready", reason },
    });
    expect(JSON.stringify(client.signal.reason)).not.toContain("private-");
    await client.close();
  },
);

it("native call failure retains safe request facts without changing its kind", async () => {
  const peer = bridgePeer();
  const client = await peer.connect();
  peer.failures.set(
    "Runtime.evaluate",
    Object.assign(new Error("private-provider-error"), { code: -32_601 }),
  );
  await expect(client.call("listWindows", {})).rejects.toMatchObject({
    kind: "native",
    diagnostics: {
      stage: "ready",
      reason: "cdp-request-failed",
      request: { method: "Runtime.evaluate", code: -32_601 },
    },
  });
  await client.close();
});

it("observed connection loss stays distinct from an incompatible extension", async () => {
  const peer = bridgePeer();
  peer.failures.set(
    "Runtime.enable",
    Object.assign(new Error("private-transport-message"), {
      kind: "connection",
      code: Number.POSITIVE_INFINITY,
    }),
  );
  const failure: unknown = await peer.connect().catch((error: unknown) => {
    return error;
  });
  if (!(failure instanceof BrowserBridgeError)) throw failure;
  expect(failure.diagnostics).toStrictEqual({
    stage: "enable-runtime",
    reason: "cdp-connection-failed",
    request: { method: "Runtime.enable" },
  });
});

it("a response ahead of the event stream preserves its first invalidation reason", async () => {
  const peer = bridgePeer();
  const client = await peer.connect();
  peer.reply({
    result: {
      value: {
        ok: true,
        epoch: "private-epoch",
        startedSequence: 0,
        sequence: 2,
        value: [],
      },
    },
  });
  const failure: unknown = await client
    .call("listWindows", {})
    .catch((error: unknown) => {
      return error;
    });
  expect(failure).toMatchObject({
    diagnostics: { stage: "ready", reason: "response-sequence-ahead" },
  });
  expect(client.signal.reason).toBe(failure);
  await client.close();
});

it("owner cancellation and deliberate close retain a cancellation lifetime", async () => {
  const peer = bridgePeer();
  const owner = new AbortController();
  const client = await peer.connect(owner.signal);
  owner.abort(new Error("private-owner-reason"));
  await client.close();
  expect(client.signal.reason).toMatchObject({ name: "AbortError" });
  expect(peer.listeners.size).toBe(0);
});

it("an aborted attachment still releases its late native session", async () => {
  const abort = new AbortController();
  const commands: {
    method: string;
    params: Readonly<Record<string, unknown>>;
    sessionId: string | undefined;
  }[] = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const pending = OkouBrowserClient.connect({
    runtimeId: "a".repeat(32),
    signal: abort.signal,
    transport: {
      async request(method, params, sessionId) {
        commands.push({ method, params, sessionId });
        if (method === "Target.attachToBrowserTarget") {
          abort.abort();
          return { sessionId: "late-owned-browser-session" };
        }
        return {};
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => {
          return listeners.delete(listener);
        };
      },
    },
  });
  await expect(pending).rejects.toMatchObject({
    name: "BrowserBridgeError",
    kind: "unavailable",
    diagnostics: { stage: "attach-browser", reason: "closed" },
  });
  expect(listeners.size).toBe(0);
  expect(commands).toStrictEqual([
    {
      method: "Target.attachToBrowserTarget",
      params: {},
      sessionId: undefined,
    },
    {
      method: "Target.detachFromTarget",
      params: { sessionId: "late-owned-browser-session" },
      sessionId: undefined,
    },
  ]);
});

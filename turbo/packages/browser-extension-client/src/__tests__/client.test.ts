import { expect, it, vi } from "vitest";
import {
  BrowserBridgeError,
  OkouBrowserClient,
  type CdpEvent,
  type CdpTransport,
} from "../index";

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      resolve();
    },
  };
}

/** External CDP peer; all bridge parsing, lifecycle and cleanup code is real. */
function bridgePeer(pages: string[] = []) {
  const runtimeId = "a".repeat(32);
  const requests: { method: string; sessionId?: string }[] = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const failures = new Map<string, Error>();
  const sessions = new Set<string>();
  const observations: string[] = [];
  let observing: ((session: string) => void) | undefined;
  let nextSession = 0;
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
    async request(method, params, sessionId) {
      requests.push({ method, sessionId });
      const failure = failures.get(method);
      if (failure) throw failure;
      if (method === "Target.attachToBrowserTarget") {
        sessions.add("private-browser-session");
        return { sessionId: "private-browser-session" };
      }
      if (method === "Target.attachToTarget") {
        if (
          params.targetId !== "private-worker-target" &&
          !pages.includes(String(params.targetId))
        )
          throw Object.assign(new Error("No target with given id"), {
            code: -32602,
          });
        const id =
          params.targetId === "private-worker-target"
            ? "private-worker-session"
            : `private-page-session-${++nextSession}`;
        sessions.add(id);
        return { sessionId: id };
      }
      if (method === "Target.detachFromTarget")
        sessions.delete(String(params.sessionId));
      if (method === "ServiceWorker.enable" && sessionId) {
        if (observing) {
          const resolve = observing;
          observing = undefined;
          resolve(sessionId);
        } else observations.push(sessionId);
      }
      if (method === "Target.getTargets")
        return {
          targetInfos: [
            {
              targetId: "private-worker-target",
              type: "service_worker",
              url: `chrome-extension://${runtimeId}/worker.js`,
            },
            ...pages.map((targetId) => {
              return {
                targetId,
                type: "page",
                url: "about:blank",
              };
            }),
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
    transport,
    runtimeId,
    sessions,
    async observer() {
      const id = observations.shift();
      if (id) return id;
      return await new Promise<string>((resolve) => {
        observing = resolve;
      });
    },
    losePage(targetId: string, sessionId?: string) {
      const index = pages.indexOf(targetId);
      if (index !== -1) pages.splice(index, 1);
      this.event({
        method: "Target.targetDestroyed",
        sessionId: "private-browser-session",
        params: { targetId },
      });
      if (sessionId) {
        sessions.delete(sessionId);
        this.event({
          method: "Target.detachedFromTarget",
          sessionId: "private-browser-session",
          params: { sessionId },
        });
      }
    },
    running(sessionId: string, id = runtimeId) {
      this.event({
        method: "ServiceWorker.workerVersionUpdated",
        sessionId,
        params: {
          versions: [
            {
              scriptURL: `chrome-extension://${id}/worker.js`,
              targetId: "private-worker-target",
              runningStatus: "running",
            },
          ],
        },
      });
    },
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

it("retired observer and wrong-runtime events cannot supply replacement readiness", async () => {
  vi.useFakeTimers();
  const peer = bridgePeer(["left-page", "right-page"]);
  const owner = new AbortController();
  const connecting = OkouBrowserClient.connect({
    transport: peer.transport,
    runtimeId: peer.runtimeId,
    readinessTimeoutMs: 100,
    signal: owner.signal,
  });
  const settled = connecting.catch((error: unknown) => {
    return error;
  });
  try {
    const first = await peer.observer();
    peer.losePage("left-page", first);
    const second = await peer.observer();
    peer.running(first);
    peer.event({
      method: "Target.detachedFromTarget",
      sessionId: "private-browser-session",
      params: { sessionId: first },
    });
    peer.event({
      method: "Target.targetCreated",
      sessionId: "private-browser-session",
      params: {
        targetInfo: {
          targetId: "private-worker-target",
          type: "service_worker",
          url: `chrome-extension://${peer.runtimeId}/worker.js`,
        },
      },
    });
    peer.running(second, "b".repeat(32));
    await vi.advanceTimersByTimeAsync(100);
    expect(await settled).toMatchObject({
      diagnostics: { reason: "worker-readiness-timeout" },
    });
    expect(peer.sessions.size).toBe(0);
    expect(peer.listeners.size).toBe(0);
  } finally {
    owner.abort();
    await connecting.then(
      (client) => {
        return client.close();
      },
      () => {},
    );
    vi.useRealTimers();
  }
});

it.each(["attach", "enable"])(
  "recovers proven page loss during %s",
  async (boundary) => {
    const peer = bridgePeer(["left-page", "right-page"]);
    let lost = false;
    const connecting = OkouBrowserClient.connect({
      runtimeId: peer.runtimeId,
      transport: {
        onEvent: peer.transport.onEvent,
        async request(method, params, sessionId) {
          const result = await peer.transport.request(
            method,
            params,
            sessionId,
          );
          if (
            !lost &&
            ((boundary === "attach" &&
              method === "Target.attachToTarget" &&
              params.targetId === "left-page") ||
              (boundary === "enable" && method === "ServiceWorker.enable"))
          ) {
            lost = true;
            peer.losePage("left-page");
            if (boundary === "enable")
              throw Object.assign(new Error("Session closed"), {
                code: -32001,
              });
          }
          return result;
        },
      },
    });
    if (boundary === "enable") await peer.observer();
    peer.running(await peer.observer());
    const client = await connecting;
    expect(client.signal.aborted).toBe(false);
    await client.close();
    expect(peer.sessions.size).toBe(0);
  },
);

it("does not use a retained worker target when no replacement page survives", async () => {
  const peer = bridgePeer(["only-page"]);
  const connecting = peer.connect();
  peer.losePage("only-page", await peer.observer());
  await expect(connecting).rejects.toMatchObject({
    diagnostics: { reason: "worker-unobserved" },
  });
  expect(peer.sessions.size).toBe(0);
  expect(peer.listeners.size).toBe(0);
});

it("reconciles a page that disappeared before observation began", async () => {
  const peer = bridgePeer(["left-page", "right-page"]);
  let listed = false;
  const connecting = OkouBrowserClient.connect({
    runtimeId: peer.runtimeId,
    transport: {
      onEvent: peer.transport.onEvent,
      async request(method, params, sessionId) {
        const result = await peer.transport.request(method, params, sessionId);
        if (method === "Target.getTargets" && !listed) {
          listed = true;
          peer.losePage("left-page");
        }
        return result;
      },
    },
  });
  peer.running(await peer.observer());
  const client = await connecting;
  expect((await client.call("hello", {})).value.protocol).toBe(1);
  await client.close();
  expect(peer.sessions.size).toBe(0);
});

it("cancellation owns a late replacement attachment and releases every session", async () => {
  const peer = bridgePeer(["left-page", "right-page"]);
  const attached = deferred();
  const release = deferred();
  const owner = new AbortController();
  const connecting = OkouBrowserClient.connect({
    runtimeId: peer.runtimeId,
    signal: owner.signal,
    transport: {
      onEvent: peer.transport.onEvent,
      async request(method, params, sessionId) {
        const result = await peer.transport.request(method, params, sessionId);
        if (
          method === "Target.attachToTarget" &&
          params.targetId === "right-page"
        ) {
          attached.resolve();
          await release.promise;
        }
        return result;
      },
    },
  });
  peer.losePage("left-page", await peer.observer());
  await attached.promise;
  owner.abort();
  release.resolve();
  await expect(connecting).rejects.toMatchObject({ kind: "unavailable" });
  expect(peer.sessions.size).toBe(0);
  expect(peer.listeners.size).toBe(0);
});

it("observer replacement shares the original readiness deadline", async () => {
  vi.useFakeTimers();
  const peer = bridgePeer(["left-page", "right-page"]);
  const connecting = OkouBrowserClient.connect({
    transport: peer.transport,
    runtimeId: peer.runtimeId,
    readinessTimeoutMs: 100,
  });
  const rejected = expect(connecting).rejects.toMatchObject({
    diagnostics: { reason: "worker-readiness-timeout" },
  });
  try {
    const first = await peer.observer();
    await vi.advanceTimersByTimeAsync(60);
    peer.losePage("left-page", first);
    await peer.observer();
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    expect(peer.sessions.size).toBe(0);
    expect(peer.listeners.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("real worker destruction still fails bootstrap after observer replacement", async () => {
  const peer = bridgePeer(["left-page", "right-page"]);
  const connecting = peer.connect();
  peer.losePage("left-page", await peer.observer());
  peer.running(await peer.observer());
  peer.event({
    method: "Target.targetDestroyed",
    sessionId: "private-browser-session",
    params: { targetId: "private-worker-target" },
  });
  await expect(connecting).rejects.toMatchObject({
    diagnostics: { reason: "worker-target-destroyed" },
  });
  expect(peer.sessions.size).toBe(0);
});

it("an observer request failure without page loss is not retried", async () => {
  const peer = bridgePeer(["live-page"]);
  peer.failures.set(
    "ServiceWorker.enable",
    Object.assign(new Error("Native failure"), { code: -32000 }),
  );
  await expect(peer.connect()).rejects.toMatchObject({
    diagnostics: { reason: "cdp-request-failed" },
  });
  expect(
    peer.requests.filter((r) => {
      return r.method === "ServiceWorker.enable";
    }),
  ).toHaveLength(1);
  expect(peer.sessions.size).toBe(0);
});

it.each(["connection", "protocol"])(
  "page loss cannot conceal a %s transport failure",
  async (kind) => {
    const peer = bridgePeer(["left-page", "right-page"]);
    const connecting = OkouBrowserClient.connect({
      runtimeId: peer.runtimeId,
      transport: {
        onEvent: peer.transport.onEvent,
        async request(method, params, sessionId) {
          const result = await peer.transport.request(
            method,
            params,
            sessionId,
          );
          if (method === "ServiceWorker.enable") {
            peer.losePage("left-page");
            throw Object.assign(new Error("Transport failure"), { kind });
          }
          return result;
        },
      },
    });
    await expect(connecting).rejects.toMatchObject({
      diagnostics: { reason: `cdp-${kind}-failed` },
    });
    expect(peer.sessions.size).toBe(0);
    expect(peer.listeners.size).toBe(0);
  },
);

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

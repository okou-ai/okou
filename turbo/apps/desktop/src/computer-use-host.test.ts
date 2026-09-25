import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import {
  ComputerUseHostRuntime,
  readSystemHostName,
  type ComputerUseHostFetch,
} from "./computer-use-host";
import {
  createDesktopClientHeaderInjector,
  type DesktopClientHeaderInjector,
} from "./desktop-client-headers";
import type {
  ComputerUseCommand,
  ComputerUseCommandFailure,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type { ComputerUsePermissionState } from "./computer-use-types";

const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const noopAddClientHeaders = () => {};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function uuidSequence(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (!value) {
      throw new Error("UUID sequence exhausted");
    }
    return value;
  };
}

function hungResponseUntilAbort(
  init: RequestInit | undefined,
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    if (!init?.signal) {
      reject(new Error("Expected request abort signal"));
      return;
    }
    init.signal.addEventListener(
      "abort",
      () => {
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

function createRuntime(
  options: {
    readonly sessionFetch?: ComputerUseHostFetch;
    readonly hostFetch?: ComputerUseHostFetch;
    readonly addClientHeaders?: DesktopClientHeaderInjector;
    readonly executeCommand?: (
      command: ComputerUseCommand,
      permissions: ComputerUsePermissionState,
    ) => Promise<ComputerUseCommandExecutionResult>;
    readonly onCommandFailure?: (args: {
      readonly command: ComputerUseCommand;
      readonly failure: ComputerUseCommandFailure;
    }) => void;
  } = {},
) {
  const sessionFetch =
    options.sessionFetch ??
    vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
  const hostFetch =
    options.hostFetch ??
    vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      return jsonResponse({ status: "idle" });
    });
  const runtime = new ComputerUseHostRuntime({
    platformUrl: new URL("https://app.okou.ai"),
    installationId: INSTALLATION_ID,
    hostName: "lancy-macbook-pro.local",
    appVersion: "1.2.3",
    sessionFetch,
    hostFetch,
    addClientHeaders: options.addClientHeaders ?? noopAddClientHeaders,
    getPermissions() {
      return { accessibility: true, screenRecording: false };
    },
    acquireCommand: () => ({
      getPermissions: async () => ({
        accessibility: true,
        screenRecording: false,
      }),
      async executeCommand(command, permissions) {
        if (options.executeCommand)
          return options.executeCommand(command, permissions);
        return { status: "succeeded", result: {} };
      },
      release() {},
    }),
    ...(options.onCommandFailure
      ? { onCommandFailure: options.onCommandFailure }
      : {}),
  });
  return { runtime, sessionFetch, hostFetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ComputerUseHostRuntime", () => {
  it("reads the system hostname with an app-name fallback", () => {
    const hostname = vi
      .spyOn(os, "hostname")
      .mockReturnValue(" lancy-macbook-pro.local ");

    expect(readSystemHostName("Okou")).toBe("lancy-macbook-pro.local");

    hostname.mockReturnValue(" ");
    expect(readSystemHostName("Okou")).toBe("Okou");
  });

  it("does not register a host until manually started", async () => {
    vi.useFakeTimers();
    const { runtime, sessionFetch, hostFetch } = createRuntime();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runtime.getState().status).toBe("offline");
    expect(sessionFetch).not.toHaveBeenCalled();
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("registers the host on manual start without requiring Screen Recording", async () => {
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
    const { runtime, hostFetch } = createRuntime({ sessionFetch });

    await runtime.start();

    expect(sessionFetch).toHaveBeenCalledOnce();
    const call = sessionFetch.mock.calls[0];
    if (!call) {
      throw new Error("Expected Computer Use host registration request");
    }
    const [url, init] = call;
    expect(url).toBe("https://api.okou.ai/api/computer-use/hosts/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      installationId: INSTALLATION_ID,
      hostName: "lancy-macbook-pro.local",
      appVersion: "1.2.3",
      permissions: {
        accessibility: true,
        screenRecording: false,
      },
    });
    expect(runtime.getState()).toMatchObject({
      status: "online",
      hostId: "host-1",
      lastError: null,
    });
    expect(hostFetch).not.toHaveBeenCalled();

    await runtime.stop();
  });

  it("uses the host bearer token for polling after registration", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      return jsonResponse({ status: "idle" });
    });
    const { runtime } = createRuntime({
      sessionFetch,
      hostFetch,
      addClientHeaders: createDesktopClientHeaderInjector({
        clientVersion: "1.2.3",
        createUuid: uuidSequence(
          "session-id",
          "request-id-1",
          "request-id-2",
          "request-id-3",
        ),
      }),
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    const heartbeatCall = hostFetch.mock.calls.find(([url]) => {
      return url.endsWith("/api/computer-use/heartbeat");
    });
    if (!heartbeatCall) {
      throw new Error("Expected Computer Use heartbeat request");
    }
    const headers = new Headers(heartbeatCall[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get(CLIENT_VERSION_HEADER)).toBe("1.2.3");
    expect(headers.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_DESKTOP);
    expect(headers.get(CLIENT_SESSION_ID_HEADER)).toBe("session-id");
    expect(headers.get(CLIENT_REQUEST_ID_HEADER)).toBe("request-id-1");
    expect(JSON.parse(String(heartbeatCall[1]?.body))).toMatchObject({
      installationId: INSTALLATION_ID,
    });
    expect(sessionFetch.mock.calls[0]?.[0]).toBe(
      "https://api.okou.ai/api/computer-use/hosts/start",
    );

    await runtime.stop();
  });

  it("uses the five-second cold interval for a newly started idle host", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return jsonResponse({ status: "idle" });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(4_999);

    expect(nextCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

    expect(nextCalls).toBe(1);

    await runtime.stop();
  });

  it("clears command polling recovery when the next idle claim succeeds", async () => {
    vi.useFakeTimers();
    const heartbeat = deferred<Response>();
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return heartbeat.promise;
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? new Response("{}", { status: 500 })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/stop")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Computer Use command claim failed: 500",
      recovery: {
        phase: "command_poll",
        attempt: 1,
        retryDelayMs: 2_000,
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(nextCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
    });

    await runtime.stop();
  });

  it("keeps heartbeat deactivation when a late idle command poll resolves", async () => {
    vi.useFakeTimers();
    const heartbeat = deferred<Response>();
    const commandPoll = deferred<Response>();
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return heartbeat.promise;
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        return commandPoll.promise;
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    heartbeat.resolve(new Response("{}", { status: 401 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.getState()).toMatchObject({
      status: "unauthenticated",
      hostId: null,
      lastError:
        "Desktop host could not authenticate with the API session. Sign in and retry.",
    });

    commandPoll.resolve(jsonResponse({ status: "idle" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.getState()).toMatchObject({
      status: "unauthenticated",
      hostId: null,
      lastError:
        "Desktop host could not authenticate with the API session. Sign in and retry.",
    });
  });

  it("deactivates for restart when command polling rejects the host token", async () => {
    vi.useFakeTimers();
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        return new Response("{}", { status: 401 });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runtime.getState()).toMatchObject({
      status: "unauthenticated",
      hostId: null,
      lastError:
        "Desktop host could not authenticate with the API session. Sign in and retry.",
      errorLog: [
        {
          source: "command_poll",
          hostId: null,
          message:
            "Desktop host could not authenticate with the API session. Sign in and retry.",
          status: "error",
        },
      ],
    });

    const requestCount = hostFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hostFetch).toHaveBeenCalledTimes(requestCount);
  });

  it("deactivates for restart when command completion rejects the host token", async () => {
    vi.useFakeTimers();
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        return jsonResponse({
          status: "command",
          command: {
            timeoutMs: 60_000,
            createdAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            id: "cmd-1",
            kind: "app.state",
            payload: { app: "Safari" },
          },
        });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        return new Response("{}", { status: 401 });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runtime.getState()).toMatchObject({
      status: "unauthenticated",
      hostId: null,
      lastCommandAt: null,
      lastError:
        "Desktop host could not authenticate with the API session. Sign in and retry.",
      errorLog: [
        {
          source: "command_poll",
          hostId: null,
          message:
            "Desktop host could not authenticate with the API session. Sign in and retry.",
          status: "error",
        },
      ],
    });
  });

  it("records local native command payloads and results", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T08:00:00.000Z"));
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        return jsonResponse({
          status: "claimed",
          command: {
            timeoutMs: 60_000,
            createdAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            id: "cmd-1",
            kind: "app.state",
            payload: { app: "Things" },
          },
        });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ status: "idle" });
    });
    const executeCommand = vi.fn<
      (
        command: ComputerUseCommand,
        permissions: ComputerUsePermissionState,
      ) => Promise<ComputerUseCommandExecutionResult>
    >(async () => {
      return {
        status: "succeeded",
        result: {
          appState: "0 standard window Inbox",
          elements: [{ id: "element-1", role: "AXWindow" }],
          screenshot: "data:image/png;base64,abc123",
          screenshotWidth: 800,
          screenshotHeight: 600,
          screenshotSourceName: "Inbox",
          visibleElements: [
            {
              elementId: "element-1",
              text: "Inbox",
              source: "accessibility",
              sourceAttributes: ["AXTitle"],
            },
          ],
        },
      };
    });
    const { runtime } = createRuntime({ hostFetch, executeCommand });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const [entry] = runtime.getState().localCommandLog;
    expect(entry).toMatchObject({
      commandId: "cmd-1",
      kind: "app.state",
      app: "Things",
      status: "succeeded",
      payload: { app: "Things" },
      result: {
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotSourceName: "Inbox",
        omittedResultFields: [
          "appState",
          "elements",
          "screenshot",
          "visibleElements",
        ],
      },
      error: null,
      durationMs: 0,
    });
    expect(executeCommand).toHaveBeenCalledWith(
      {
        timeoutMs: 60_000,
        createdAt: expect.any(String),
        claimedAt: expect.any(String),
        id: "cmd-1",
        kind: "app.state",
        payload: { app: "Things" },
      },
      { accessibility: true, screenRecording: false },
    );
    const completionCall = hostFetch.mock.calls.find(([url]) => {
      return url.endsWith("/api/computer-use/host/commands/cmd-1/complete");
    });
    if (!completionCall) {
      throw new Error("Expected Computer Use command completion request");
    }
    expect(JSON.parse(String(completionCall[1]?.body))).toMatchObject({
      status: "succeeded",
      result: {
        appState: "0 standard window Inbox",
        elements: [{ id: "element-1", role: "AXWindow" }],
        screenshot: "data:image/png;base64,abc123",
        visibleElements: [
          {
            elementId: "element-1",
            text: "Inbox",
            source: "accessibility",
            sourceAttributes: ["AXTitle"],
          },
        ],
      },
    });

    await runtime.stop();
  });

  it("limits the local native command log to recent entries", async () => {
    vi.useFakeTimers();
    let nextCommandId = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        if (nextCommandId === 25) {
          return jsonResponse({ status: "idle" });
        }
        nextCommandId++;
        return jsonResponse({
          status: "command",
          command: {
            timeoutMs: 60_000,
            createdAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            id: `cmd-${nextCommandId.toString()}`,
            kind: "keyboard.press_key",
            payload: { app: "Terminal", key: "Enter" },
          },
        });
      }
      if (url.includes("/api/computer-use/host/commands/cmd-")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);
    for (let index = 0; index < 25; index++) {
      await vi.advanceTimersToNextTimerAsync();
    }

    const entries = runtime.getState().localCommandLog;
    expect(entries).toHaveLength(20);
    expect(entries[0]?.commandId).toBe("cmd-25");
    expect(entries.at(-1)?.commandId).toBe("cmd-6");

    await runtime.stop();
  });

  it("notifies command failures without moving the runtime offline", async () => {
    vi.useFakeTimers();
    const command: ComputerUseCommand = {
      timeoutMs: 60_000,
      createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      id: "cmd-1",
      kind: "element.set_value",
      payload: { app: "com.google.Chrome", value: "https://example.com" },
    };
    const failure: ComputerUseCommandFailure = {
      status: "failed",
      error: {
        code: "automation_permission_denied",
        message:
          "Not authorized to send Apple events to Google Chrome. (-1743)",
      },
    };
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ status: "command", command })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const executeCommand = vi.fn<
      (
        command: ComputerUseCommand,
        permissions: ComputerUsePermissionState,
      ) => Promise<ComputerUseCommandExecutionResult>
    >(async () => failure);
    const onCommandFailure =
      vi.fn<
        (args: {
          readonly command: ComputerUseCommand;
          readonly failure: ComputerUseCommandFailure;
        }) => void
      >();
    const { runtime } = createRuntime({
      hostFetch,
      executeCommand,
      onCommandFailure,
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onCommandFailure).toHaveBeenCalledWith({ command, failure });
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
    });
    expect(runtime.getState().localCommandLog[0]).toMatchObject({
      commandId: "cmd-1",
      status: "failed",
      error: failure.error,
    });

    await runtime.stop();
  });

  it("keeps heartbeats running while a command is executing", async () => {
    vi.useFakeTimers();
    const command: ComputerUseCommand = {
      timeoutMs: 60_000,
      createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      id: "cmd-1",
      kind: "keyboard.type_text",
      payload: { app: "Chrome", text: "https://mail.google.com/" },
    };
    const execution = deferred<ComputerUseCommandExecutionResult>();
    let nextCalls = 0;
    let completeCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({ status: "command", command })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        completeCalls++;
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const executeCommand = vi.fn<
      (
        command: ComputerUseCommand,
        permissions: ComputerUsePermissionState,
      ) => Promise<ComputerUseCommandExecutionResult>
    >(async () => {
      return await execution.promise;
    });
    const { runtime } = createRuntime({ hostFetch, executeCommand });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(executeCommand).toHaveBeenCalledOnce();
    expect(completeCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);

    const heartbeatCalls = hostFetch.mock.calls.filter(([url]) => {
      return url.endsWith("/api/computer-use/heartbeat");
    });
    expect(heartbeatCalls.length).toBeGreaterThan(1);
    expect(completeCalls).toBe(0);

    execution.resolve({ status: "succeeded", result: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(completeCalls).toBe(1);

    await runtime.stop();
  });

  it("drains an active command before stopping without claiming more work", async () => {
    vi.useFakeTimers();
    const command: ComputerUseCommand = {
      timeoutMs: 60_000,
      createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      id: "cmd-1",
      kind: "keyboard.type_text",
      payload: { app: "Chrome", text: "okou" },
    };
    const execution = deferred<ComputerUseCommandExecutionResult>();
    const events: string[] = [];
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls += 1;
        events.push("claim");
        return jsonResponse({ status: "command", command });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        events.push("complete");
        return jsonResponse({ ok: true });
      }
      if (url.endsWith("/api/computer-use/host/stop")) {
        events.push("stop");
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const executeCommand = vi.fn(async () => {
      events.push("execute");
      const result = await execution.promise;
      events.push("executed");
      return result;
    });
    const { runtime } = createRuntime({ hostFetch, executeCommand });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(executeCommand).toHaveBeenCalledOnce();

    const drain = runtime.drainAndStop();
    await vi.advanceTimersByTimeAsync(500);
    expect(events).not.toContain("stop");

    execution.resolve({ status: "succeeded", result: {} });
    await vi.advanceTimersByTimeAsync(100);
    await drain;

    expect(nextCalls).toBe(1);
    expect(events).toEqual([
      "claim",
      "execute",
      "executed",
      "complete",
      "stop",
    ]);
    expect(runtime.getState().status).toBe("offline");
  });

  it("retries transient command completion failures", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    let completeCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({
              status: "command",
              command: {
                timeoutMs: 60_000,
                createdAt: new Date().toISOString(),
                claimedAt: new Date().toISOString(),
                id: "cmd-1",
                kind: "app.state",
                payload: { app: "Chrome" },
              },
            })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        completeCalls++;
        return completeCalls === 1
          ? new Response("{}", { status: 503 })
          : jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(completeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(completeCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
    });

    await runtime.stop();
  });

  it("polls immediately when command completion is already terminal on the server", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    let completeCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({
              status: "command",
              command: {
                timeoutMs: 60_000,
                createdAt: new Date().toISOString(),
                claimedAt: new Date().toISOString(),
                id: "cmd-1",
                kind: "app.state",
                payload: { app: "Chrome" },
              },
            })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        completeCalls++;
        return new Response("{}", { status: 409 });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersToNextTimerAsync();

    expect(completeCalls).toBe(1);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
      recovery: null,
    });
    expect(runtime.getState().lastCommandAt).toEqual(expect.any(String));

    expect(nextCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
    });

    await runtime.stop();
  });

  it("moves through burst and active polling before returning to cold", async () => {
    vi.useFakeTimers();
    const startedAtMs = Date.parse("2026-06-10T10:00:00.000Z");
    vi.setSystemTime(startedAtMs);
    const claimOffsets: number[] = [];
    let firstCommandClaimed = false;
    let secondCommandClaimed = false;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        const offset = Date.now() - startedAtMs;
        claimOffsets.push(offset);
        if (offset === 5_000 && !firstCommandClaimed) {
          firstCommandClaimed = true;
          return jsonResponse({
            status: "command",
            command: {
              timeoutMs: 60_000,
              createdAt: new Date().toISOString(),
              claimedAt: new Date().toISOString(),
              id: "cmd-1",
              kind: "app.state",
              payload: { app: "Chrome" },
            },
          });
        }
        if (offset === 16_001 && !secondCommandClaimed) {
          secondCommandClaimed = true;
          return jsonResponse({
            status: "command",
            command: {
              timeoutMs: 60_000,
              createdAt: new Date().toISOString(),
              claimedAt: new Date().toISOString(),
              id: "cmd-2",
              kind: "app.state",
              payload: { app: "Chrome" },
            },
          });
        }
        return jsonResponse({ status: "idle" });
      }
      if (url.includes("/api/computer-use/host/commands/cmd-")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(claimOffsets).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(claimOffsets).toEqual([5_000, 5_001]);

    await vi.advanceTimersByTimeAsync(499);
    expect(claimOffsets.at(-1)).toBe(5_001);

    await vi.advanceTimersByTimeAsync(1);
    expect(claimOffsets.at(-1)).toBe(5_501);

    await vi.advanceTimersByTimeAsync(9_500);
    expect(claimOffsets.at(-1)).toBe(15_001);
    const burstCallCount = claimOffsets.length;

    await vi.advanceTimersByTimeAsync(999);
    expect(claimOffsets).toHaveLength(burstCallCount);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(claimOffsets.slice(-2)).toEqual([16_001, 16_002]);

    await vi.advanceTimersByTimeAsync(500);
    expect(claimOffsets.at(-1)).toBe(16_502);

    await vi.advanceTimersByTimeAsync(9_500);
    expect(claimOffsets.at(-1)).toBe(26_002);
    const resetBurstCallCount = claimOffsets.length;

    await vi.advanceTimersByTimeAsync(999);
    expect(claimOffsets).toHaveLength(resetBurstCallCount);

    await vi.advanceTimersByTimeAsync(1);
    expect(claimOffsets.at(-1)).toBe(27_002);

    await vi.advanceTimersByTimeAsync(49_000);
    expect(claimOffsets.at(-1)).toBe(76_002);
    const activeCallCount = claimOffsets.length;

    await vi.advanceTimersByTimeAsync(4_999);
    expect(claimOffsets).toHaveLength(activeCallCount);

    await vi.advanceTimersByTimeAsync(1);
    expect(claimOffsets.at(-1)).toBe(81_002);

    await runtime.stop();
  });

  it("bounds hung command reporting without renewing the execution grant", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    let completeCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url, init) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? jsonResponse({
              status: "command",
              command: {
                timeoutMs: 120_000,
                createdAt: new Date().toISOString(),
                claimedAt: new Date().toISOString(),
                id: "cmd-1",
                kind: "app.state",
                payload: { app: "Chrome" },
              },
            })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        completeCalls++;
        return completeCalls === 1
          ? await hungResponseUntilAbort(init)
          : jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(completeCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(completeCalls).toBe(1);
    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Computer Use command reporting timed out after 5000ms",
    });
    expect(runtime.getState().lastCommandAt).toBeNull();

    await runtime.stop();
  });

  it("retries transient start failures with recovery state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    let startCalls = 0;
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      startCalls++;
      return startCalls === 1
        ? new Response("{}", { status: 503 })
        : jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();

    expect(startCalls).toBe(1);
    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Failed to start Computer Use host: 503",
      recovery: {
        phase: "start",
        attempt: 1,
        retryDelayMs: 2_000,
        nextRetryAt: "2026-06-10T10:00:02.000Z",
      },
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(startCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(startCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      hostId: "host-1",
      lastError: null,
      recovery: null,
    });

    await runtime.stop();
  });

  it("recovers heartbeat failures before polling for more commands", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    let heartbeatCalls = 0;
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        heartbeatCalls++;
        return heartbeatCalls === 1
          ? new Response("{}", { status: 503 })
          : jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return jsonResponse({ status: "idle" });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(heartbeatCalls).toBe(1);
    expect(nextCalls).toBe(0);
    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Computer Use heartbeat failed: 503",
      recovery: {
        phase: "heartbeat",
        attempt: 1,
        retryDelayMs: 2_000,
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);

    expect(heartbeatCalls).toBe(2);
    expect(nextCalls).toBe(1);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
      recovery: null,
    });

    await runtime.stop();
  });

  it("recovers hung heartbeat requests with a request timeout", async () => {
    vi.useFakeTimers();
    let heartbeatCalls = 0;
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url, init) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        heartbeatCalls++;
        if (heartbeatCalls === 1) {
          return await hungResponseUntilAbort(init);
        }
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return jsonResponse({ status: "idle" });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(heartbeatCalls).toBe(1);
    expect(nextCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Computer Use heartbeat timed out after 10000ms",
      recovery: {
        phase: "heartbeat",
        attempt: 1,
        retryDelayMs: 2_000,
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);

    expect(heartbeatCalls).toBe(2);
    expect(nextCalls).toBeGreaterThan(1);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
      recovery: null,
    });

    await runtime.stop();
  });

  it("backs off hung command claim requests with a request timeout", async () => {
    vi.useFakeTimers();
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url, init) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? await hungResponseUntilAbort(init)
          : jsonResponse({ status: "idle" });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(nextCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Computer Use command poll timed out after 30000ms",
      recovery: {
        phase: "command_poll",
        attempt: 1,
        retryDelayMs: 2_000,
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(nextCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
      recovery: null,
    });

    await runtime.stop();
  });

  it("uses recovery backoff instead of burst cadence after a claim failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        if (nextCalls === 1) {
          return jsonResponse({
            status: "command",
            command: {
              timeoutMs: 60_000,
              createdAt: new Date().toISOString(),
              claimedAt: new Date().toISOString(),
              id: "cmd-1",
              kind: "app.state",
              payload: { app: "Chrome" },
            },
          });
        }
        return nextCalls === 2
          ? new Response("{}", { status: 500 })
          : jsonResponse({ status: "idle" });
      }
      if (url.endsWith("/api/computer-use/host/commands/cmd-1/complete")) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersToNextTimerAsync();

    expect(nextCalls).toBe(2);
    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      lastError: "Computer Use command claim failed: 500",
      recovery: {
        phase: "command_poll",
        attempt: 1,
        retryDelayMs: 2_000,
      },
    });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(nextCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(nextCalls).toBe(3);
    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
      recovery: null,
    });

    await runtime.stop();
  });

  it("honors Retry-After when command claim is rate limited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T10:00:00.000Z"));
    let nextCalls = 0;
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        nextCalls++;
        return nextCalls === 1
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "7" },
            })
          : jsonResponse({ status: "idle" });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runtime.getState()).toMatchObject({
      status: "recovering",
      recovery: {
        phase: "command_poll",
        attempt: 1,
        retryDelayMs: 7_000,
        nextRetryAt: "2026-06-10T10:00:12.000Z",
      },
    });

    await vi.advanceTimersByTimeAsync(6_999);
    expect(nextCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(nextCalls).toBe(2);

    await runtime.stop();
  });

  it("does not fetch audit history while refreshing heartbeats", async () => {
    vi.useFakeTimers();
    let heartbeatCalls = 0;
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.includes("/api/computer-use/audit-events")) {
        throw new Error("Heartbeat must not depend on audit history refresh");
      }
      return jsonResponse({ hostId: "host-1", hostToken: "token-1" });
    });
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        heartbeatCalls++;
        return jsonResponse({ ok: true, hostId: "host-1" });
      }
      if (url.endsWith("/api/computer-use/host/commands/next")) {
        return jsonResponse({ status: "idle" });
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ sessionFetch, hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runtime.getState()).toMatchObject({
      status: "online",
      lastError: null,
      recovery: null,
      errorLog: [],
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(heartbeatCalls).toBe(2);
    expect(
      sessionFetch.mock.calls.some(([url]) => {
        return url.includes("/api/computer-use/audit-events");
      }),
    ).toBe(false);

    await runtime.stop();
  });

  it("stops the registered host through the host API", async () => {
    vi.useFakeTimers();
    const hostFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse({ ok: true, hostId: "host-1" });
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await runtime.stop();

    const stopCall = hostFetch.mock.calls.find(([url]) => {
      return url.endsWith("/api/computer-use/host/stop");
    });
    if (!stopCall) {
      throw new Error("Expected Computer Use host stop request");
    }
    const headers = new Headers(stopCall[1]?.headers);
    expect(stopCall[1]?.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer token-1");
    expect(runtime.getState()).toMatchObject({
      status: "offline",
      hostId: null,
      lastError: null,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(hostFetch).toHaveBeenCalledOnce();
  });

  it("reports heartbeat active host conflicts without retrying", async () => {
    vi.useFakeTimers();
    const hostFetch = vi.fn<ComputerUseHostFetch>(async (url) => {
      if (url.endsWith("/api/computer-use/heartbeat")) {
        return jsonResponse(
          {
            error: { message: "A Desktop Computer Use host is already active" },
          },
          { status: 409 },
        );
      }
      throw new Error(`Unexpected host request: ${url}`);
    });
    const { runtime } = createRuntime({ hostFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(hostFetch).toHaveBeenCalledOnce();
    expect(hostFetch.mock.calls[0]?.[0]).toBe(
      "https://api.okou.ai/api/computer-use/heartbeat",
    );
    expect(runtime.getState()).toMatchObject({
      status: "error",
      hostId: null,
      lastError: "Computer Use is already active in another Desktop session.",
      errorLog: [
        {
          source: "heartbeat",
          hostId: null,
          message: "Computer Use is already active in another Desktop session.",
          status: "error",
        },
      ],
    });
  });

  it("stops after a 401 registration response so retry stays manual", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return new Response("{}", { status: 401 });
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionFetch).toHaveBeenCalledTimes(2);
    expect(sessionFetch.mock.calls[0]?.[0]).toBe(
      "https://api.okou.ai/api/computer-use/hosts/start",
    );
    expect(sessionFetch.mock.calls[1]?.[0]).toBe(
      "https://api.okou.ai/api/auth/me",
    );
    expect(runtime.getState()).toMatchObject({
      status: "unauthenticated",
      hostId: null,
      lastError:
        "Desktop host could not authenticate with the API session. Sign in and retry.",
    });
  });

  it("reports missing organization when the Electron session is signed in", async () => {
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async (input) => {
      if (input.endsWith("/api/auth/me")) {
        return jsonResponse({ userId: "user-1", email: "user@example.com" });
      }
      return new Response("{}", { status: 401 });
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();

    expect(runtime.getState()).toMatchObject({
      status: "needs_organization",
      hostId: null,
      lastError:
        "Desktop is signed in but no workspace is active. Select a workspace and retry.",
    });
  });

  it("reports an active host conflict without retrying registration", async () => {
    vi.useFakeTimers();
    const sessionFetch = vi.fn<ComputerUseHostFetch>(async () => {
      return jsonResponse(
        { error: { message: "A Desktop Computer Use host is already active" } },
        { status: 409 },
      );
    });
    const { runtime } = createRuntime({ sessionFetch });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionFetch).toHaveBeenCalledOnce();
    expect(runtime.getState()).toMatchObject({
      status: "error",
      hostId: null,
      lastError: "Computer Use is already active in another Desktop session.",
      errorLog: [
        {
          source: "start",
          hostId: null,
          message: "Computer Use is already active in another Desktop session.",
          status: "error",
        },
      ],
    });
  });
});

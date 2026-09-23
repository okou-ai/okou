import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import { browserCommand } from "../index";

const spawnSyncMock = vi.hoisted(() => {
  return vi.fn();
});
vi.mock("node:child_process", () => {
  return { spawnSync: spawnSyncMock };
});

const THREAD_ID = "c0000000-0000-4000-a000-000000000010";
const CDP_URL = "wss://connect.browser-use.com/?token=secret-cdp-token";

function browser(status: "active" | "suspended" = "active") {
  return {
    threadId: THREAD_ID,
    name: "booking",
    status,
    viewerUrl: `https://app.okou.ai/browsers/${THREAD_ID}`,
    liveUrl:
      status === "active"
        ? "https://live.browser-use.com/?wss=secret-live-token"
        : null,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    idleExpiresAt: status === "active" ? "2026-07-24T10:10:00.000Z" : null,
    suspendedAt: status === "suspended" ? "2026-07-24T10:05:00.000Z" : null,
    suspensionReason: status === "suspended" ? ("idle" as const) : null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
  } as const;
}

describe("okou browser command", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const processExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    spawnSyncMock.mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    consoleLog.mockClear();
    consoleError.mockClear();
    processExit.mockClear();
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    processExit.mockRestore();
  });

  it("exposes only thread-keyed lifecycle commands", () => {
    expect(
      browserCommand.commands.map((command) => {
        return command.name();
      }),
    ).toStrictEqual(["use", "lease", "new", "status", "view", "input-request"]);
  });

  it("creates a fresh browser and passes its CDP URL directly to agent-browser", async () => {
    let requestBody: unknown;
    let authorization: string | null = null;
    server.use(
      http.post("http://localhost:3000/api/browsers", async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json(
          { browser: browser(), cdpUrl: CDP_URL, lifecycleEventId: null },
          { status: 201 },
        );
      }),
    );

    await browserCommand.parseAsync([
      "node",
      "cli",
      "new",
      "--name",
      "booking",
    ]);

    expect(requestBody).toStrictEqual({
      name: "booking",
      proxyCountryCode: null,
    });
    expect(authorization).toBe("Bearer test-token");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "okou-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(
      `[Open live browser](https://app.okou.ai/browsers/${THREAD_ID})`,
    );
    expect(output).not.toContain(CDP_URL);
  });

  it("opens the thread browser, reports its reclaim time, and hides connection secrets", async () => {
    let useRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/browsers/use", () => {
        useRequests += 1;
        return HttpResponse.json(
          {
            browser: browser("active"),
            cdpUrl: CDP_URL,
            lifecycleEventId: null,
          },
          { status: 200 },
        );
      }),
    );

    await browserCommand.parseAsync(["node", "cli", "use"]);

    expect(useRequests).toBe(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "okou-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("2026-07-24T10:10:00.000Z");
    expect(output).not.toContain(CDP_URL);
  });

  it("extends the lease by a fixed window and reports the new reclaim time", async () => {
    let leaseRequests = 0;
    let leaseBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/browsers/lease",
        async ({ request }) => {
          leaseRequests += 1;
          leaseBody = await request.json();
          return HttpResponse.json(
            { browser: browser("active") },
            { status: 200 },
          );
        },
      ),
    );

    await browserCommand.parseAsync(["node", "cli", "lease"]);

    expect(leaseRequests).toBe(1);
    // The lease is not parameterizable: every call buys the same fixed window.
    expect(leaseBody).toStrictEqual({});
    expect(spawnSyncMock).not.toHaveBeenCalled();
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("2026-07-24T10:10:00.000Z");
  });

  it("keeps provider connection URLs out of JSON output", async () => {
    server.use(
      http.post("http://localhost:3000/api/browsers", () => {
        return HttpResponse.json(
          { browser: browser(), cdpUrl: CDP_URL, lifecycleEventId: null },
          { status: 201 },
        );
      }),
    );

    await browserCommand.parseAsync([
      "node",
      "cli",
      "new",
      "--name",
      "booking",
      "--json",
    ]);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "okou-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).not.toContain("secret-cdp-token");
    expect(output).not.toContain("secret-live-token");
    const parsedOutput = JSON.parse(output) as {
      readonly agentBrowserSession: string;
      readonly browser: Readonly<Record<string, unknown>>;
    };
    expect(parsedOutput).toMatchObject({
      browser: {
        threadId: THREAD_ID,
        viewerUrl: `https://app.okou.ai/browsers/${THREAD_ID}`,
      },
      agentBrowserSession: "okou-browser",
    });
  });

  it("documents the agent-browser session it actually attaches", async () => {
    server.use(
      http.post("http://localhost:3000/api/browsers/use", () => {
        return HttpResponse.json(
          {
            browser: browser("active"),
            cdpUrl: CDP_URL,
            lifecycleEventId: null,
          },
          { status: 200 },
        );
      }),
    );

    await browserCommand.parseAsync(["node", "cli", "use", "--json"]);

    const { agentBrowserSession } = JSON.parse(
      consoleLog.mock.calls.flat().join("\n"),
    ) as { readonly agentBrowserSession: string };
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", agentBrowserSession, "connect", CDP_URL],
      { stdio: "ignore" },
    );

    // The help text is an instruction agents copy verbatim: a session name that
    // drifts from the attached one hands them a browser that was never connected.
    let help = "";
    browserCommand.configureOutput({
      writeOut: (text: string) => {
        help += text;
      },
    });
    browserCommand.outputHelp();
    browserCommand.configureOutput({
      writeOut: (text: string) => {
        process.stdout.write(text);
      },
    });

    expect(help).toContain(
      `agent-browser --session ${agentBrowserSession} open`,
    );
  });

  it("attaches to an explicitly named agent-browser session", async () => {
    server.use(
      http.post("http://localhost:3000/api/browsers/use", () => {
        return HttpResponse.json(
          {
            browser: browser("active"),
            cdpUrl: CDP_URL,
            lifecycleEventId: null,
          },
          { status: 200 },
        );
      }),
    );

    await browserCommand.parseAsync([
      "node",
      "cli",
      "use",
      "--agent-session",
      "booking-browser",
    ]);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "booking-browser", "connect", CDP_URL],
      { stdio: "ignore" },
    );
  });
});

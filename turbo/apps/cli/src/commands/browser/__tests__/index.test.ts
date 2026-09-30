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
    ).toStrictEqual([
      "use",
      "lease",
      "new",
      "status",
      "view",
      "tab",
      "input-request",
    ]);
  });

  it("guides agents to native credential input before last-resort takeover", () => {
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

    expect(help).toContain("okou browser tab list");
    expect(help).toContain("okou browser tab select t2");
    expect(help).toContain('"fieldKind":"password"');
    expect(help).toContain('"fieldKind":"one_time_code"');
    expect(help).toContain(
      "prefer input-request for user-held values in supported exact controls",
    );
    expect(help).toContain(
      "Direct Browser takeover is a last resort for unsupported or unavailable input",
    );
    expect(help.indexOf("Request login credentials:")).toBeLessThan(
      help.indexOf("View browser / takeover:"),
    );
    expect(help.indexOf("View browser / takeover:")).toBeLessThan(
      help.indexOf("Direct Browser takeover is a last resort"),
    );
    expect(help).toContain(
      "An explicit user request to view the Browser is not a takeover",
    );
  });

  it("prints the existing Browser viewer URL for a user takeover", async () => {
    server.use(
      http.get("http://localhost:3000/api/browsers/current", () => {
        return HttpResponse.json({ browser: browser() }, { status: 200 });
      }),
    );

    await browserCommand.parseAsync(["node", "cli", "view"]);

    expect(consoleLog.mock.calls.flat()).toStrictEqual([
      `https://app.okou.ai/browsers/${THREAD_ID}`,
    ]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("creates a fresh browser and passes its CDP URL directly to agent-browser", async () => {
    let requestBody: unknown;
    let authorization: string | null = null;
    server.use(
      http.post("http://localhost:3000/api/browsers", async ({ request }) => {
        requestBody = await request.json();
        authorization = request.headers.get("authorization");
        return HttpResponse.json(
          { browser: browser(), cdpUrl: CDP_URL },
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
          { browser: browser(), cdpUrl: CDP_URL },
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

  it("lists only current-session IDs, selection and redacted origins", async () => {
    const secret = "private-oauth-code";
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: true,
        data: {
          tabs: [
            {
              tabId: "t1",
              url: `https://user:password@accounts.example.test/login?code=${secret}#fragment`,
              title: `title-${secret}`,
              label: `label-${secret}`,
              active: false,
            },
            {
              tabId: "t2",
              url: "about:blank",
              title: `title-${secret}`,
              active: true,
            },
          ],
        },
      }),
      stderr: secret,
    });

    await browserCommand.parseAsync(["node", "cli", "tab", "list", "--json"]);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--session", "okou-browser", "tab", "list", "--json"],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toStrictEqual({
      tabs: [
        { id: "t1", origin: "https://accounts.example.test", active: false },
        { id: "t2", origin: "non-web", active: true },
      ],
    });
    expect(output).not.toContain(secret);
    expect(output).not.toContain("user:password");
    expect(consoleError.mock.calls.flat().join("\n")).toBe("");
  });

  it("does not guess which of two same-origin tabs is the input page", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        success: true,
        data: {
          tabs: [
            {
              tabId: "t1",
              url: "https://login.example.test/one",
              active: true,
            },
            {
              tabId: "t2",
              url: "https://login.example.test/two",
              active: false,
            },
          ],
        },
      }),
    });

    await browserCommand.parseAsync(["node", "cli", "tab", "list"]);

    expect(consoleLog.mock.calls.flat()).toStrictEqual([
      "t1 (selected) https://login.example.test",
      "t2 https://login.example.test",
    ]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("selects an explicit tab and verifies it without printing raw switch output", async () => {
    const secret = "private-oauth-code";
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout: `✓ Secret ?code=${secret}`,
        stderr: secret,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          success: true,
          data: {
            tabs: [
              {
                tabId: "t1",
                url: "https://other.example.test/",
                active: false,
              },
              {
                tabId: "t2",
                url: `https://accounts.example.test/login?code=${secret}`,
                title: secret,
                active: true,
              },
            ],
          },
        }),
      });

    await browserCommand.parseAsync([
      "node",
      "cli",
      "tab",
      "select",
      "t2",
      "--agent-session",
      "booking-browser",
      "--json",
    ]);

    expect(
      spawnSyncMock.mock.calls.map((call) => {
        return call[1];
      }),
    ).toStrictEqual([
      ["--session", "booking-browser", "tab", "t2"],
      ["--session", "booking-browser", "tab", "list", "--json"],
    ]);
    const output = consoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toStrictEqual({
      tab: { id: "t2", origin: "https://accounts.example.test", active: true },
    });
    expect(output).not.toContain(secret);
  });

  it("does not echo invalid tab IDs or session names in command errors", async () => {
    const secret = "synthetic-private-param";
    const invalidArguments = [
      ["tab", "select", `https://accounts.example.test/?code=${secret}`],
      ["tab", "list", "--agent-session", `${secret}@`],
      ["tab", "select", "t1", "--agent-session", `${secret}@`],
    ];
    for (const args of invalidArguments) {
      consoleError.mockClear();
      await expect(
        browserCommand.parseAsync(["node", "cli", ...args]),
      ).rejects.toThrow("process.exit called");
      expect(consoleError.mock.calls.flat().join("\n")).not.toContain(secret);
      expect(consoleLog.mock.calls.flat()).toStrictEqual([]);
      expect(spawnSyncMock).not.toHaveBeenCalled();
    }
  });

  it("fails closed without revealing malformed tab output or switch errors", async () => {
    const secret = "private-oauth-code";
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: `not JSON ${secret}`,
    });
    await expect(
      browserCommand.parseAsync(["node", "cli", "tab", "list"]),
    ).rejects.toThrow("process.exit called");
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(secret);
    expect(consoleLog.mock.calls.flat()).toStrictEqual([]);

    consoleError.mockClear();
    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: secret,
      stderr: secret,
    });
    await expect(
      browserCommand.parseAsync(["node", "cli", "tab", "select", "t1"]),
    ).rejects.toThrow("process.exit called");
    expect(consoleError.mock.calls.flat().join("\n")).not.toContain(secret);
    expect(consoleLog.mock.calls.flat()).toStrictEqual([]);
  });

  it("does not claim selection when the post-switch tab is not active", async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "selected" })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          success: true,
          data: {
            tabs: [{ tabId: "t1", url: "https://example.test", active: false }],
          },
        }),
      });
    await expect(
      browserCommand.parseAsync(["node", "cli", "tab", "select", "t1"]),
    ).rejects.toThrow("process.exit called");
    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      "Browser tab selection could not be verified",
    );
  });
});

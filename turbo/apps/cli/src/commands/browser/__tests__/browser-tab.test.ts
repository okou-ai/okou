import type { ChildProcess, SpawnOptions } from "node:child_process";
import { once } from "node:events";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { browserCommand } from "../index";

const external = vi.hoisted(() => {
  return {
    configs: [] as unknown[],
    children: [] as { child: ChildProcess; closed: Promise<unknown> }[],
    driver: vi.fn(),
    mode: "normal",
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: external.driver,
    spawn(file: string, args: string[], options: SpawnOptions) {
      expect(file).toBe("/usr/local/bin/guest-task-exec");
      const startup = args[0] !== "stop";
      if (startup) expect(args.at(-1)).toBe("__browser-proxy");
      const program = startup
        ? `
        const fs = require("node:fs");
        fs.writeSync(3, JSON.stringify({handle:"11111111-1111-4111-8111-111111111111",pid:process.pid})+"\\n"); fs.closeSync(3);
        process.on("message", () => process.send(${external.mode === "startup-failure" ? '{error:"private-provider-details"}' : '{endpoint:"ws://127.0.0.1:45678/devtools/browser"}'}));
        process.once("disconnect", () => process.exit(0));
        process.send({ready:true});
      `
        : "process.exit(0)";
      const child = original.spawn(process.execPath, ["-e", program], options);
      const closed = once(child, "exit");
      external.children.push({ child, closed });
      if (startup) {
        const send = child.send.bind(child);
        vi.spyOn(child, "send").mockImplementation((message) => {
          external.configs.push(message);
          return send(message);
        });
      }
      return child;
    },
  };
});

const THREAD = "c0000000-0000-4000-a000-000000000010";
const PROVIDER = "wss://browser-window.test/?token=private-provider";
const SESSION = "chat-window-test";
const extension = {
  id: "11111111-1111-4111-8111-111111111111",
  runtimeId: "abcdefghijklmnopabcdefghijklmnop",
  version: "0.5.1",
};

describe("Browser proxy attachment and safe tabs", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  let metadata: boolean;
  let selected: string;
  let tabs: { tabId: string; targetId: string; url: string }[];
  const output = () => {
    return log.mock.calls.flat().join("\n");
  };
  const result = (data: unknown) => {
    return {
      status: 0,
      stdout: JSON.stringify({ success: true, data }),
      stderr: "",
    };
  };
  const run = (...args: string[]) => {
    return browserCommand.parseAsync([
      "node",
      "okou",
      ...args,
      "--agent-session",
      SESSION,
      "--json",
    ]);
  };

  beforeEach(() => {
    metadata = true;
    selected = "AAAA";
    tabs = [
      {
        tabId: "t1",
        targetId: "AAAA",
        url: "https://user:password@example.test/inbox?token=private-oauth#fragment",
      },
      {
        tabId: "t2",
        targetId: "BBBB",
        url: "https://example.test/another?private-value=yes",
      },
    ];
    external.mode = "normal";
    external.configs.length = 0;
    external.driver.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("connect")) return result({});
      const at = args.indexOf("tab");
      if (args[at + 1] !== "list")
        selected =
          tabs.find((tab) => {
            return tab.tabId === args[at + 1];
          })?.targetId ?? selected;
      return result({
        tabs: tabs.map((tab) => {
          return {
            ...tab,
            active: tab.targetId === selected,
            title: "private-title",
          };
        }),
      });
    });
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD);
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    server.use(
      http.post("http://localhost:3000/api/browsers/use", () => {
        return HttpResponse.json({
          browser: {
            threadId: THREAD,
            name: "browser",
            status: "active",
            viewerUrl: "https://app.okou.ai/browsers/" + THREAD,
            liveUrl: "https://private-live.test/?token=private",
            screenshotUrl: null,
            timeoutMinutes: 240,
            idleExpiresAt: "2026-11-02T10:10:00.000Z",
            suspendedAt: null,
            suspensionReason: null,
            createdAt: "2026-11-02T10:00:00.000Z",
            updatedAt: "2026-11-02T10:00:00.000Z",
            window: {
              instanceId: "d0000000-0000-4000-a000-000000000010",
              primaryWindowId: 0,
            },
          },
          cdpUrl: PROVIDER,
          ...(metadata ? { extension } : {}),
        });
      }),
    );
  });

  afterEach(async () => {
    for (const { child, closed } of external.children.splice(0)) {
      child.ref();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
    }
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    external.driver.mockReset();
    vi.unstubAllEnvs();
  });

  it("attaches the driver through a managed proxy and keeps connection details private", async () => {
    await run("use");
    expect(external.configs).toStrictEqual([
      { cdpUrl: PROVIDER, runtimeId: extension.runtimeId, windowId: 0 },
    ]);
    expect(external.driver).toHaveBeenCalledWith(
      "agent-browser",
      [
        "--session",
        SESSION,
        "--no-pin-tab",
        "connect",
        "ws://127.0.0.1:45678/devtools/browser",
      ],
      expect.anything(),
    );
    const printed: unknown = JSON.parse(output());
    expect(printed).toMatchObject({
      browser: { threadId: THREAD },
      agentBrowserSession: SESSION,
    });
    expect(output()).not.toContain("private");
    expect(output()).not.toContain("primaryWindowId");
    expect(external.driver).toHaveBeenCalledTimes(1);
  });

  it("rejects a connection without installed extension identity before starting a task", async () => {
    metadata = false;
    await expect(run("use")).rejects.toThrow("process.exit called");
    expect(external.driver).not.toHaveBeenCalled();
    expect(external.configs).toStrictEqual([]);
    const printedError = error.mock.calls.flat().join("\n");
    expect(printedError).toContain("extension");
    expect(printedError).not.toContain("private");
  });

  it("reports native startup failure without exposing private provider details", async () => {
    external.mode = "startup-failure";
    await expect(run("use")).rejects.toThrow("process.exit called");
    expect(external.driver).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).not.toContain("private");
  });

  it("stops its owned task when driver attachment fails", async () => {
    external.driver.mockReturnValue({
      status: 1,
      stdout: "private-output",
      stderr: "private-url",
    });
    await expect(run("use")).rejects.toThrow("process.exit called");
    expect(external.configs).toHaveLength(1);
    expect(external.driver).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join("\n")).not.toContain("private");
    expect(output()).toBe("");
  });

  it("acquires a fresh task on each explicit attachment", async () => {
    await run("use");
    await run("use");
    expect(external.configs).toHaveLength(2);
    expect(external.driver).toHaveBeenCalledTimes(2);
  });

  it("lists current scoped driver tabs using only safe origins", async () => {
    await run("tab", "list");
    expect(JSON.parse(output())).toStrictEqual({
      tabs: [
        { id: "t1", origin: "https://example.test", active: true },
        { id: "t2", origin: "https://example.test", active: false },
      ],
    });
    expect(output()).not.toMatch(/private|password|title|fragment/u);
  });

  it("selects and verifies a fresh driver tab without printing page details", async () => {
    await run("tab", "select", "t2");
    expect(selected).toBe("BBBB");
    expect(JSON.parse(output())).toStrictEqual({
      tab: { id: "t2", origin: "https://example.test", active: true },
    });
    expect(output()).not.toContain("private");
  });

  it("reports unknown tab selection without private driver output", async () => {
    external.driver.mockReturnValue({
      status: 1,
      stdout: "private-title",
      stderr: "private-error",
    });
    await expect(run("tab", "select", "t9")).rejects.toThrow(
      "process.exit called",
    );
    expect(error.mock.calls.flat().join("\n")).not.toContain("private");
    expect(output()).toBe("");
  });

  it("prints an empty current inventory", async () => {
    tabs = [];
    await run("tab", "list");
    expect(JSON.parse(output())).toStrictEqual({ tabs: [] });
  });
});

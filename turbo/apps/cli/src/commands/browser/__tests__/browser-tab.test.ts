import type {
  BrowserSession,
  BrowserWindowContext,
} from "@okouai/api-contracts/contracts/browser";
import { HttpResponse, http, ws } from "msw";
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
const INSTANCE_ID = "d0000000-0000-4000-a000-000000000010";
const SESSION = "chat-window-test";
const CDP_URL = "wss://browser-window.test/?token=private-connection-token";
const OWNER = "AAAA0000BBBB1111CCCC2222DDDD3333";
const OWNER_TWO = "BBBB0000BBBB1111CCCC2222DDDD3333";
const SIBLING = "CCCC0000BBBB1111CCCC2222DDDD3333";
const cdp = ws.link(CDP_URL);

interface DriverTab {
  readonly tabId: string;
  readonly targetId: string;
  readonly url: string;
}

describe("chat-window Browser commands", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  let window: BrowserWindowContext | undefined;
  let tabs: DriverTab[];
  let selected: string;
  let nativeWindows: Map<string, number>;
  let selections: string[];
  let protocolFailure: string | undefined;
  let lookupErrors: Map<string, string>;
  let replyWindow: ((targetId: string, reply: () => void) => void) | undefined;

  function browser(): BrowserSession {
    return {
      threadId: THREAD_ID,
      name: "browser",
      status: "active",
      viewerUrl: `https://app.okou.ai/browsers/${THREAD_ID}`,
      liveUrl: "https://live.example.test/?token=private-viewer-token",
      screenshotUrl: null,
      proxyCountryCode: null,
      timeoutMinutes: 240,
      idleExpiresAt: "2026-10-27T08:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-10-27T08:00:00.000Z",
      updatedAt: "2026-10-27T08:00:00.000Z",
      ...(window ? { window } : {}),
    };
  }

  async function run(...args: string[]): Promise<void> {
    await browserCommand.parseAsync([
      "node",
      "okou",
      ...args,
      "--agent-session",
      SESSION,
      "--json",
    ]);
  }

  function output(): string {
    return log.mock.calls.flat().join("\n");
  }

  function clearOutput(): void {
    log.mockClear();
    error.mockClear();
  }

  function result(data: object): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    return {
      status: 0,
      stdout: JSON.stringify({ success: true, data }),
      stderr: "private-driver-stderr",
    };
  }

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    window = { instanceId: INSTANCE_ID, primaryWindowId: 0 };
    tabs = [
      {
        tabId: "t1",
        targetId: SIBLING,
        url: "https://sibling.example.test/?code=private-sibling-code",
      },
      {
        tabId: "t2",
        targetId: OWNER,
        url: "https://user:password@account.example.test/one?code=private-owner-code",
      },
      {
        tabId: "t3",
        targetId: OWNER_TWO,
        url: "https://account.example.test/two?code=private-owner-code",
      },
    ];
    selected = SIBLING;
    nativeWindows = new Map([
      [SIBLING, 99],
      [OWNER, 0],
      [OWNER_TWO, 0],
    ]);
    selections = [];
    protocolFailure = undefined;
    lookupErrors = new Map();
    replyWindow = undefined;
    spawnSyncMock.mockImplementation(
      (_command: string, args: readonly string[]) => {
        const connect = args.indexOf("connect");
        if (connect !== -1) {
          const requestedEndpoint = args[connect + 1];
          if (requestedEndpoint === undefined) {
            throw new Error("Expected a driver connection endpoint");
          }
          return result({});
        }
        const tab = args.indexOf("tab");
        if (tab !== -1 && args[tab + 1] === "list") {
          return result({
            tabs: tabs.map((item) => {
              return {
                ...item,
                active: item.targetId === selected,
                title: "private-page-title",
              };
            }),
          });
        }
        if (tab !== -1) {
          const reference = args[tab + 1];
          const target = tabs.find((item) => {
            return item.targetId === reference || item.tabId === reference;
          });
          if (target && reference !== undefined) {
            selections.push(reference);
            selected = target.targetId;
            return result({ url: target.url, title: "private-page-title" });
          }
        }
        return {
          status: 1,
          stdout: "private-failed-driver-output",
          stderr: "private-driver-stderr",
        };
      },
    );
    server.use(
      http.post("http://localhost:3000/api/browsers/use", () => {
        return HttpResponse.json({ browser: browser(), cdpUrl: CDP_URL });
      }),
      cdp.addEventListener("connection", ({ client }) => {
        client.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            throw new Error("Expected text CDP request");
          }
          const command = JSON.parse(event.data) as {
            readonly id: number;
            readonly method: string;
            readonly params: { readonly targetId: string };
          };
          if (command.method === "Target.getTargets") {
            client.send(
              JSON.stringify({
                id: command.id,
                result: {
                  targetInfos: [...nativeWindows.keys()].map((targetId) => {
                    return { targetId };
                  }),
                },
              }),
            );
            return;
          }
          if (command.method !== "Browser.getWindowForTarget") {
            throw new Error("Unexpected CDP request");
          }
          const native = nativeWindows.get(command.params.targetId);
          const failureMessage =
            lookupErrors.get(command.params.targetId) ?? protocolFailure;
          const failure =
            failureMessage !== undefined
              ? { code: -32601, message: failureMessage }
              : native === undefined
                ? {
                    code: -32000,
                    message: "No target with given id",
                  }
                : undefined;
          const reply = () => {
            client.send(
              JSON.stringify(
                failure
                  ? { id: command.id, error: failure }
                  : { id: command.id, result: { windowId: native } },
              ),
            );
          };
          if (replyWindow) {
            replyWindow(command.params.targetId, reply);
          } else {
            reply();
          }
        });
      }),
    );
  });

  afterEach(() => {
    clearOutput();
    exit.mockClear();
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  });

  it("attaches to the assigned window despite a selected sibling and protects connection output", async () => {
    await run("use");
    expect(selected).toBe(OWNER);
    expect(selections).toStrictEqual([OWNER]);
    expect(JSON.parse(output())).toMatchObject({
      browser: { window },
      agentBrowserSession: SESSION,
    });
    expect(spawnSyncMock.mock.calls.at(0)?.[1]).toStrictEqual([
      "--session",
      SESSION,
      "--no-pin-tab",
      "connect",
      CDP_URL,
    ]);
    expect(output()).not.toContain("private-");
    expect(output()).not.toContain("user:password");
  });

  it("keeps a selected page already in the assigned window", async () => {
    selected = OWNER_TWO;
    await run("use");
    expect(selected).toBe(OWNER_TWO);
    expect(selections).toStrictEqual([OWNER_TWO]);
  });

  it("uses driver order when window membership replies arrive out of order", async () => {
    let held: (() => void) | undefined;
    let released = false;
    replyWindow = (targetId, reply) => {
      if (targetId === OWNER && !released) {
        held = reply;
        return;
      }
      reply();
      if (targetId === OWNER_TWO && held) {
        released = true;
        held();
        held = undefined;
      }
    };
    await run("use");
    expect(selected).toBe(OWNER);
    expect(selections).toStrictEqual([OWNER]);
    expect(output()).not.toContain("private-");
  });

  it("requires a fresh attachment when a candidate moves during the membership batch", async () => {
    replyWindow = (targetId, reply) => {
      reply();
      if (targetId === OWNER_TWO) {
        nativeWindows.set(OWNER, 99);
      }
    };
    await expect(run("use")).rejects.toThrow("process.exit called");
    expect(selected).toBe(SIBLING);
    expect(selections).toStrictEqual([]);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "moved or closed before attachment",
    );
    expect(output()).toBe("");
  });

  it.each([SIBLING, OWNER_TWO])(
    "attaches through a healthy window witness despite an unrelated lookup error: %s",
    async (targetId) => {
      lookupErrors.set(targetId, "private-provider-error");
      await run("use");
      expect(selected).toBe(OWNER);
      expect(selections).toStrictEqual([OWNER]);
      expect(output()).not.toContain("private-");
    },
  );

  it("skips a target that disappeared before initial window selection", async () => {
    nativeWindows.delete(OWNER);
    await run("use");
    expect(selected).toBe(OWNER_TWO);
    expect(selections).toStrictEqual([OWNER_TWO]);
  });

  it("lists the driver's safe inventory after attachment", async () => {
    await run("use");
    vi.stubEnv("OKOU_TOKEN", undefined);
    clearOutput();
    await run("tab", "list");
    expect(JSON.parse(output())).toStrictEqual({
      tabs: [
        { id: "t1", origin: "https://sibling.example.test", active: false },
        { id: "t2", origin: "https://account.example.test", active: true },
        { id: "t3", origin: "https://account.example.test", active: false },
      ],
    });
    expect(output()).not.toContain("private-");
    expect(output()).not.toContain("user:password");
  });

  it("allows explicit selection of a tab in another native window", async () => {
    await run("use");
    vi.stubEnv("OKOU_TOKEN", undefined);
    clearOutput();
    await run("tab", "select", "t1");
    expect(selected).toBe(SIBLING);
    expect(JSON.parse(output())).toStrictEqual({
      tab: { id: "t1", origin: "https://sibling.example.test", active: true },
    });
    expect(output()).not.toContain("private-");
  });

  it("shows page loss and reattaches only on explicit use", async () => {
    await run("use");
    tabs = tabs.filter((tab) => {
      return tab.targetId !== OWNER;
    });
    nativeWindows.delete(OWNER);
    clearOutput();
    await run("tab", "list");
    expect(JSON.parse(output())).toStrictEqual({
      tabs: [
        { id: "t1", origin: "https://sibling.example.test", active: false },
        { id: "t3", origin: "https://account.example.test", active: false },
      ],
    });
    expect(selected).toBe(OWNER);
    clearOutput();
    await run("use");
    expect(selected).toBe(OWNER_TWO);
  });

  it("does not initially attach to a sibling when the assigned window has disappeared", async () => {
    nativeWindows.set(OWNER, 99);
    nativeWindows.set(OWNER_TWO, 99);
    await expect(run("use")).rejects.toThrow("process.exit called");
    expect(selected).toBe(SIBLING);
    expect(selections).toStrictEqual([]);
    expect(output()).toBe("");
    expect(error.mock.calls.flat().join("\n")).toContain("no available tab");
  });

  it("surfaces initial provider lookup failure without exposing its diagnostics", async () => {
    protocolFailure = "private-provider-error";
    await expect(run("use")).rejects.toThrow("process.exit called");
    const failure = error.mock.calls.flat().join("\n");
    expect(failure).toContain("Could not resolve");
    expect(failure).not.toContain("private-");
    expect(output()).toBe("");
  });
});

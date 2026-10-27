import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

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
  let temporary: string;
  let window: BrowserWindowContext | undefined;
  let status: BrowserSession["status"];
  let tabs: DriverTab[];
  let selected: string;
  let endpoint: string;
  let nativeWindows: Map<string, number>;
  let selections: string[];
  let afterSelection: () => void;
  let protocolFailure: string | undefined;

  function browser(): BrowserSession {
    return {
      threadId: THREAD_ID,
      name: "browser",
      status,
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

  function attachmentFile(): string {
    return join(
      temporary,
      `okou-browser-attachments-${userInfo().uid}`,
      `${SESSION}.json`,
    );
  }

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "okou-window-test-"));
    vi.stubEnv("TMPDIR", temporary);
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    window = { instanceId: INSTANCE_ID, primaryWindowId: 0 };
    status = "active";
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
    endpoint = CDP_URL;
    nativeWindows = new Map([
      [SIBLING, 99],
      [OWNER, 0],
      [OWNER_TWO, 0],
    ]);
    selections = [];
    afterSelection = () => {};
    protocolFailure = undefined;
    spawnSyncMock.mockImplementation(
      (_command: string, args: readonly string[]) => {
        const connect = args.indexOf("connect");
        if (connect !== -1) {
          const requestedEndpoint = args[connect + 1];
          if (requestedEndpoint === undefined) {
            throw new Error("Expected a driver connection endpoint");
          }
          endpoint = requestedEndpoint;
          return result({});
        }
        const get = args.indexOf("get");
        if (get !== -1 && args[get + 1] === "cdp-url") {
          return result({ cdpUrl: endpoint });
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
            afterSelection();
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
      http.get("http://localhost:3000/api/browsers/current", () => {
        return HttpResponse.json({ browser: browser() });
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
          const failure =
            protocolFailure !== undefined
              ? { code: -32601, message: protocolFailure }
              : native === undefined
                ? {
                    code: -32000,
                    message: "No target with given id",
                  }
                : undefined;
          client.send(
            JSON.stringify(
              failure
                ? { id: command.id, error: failure }
                : { id: command.id, result: { windowId: native } },
            ),
          );
        });
      }),
    );
  });

  afterEach(() => {
    clearOutput();
    exit.mockClear();
    spawnSyncMock.mockReset();
    vi.unstubAllEnvs();
    rmSync(temporary, { recursive: true, force: true });
  });

  afterAll(() => {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  });

  it("attaches to window zero despite a selected sibling and protects connection output", async () => {
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
    expect(statSync(attachmentFile()).mode & 0o777).toBe(0o600);
    expect(output()).not.toContain("private-");
    expect(output()).not.toContain("user:password");
  });

  it("lists current native membership after intentional moves and omits a disappeared target", async () => {
    await run("use");
    nativeWindows.set(SIBLING, 0);
    nativeWindows.set(OWNER_TWO, 99);
    nativeWindows.delete(OWNER);
    clearOutput();

    await run("tab", "list");

    expect(JSON.parse(output())).toStrictEqual({
      window,
      tabs: [
        { id: "t1", origin: "https://sibling.example.test", active: false },
      ],
    });
    expect(selected).toBe(OWNER);
    expect(output()).not.toContain("private-");
  });

  it("selects a current-window tab using its stable native target ID", async () => {
    await run("use");
    clearOutput();

    await run("tab", "select", "t3");

    expect(selected).toBe(OWNER_TWO);
    expect(selections).toStrictEqual([OWNER, OWNER_TWO]);
    expect(JSON.parse(output())).toStrictEqual({
      tab: {
        id: "t3",
        origin: "https://account.example.test",
        active: true,
      },
    });
    expect(output()).not.toContain("private-");
  });

  it("rejects explicit sibling selection without changing the selected page", async () => {
    await run("use");
    clearOutput();

    await expect(run("tab", "select", "t1")).rejects.toThrow(
      "process.exit called",
    );

    expect(selected).toBe(OWNER);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "not in this chat's current Browser window",
    );
    expect(output()).toBe("");
  });

  it("does not report success or replay a switch when the page moves during selection", async () => {
    await run("use");
    afterSelection = () => {
      nativeWindows.set(OWNER_TWO, 99);
    };
    clearOutput();

    await expect(run("tab", "select", "t3")).rejects.toThrow(
      "process.exit called",
    );

    expect(selections).toStrictEqual([OWNER, OWNER_TWO]);
    expect(output()).toBe("");
    expect(error.mock.calls.flat().join("\n")).toContain("selection changed");
  });

  it("requires explicit recovery when the pinned page closes", async () => {
    await run("use");
    tabs = tabs.filter((tab) => {
      return tab.targetId !== OWNER;
    });
    nativeWindows.delete(OWNER);
    clearOutput();

    await run("tab", "list");

    expect(JSON.parse(output())).toStrictEqual({
      window,
      tabs: [
        { id: "t3", origin: "https://account.example.test", active: false },
      ],
    });
    expect(selected).toBe(OWNER);
    clearOutput();
    await run("use");
    expect(selected).toBe(OWNER_TWO);
  });

  it("rejects a replaced instance even when its native window number is unchanged", async () => {
    await run("use");
    window = {
      instanceId: "e0000000-0000-4000-a000-000000000010",
      primaryWindowId: 0,
    };
    clearOutput();

    await expect(run("tab", "list")).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "does not match this chat's current window",
    );
    expect(output()).toBe("");
  });

  it("rejects an inactive chat lifetime while the shared Browser can still exist", async () => {
    await run("use");
    status = "suspended";
    clearOutput();

    await expect(run("tab", "list")).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "does not match this chat's current window",
    );
    expect(output()).toBe("");
  });

  it("rejects a different physical connection without exposing either endpoint", async () => {
    await run("use");
    endpoint = "wss://another-browser.test/?token=private-other-connection";
    clearOutput();

    await expect(run("tab", "list")).rejects.toThrow("process.exit called");

    const failure = error.mock.calls.flat().join("\n");
    expect(failure).toContain("does not match this chat's current window");
    expect(failure).not.toContain("private-");
    expect(output()).toBe("");
  });

  it("requires reattachment if its temporary shared context is missing", async () => {
    await run("use");
    unlinkSync(attachmentFile());
    clearOutput();

    await expect(run("tab", "list")).rejects.toThrow("process.exit called");

    expect(output()).toBe("");
    expect(error.mock.calls.flat().join("\n")).toContain(
      "run `okou browser use`",
    );
  });

  it("does not attach to a sibling when the assigned window has disappeared", async () => {
    nativeWindows.set(OWNER, 99);
    nativeWindows.set(OWNER_TWO, 99);

    await expect(run("use")).rejects.toThrow("process.exit called");

    expect(selected).toBe(SIBLING);
    expect(selections).toStrictEqual([]);
    expect(output()).toBe("");
    expect(error.mock.calls.flat().join("\n")).toContain("no available tab");
  });

  it("surfaces provider lookup failure instead of treating every tab as missing", async () => {
    await run("use");
    protocolFailure = "private-provider-error";
    clearOutput();

    await expect(run("tab", "list")).rejects.toThrow("process.exit called");

    const failure = error.mock.calls.flat().join("\n");
    expect(failure).toContain("Could not resolve");
    expect(failure).not.toContain("private-");
    expect(output()).toBe("");
  });

  it("does not turn an existing shared attachment into an unscoped one", async () => {
    await run("use");
    window = undefined;
    clearOutput();

    await expect(run("tab", "list")).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "does not match this chat's current window",
    );
    expect(output()).toBe("");
  });
});

/**
 * Tests for computer-use command registration and visibility.
 *
 * Entry points: registerCommands(), formatComputerUseResultForConsole()
 * Mock (external): none
 * Real (internal): Command registration, capability checking, filesystem output
 */

import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command, Help } from "commander";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import {
  formatComputerUseResultForConsole,
  computerUseCommand,
} from "../index";
import { computerUseOutputDir } from "../output-artifacts";
import { registerCommands } from "../../../okou";

let testOutputDir = "";

function testScreenshotPath(): string {
  return path.join(testOutputDir, "Slack-Test-App-desktop_test_snapshot.png");
}

function testAppStatePath(): string {
  return path.join(
    testOutputDir,
    "Slack-Test-App-desktop_test_snapshot.appState.txt",
  );
}

function fileMode(mode: number): number {
  return mode & 0o777;
}

function buildOkouToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "test-signature";
  return `vm0_sandbox_${header}.${body}.${signature}`;
}

function visibleCommandNames(prog: Command): string[] {
  return new Help()
    .visibleCommands(prog)
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return name !== "help";
    });
}

function hiddenCommandNames(prog: Command): string[] {
  const visible = new Set(visibleCommandNames(prog));
  return prog.commands
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return !visible.has(name);
    });
}

describe("computer-use command visibility", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    testOutputDir = await mkdtemp(path.join(tmpdir(), "computer-use-output-"));
    vi.stubEnv("OKOU_COMPUTER_OUTPUT_DIR", testOutputDir);
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.stubEnv("OKOU_TOKEN", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testOutputDir, { recursive: true, force: true });
  });

  it("should be visible when no OKOU_TOKEN is set", () => {
    const prog = new Command();
    registerCommands(prog);

    const cmd = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(cmd).toBeDefined();
  });

  it("should be visible when OKOU_TOKEN includes computer-use:write", () => {
    const token = buildOkouToken({
      userId: "u1",
      runId: "r1",
      orgId: "o1",
      scope: "okou",
      capabilities: ["computer-use:write"],
      iat: 1000,
      exp: 2000,
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = new Command();
    registerCommands(prog);

    expect(visibleCommandNames(prog)).toContain("computer-use");
  });

  it("should be hidden when OKOU_TOKEN lacks computer-use:write", () => {
    const token = buildOkouToken({
      userId: "u1",
      runId: "r1",
      orgId: "o1",
      scope: "okou",
      capabilities: ["agent:read"],
      iat: 1000,
      exp: 2000,
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = new Command();
    registerCommands(prog);

    expect(hiddenCommandNames(prog)).toContain("computer-use");
  });

  it("should have Desktop-backed agent command subcommands", () => {
    const prog = new Command();
    registerCommands(prog, [computerUseCommand]);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(computerUse).toBeDefined();

    const subNames = computerUse!.commands.map((c) => {
      return c.name();
    });
    expect(subNames).toContain("list-apps");
    expect(subNames).toContain("get-app-state");
    expect(subNames).toContain("click");
    expect(subNames).toContain("scroll");
    expect(subNames).toContain("set-value");
    expect(subNames).toContain("type-text");
    expect(subNames).toContain("press-key");
    expect(subNames).toContain("perform-action");
    expect(subNames).toContain("open-app");
    expect(subNames).not.toContain("hosts");
    expect(subNames).not.toContain("revoke-host");
    expect(subNames).not.toContain("audit");
  });

  it("should not expose host targeting options on agent-facing commands", () => {
    const prog = new Command();
    registerCommands(prog, [computerUseCommand]);

    const computerUse = prog.commands.find((c) => {
      return c.name() === "computer-use";
    });
    expect(computerUse).toBeDefined();

    for (const subCommand of computerUse!.commands) {
      const longOptions = subCommand.options.map((option) => {
        return option.long;
      });
      expect(longOptions).toContain("--timeout");
      expect(longOptions).not.toContain("--host");
      expect(longOptions).not.toContain("--host-id");
    }
  });

  it("should explain the recommended Desktop Computer Use workflow", () => {
    let helpOutput = "";
    computerUseCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    computerUseCommand.outputHelp();

    expect(helpOutput).toContain("Workflow:");
    expect(helpOutput).toContain(
      "Start the Okou Desktop app and make sure Computer Use is online",
    );
    expect(helpOutput).toContain("okou computer-use list-apps");
    expect(helpOutput).toContain(
      "okou computer-use get-app-state --app <bundleId>",
    );
    expect(helpOutput).toContain("--snapshot-id desktop_abc --element-index 7");
    expect(helpOutput).toContain("/tmp/okou/computer-use");
    expect(helpOutput).toContain("overwrites the same files");
    expect(helpOutput).toContain("shift+semicolon");
    expect(helpOutput).toContain("Control_L+J");
  });

  it("should prefer the trimmed canonical output directory", () => {
    vi.stubEnv("OKOU_COMPUTER_OUTPUT_DIR", `  ${testOutputDir}  `);

    expect(computerUseOutputDir()).toBe(testOutputDir);
  });

  it.each([
    ["unset", undefined],
    ["blank", " \t "],
  ])(
    "should default computer-use artifacts to the Okou temp directory when the canonical variable is %s",
    (_case, canonical) => {
      vi.stubEnv("OKOU_COMPUTER_OUTPUT_DIR", canonical);

      expect(computerUseOutputDir()).toBe(
        path.join(tmpdir(), "okou", "computer-use"),
      );
    },
  );

  it("should guide missing computer-use capability errors to delegated authorization", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "run-token-without-computer-use");

    server.use(
      http.post("http://localhost:3000/api/computer-use/commands", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Missing required capability: computer-use:write",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await computerUseCommand.parseAsync(["node", "cli", "list-apps"]);
    }).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Computer Use authorization required");
    expect(errorOutput).toContain(
      "ask the user to select an Okou Desktop host for this chat or Slack thread",
    );
    expect(errorOutput).toContain(
      "okou connector permission-request computer-use --permission computer-use:write",
    );
    expect(errorOutput).toContain(
      "Existing run tokens cannot be upgraded in place",
    );
    expect(errorOutput).not.toContain(
      "403: Missing required capability: computer-use:write",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should poll pending command results every 500ms", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    let pollCount = 0;
    server.use(
      http.post("http://localhost:3000/api/computer-use/commands", () => {
        return HttpResponse.json({
          commandId: "cmd_poll",
          status: "queued",
        });
      }),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_poll",
        () => {
          pollCount += 1;

          if (pollCount === 1) {
            return HttpResponse.json({
              id: "cmd_poll",
              kind: "apps.list",
              status: "running",
              hostId: "host_1",
              hostName: "Desktop",
              payload: {},
              timeoutMs: 2_000,
              createdAt: "2026-07-16T10:00:00.000Z",
              claimedAt: "2026-07-16T10:00:00.100Z",
            });
          }

          return HttpResponse.json({
            id: "cmd_poll",
            kind: "apps.list",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: {},
            result: { apps: [] },
            timeoutMs: 2_000,
            createdAt: "2026-07-16T10:00:00.000Z",
            claimedAt: "2026-07-16T10:00:00.100Z",
            completedAt: "2026-07-16T10:00:00.500Z",
          });
        },
      ),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await computerUseCommand.parseAsync([
        "node",
        "cli",
        "list-apps",
        "--timeout",
        "2",
      ]);

      expect(pollCount).toBe(2);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 500);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("should route production commands through api.okou.ai", async () => {
    vi.stubEnv("OKOU_TOKEN", "test-token");

    server.use(
      http.post("https://api.okou.ai/api/computer-use/commands", () => {
        return HttpResponse.json({
          commandId: "cmd_okou_origin",
          status: "queued",
        });
      }),
      http.get(
        "https://api.okou.ai/api/computer-use/commands/cmd_okou_origin",
        () => {
          return HttpResponse.json({
            id: "cmd_okou_origin",
            kind: "apps.list",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: {},
            result: { apps: [] },
            timeoutMs: 15_000,
            createdAt: "2026-08-12T14:00:00.000Z",
            claimedAt: "2026-08-12T14:00:00.100Z",
            completedAt: "2026-08-12T14:00:00.200Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync(["node", "cli", "list-apps"]);
  });

  it("should prefer the canonical backend URL without adding a trailing slash", async () => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "canonical.example.test/");

    server.use(
      http.post(
        "https://canonical.example.test/api/computer-use/commands",
        () => {
          return HttpResponse.json({
            commandId: "cmd_canonical_origin",
            status: "queued",
          });
        },
      ),
      http.get(
        "https://canonical.example.test/api/computer-use/commands/cmd_canonical_origin",
        () => {
          return HttpResponse.json({
            id: "cmd_canonical_origin",
            kind: "apps.list",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: {},
            result: { apps: [] },
            timeoutMs: 15_000,
            createdAt: "2026-08-13T10:00:00.000Z",
            claimedAt: "2026-08-13T10:00:00.100Z",
            completedAt: "2026-08-13T10:00:00.200Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync(["node", "cli", "list-apps"]);
  });

  it("should write screenshot and app state data to local files in command result console output", async () => {
    const screenshotBytes = Buffer.from("test-png-data");
    const screenshotBase64 = screenshotBytes.toString("base64");
    const appState = "snapshot_id=snap_1\nw0 AXWindow";
    const stalePath = path.join(testOutputDir, "stale.appState.txt");
    await writeFile(stalePath, "stale", { mode: 0o666 });
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stalePath, staleDate, staleDate);

    const text = await formatComputerUseResultForConsole(
      {
        app: "Slack/Test App",
        snapshotId: "desktop_test_snapshot",
        appState,
        screenshot: `data:image/png;base64,${screenshotBase64}`,
        screenshotSource: "window",
      },
      "cmd_inline",
    );

    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.status).toBe("succeeded");
    expect(parsed.snapshotId).toBe("desktop_test_snapshot");
    expect(parsed.screenshot).toBe(testScreenshotPath());
    expect(parsed.appState).toBe(testAppStatePath());
    expect(text).not.toContain("screenshotSource");
    expect(text).not.toContain(screenshotBase64);
    expect(text).not.toContain("w0 AXWindow");
    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(testScreenshotPath())).resolves.toEqual(
      screenshotBytes,
    );
    await expect(readFile(testAppStatePath(), "utf8")).resolves.toBe(appState);
    expect(fileMode((await stat(testOutputDir)).mode)).toBe(0o700);
    expect(fileMode((await stat(testScreenshotPath())).mode)).toBe(0o600);
    expect(fileMode((await stat(testAppStatePath())).mode)).toBe(0o600);
  });

  it("should print app bundle identifiers in list-apps output", async () => {
    const text = await formatComputerUseResultForConsole(
      {
        apps: [
          {
            name: "TextEdit",
            bundleId: "com.apple.TextEdit",
            appPath: "/System/Applications/TextEdit.app",
            running: true,
            pid: 42,
          },
        ],
      },
      "cmd_apps",
    );

    expect(JSON.parse(text)).toStrictEqual({
      status: "succeeded",
      apps: [
        {
          name: "TextEdit",
          bundleId: "com.apple.TextEdit",
          appPath: "/System/Applications/TextEdit.app",
          running: true,
          pid: 42,
        },
      ],
    });
  });

  it("should print screenshot and app state file paths for get-app-state", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    const screenshotBytes = Buffer.from("test-png-data");
    const screenshotBase64 = screenshotBytes.toString("base64");
    const appState = "snapshot_id=desktop_test_snapshot\nw0 AXWindow";
    server.use(
      http.post(
        "http://localhost:3000/api/computer-use/commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body.kind).toBe("app.state");
          expect(body.app).toBe("Slack/Test App");
          return HttpResponse.json({
            commandId: "cmd_1",
            status: "queued",
          });
        },
      ),
      http.get("http://localhost:3000/api/computer-use/commands/cmd_1", () => {
        return HttpResponse.json({
          id: "cmd_1",
          kind: "app.state",
          status: "succeeded",
          hostId: "host_1",
          hostName: "Desktop",
          payload: { app: "Slack/Test App" },
          result: {
            app: "Slack/Test App",
            snapshotId: "desktop_test_snapshot",
            appState,
            screenshot: `data:image/png;base64,${screenshotBase64}`,
            screenshotMimeType: "image/png",
            screenshotWidth: 1363,
            screenshotHeight: 1200,
          },
          timeoutMs: 10_000,
          createdAt: "2026-05-21T10:00:00.000Z",
          claimedAt: "2026-05-21T10:00:01.000Z",
          completedAt: "2026-05-21T10:00:02.000Z",
        });
      }),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "get-app-state",
      "--app",
      "Slack/Test App",
      "--timeout",
      "10",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.status).toBe("succeeded");
    expect(parsed.snapshotId).toBe("desktop_test_snapshot");
    expect(parsed.screenshot).toBe(testScreenshotPath());
    expect(parsed.appState).toBe(testAppStatePath());
    expect(parsed.screenshotWidth).toBeUndefined();
    expect(parsed.screenshotHeight).toBeUndefined();
    expect(output).not.toContain(screenshotBase64);
    expect(output).not.toContain("w0 AXWindow");
    await expect(readFile(testScreenshotPath())).resolves.toEqual(
      screenshotBytes,
    );
    await expect(readFile(testAppStatePath(), "utf8")).resolves.toBe(appState);
  });

  it("should send click snapshot coordinates and mouse options", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    server.use(
      http.post(
        "http://localhost:3000/api/computer-use/write-commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            kind: "element.click",
            app: "Slack",
            snapshotId: "snap_1",
            x: 680,
            y: 600,
            button: "right",
            clickCount: 2,
            timeoutMs: 10_000,
          });
          return HttpResponse.json({
            commandId: "cmd_click",
            status: "queued",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_click",
        () => {
          return HttpResponse.json({
            id: "cmd_click",
            kind: "element.click",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: {
              app: "Slack",
              snapshotId: "snap_1",
              x: 680,
              y: 600,
              button: "right",
              clickCount: 2,
            },
            result: { action: { summary: "Clicked 680,600" } },
            timeoutMs: 10_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "click",
      "--app",
      "Slack",
      "--snapshot-id",
      "snap_1",
      "--x",
      "680",
      "--y",
      "600",
      "--button",
      "right",
      "--click-count",
      "2",
      "--timeout",
      "10",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('"status": "succeeded"');
    expect(output).toContain('"summary": "Clicked 680,600"');
  });

  it("should send click element indexes", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    const screenshotBytes = Buffer.from("test-png-data");
    const screenshotBase64 = screenshotBytes.toString("base64");
    const appState = "snapshot_id=desktop_test_snapshot\n7 button Send";
    server.use(
      http.post(
        "http://localhost:3000/api/computer-use/write-commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            kind: "element.click",
            app: "Slack",
            snapshotId: "snap_1",
            elementIndex: 7,
            button: "left",
            clickCount: 1,
            timeoutMs: 30_000,
          });
          return HttpResponse.json({
            commandId: "cmd_click_index",
            status: "queued",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_click_index",
        () => {
          return HttpResponse.json({
            id: "cmd_click_index",
            kind: "element.click",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: {
              app: "Slack",
              snapshotId: "snap_1",
              elementIndex: 7,
              button: "left",
              clickCount: 1,
            },
            result: {
              app: "Slack/Test App",
              snapshotId: "desktop_test_snapshot",
              appState,
              screenshot: `data:image/png;base64,${screenshotBase64}`,
              action: { summary: "Clicked elementIndex=7" },
            },
            timeoutMs: 30_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "click",
      "--app",
      "Slack",
      "--snapshot-id",
      "snap_1",
      "--element-index",
      "7",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.appState).toBe(testAppStatePath());
    expect(parsed.screenshot).toBe(testScreenshotPath());
    expect(output).toContain('"status": "succeeded"');
    expect(output).toContain('"summary": "Clicked elementIndex=7"');
    expect(output).not.toContain("7 button Send");
    await expect(readFile(testAppStatePath(), "utf8")).resolves.toBe(appState);
    await expect(readFile(testScreenshotPath())).resolves.toEqual(
      screenshotBytes,
    );
  });

  it("should send press-key snapshot id and key", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    server.use(
      http.post(
        "http://localhost:3000/api/computer-use/write-commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            kind: "keyboard.press_key",
            app: "Slack",
            snapshotId: "snap_1",
            key: "Command+L",
            timeoutMs: 30_000,
          });
          return HttpResponse.json({
            commandId: "cmd_press",
            status: "queued",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_press",
        () => {
          return HttpResponse.json({
            id: "cmd_press",
            kind: "keyboard.press_key",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: { app: "Slack", snapshotId: "snap_1", key: "Command+L" },
            result: {
              app: "Slack",
              action: { key: "Command+L", summary: "Pressed Command+L" },
            },
            timeoutMs: 30_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "press-key",
      "--app",
      "Slack",
      "--snapshot-id",
      "snap_1",
      "--key",
      "Command+L",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('"status": "succeeded"');
    expect(output).toContain('"summary": "Pressed Command+L"');
  });

  it("should send type-text snapshot id and text", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    server.use(
      http.post(
        "http://localhost:3000/api/computer-use/write-commands",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            kind: "keyboard.type_text",
            app: "Slack",
            snapshotId: "snap_1",
            text: "Hello",
            timeoutMs: 30_000,
          });
          return HttpResponse.json({
            commandId: "cmd_type",
            status: "queued",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_type",
        () => {
          return HttpResponse.json({
            id: "cmd_type",
            kind: "keyboard.type_text",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: { app: "Slack", snapshotId: "snap_1", text: "Hello" },
            result: { app: "Slack", action: { summary: "Typed text" } },
            timeoutMs: 30_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "type-text",
      "--app",
      "Slack",
      "--snapshot-id",
      "snap_1",
      "--text",
      "Hello",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('"status": "succeeded"');
    expect(output).toContain('"summary": "Typed text"');
  });

  it("should download pointer-backed screenshots through the API proxy", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    const screenshotBytes = Buffer.from("proxy-png-bytes");
    server.use(
      http.post("http://localhost:3000/api/computer-use/commands", () => {
        return HttpResponse.json({ commandId: "cmd_ptr", status: "queued" });
      }),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_ptr",
        () => {
          return HttpResponse.json({
            id: "cmd_ptr",
            kind: "app.state",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: { app: "Slack/Test App" },
            result: {
              app: "Slack/Test App",
              snapshotId: "desktop_test_snapshot",
              screenshot: {
                type: "s3",
                mimeType: "image/png",
                sizeBytes: screenshotBytes.length,
                width: 1363,
                height: 1200,
              },
            },
            timeoutMs: 10_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_ptr/screenshot",
        () => {
          return new HttpResponse(screenshotBytes, {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        },
      ),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "get-app-state",
      "--app",
      "Slack/Test App",
      "--timeout",
      "10",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.screenshot).toBe(testScreenshotPath());
    await expect(readFile(testScreenshotPath())).resolves.toEqual(
      screenshotBytes,
    );
  });

  it("should mark expired pointer screenshots in command output", async () => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");

    server.use(
      http.post("http://localhost:3000/api/computer-use/commands", () => {
        return HttpResponse.json({ commandId: "cmd_exp", status: "queued" });
      }),
      http.get(
        "http://localhost:3000/api/computer-use/commands/cmd_exp",
        () => {
          return HttpResponse.json({
            id: "cmd_exp",
            kind: "app.state",
            status: "succeeded",
            hostId: "host_1",
            hostName: "Desktop",
            payload: { app: "Slack/Test App" },
            result: {
              app: "Slack/Test App",
              snapshotId: "desktop_test_snapshot",
              screenshot: { type: "expired" },
            },
            timeoutMs: 10_000,
            createdAt: "2026-05-21T10:00:00.000Z",
            claimedAt: "2026-05-21T10:00:01.000Z",
            completedAt: "2026-05-21T10:00:02.000Z",
          });
        },
      ),
    );

    await computerUseCommand.parseAsync([
      "node",
      "cli",
      "get-app-state",
      "--app",
      "Slack/Test App",
      "--timeout",
      "10",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed.screenshot).toBe("[screenshot expired]");
  });
});

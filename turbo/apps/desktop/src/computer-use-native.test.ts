import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createComputerUseNativeBackend } from "./computer-use-native";

async function createHelper(
  response: unknown,
): Promise<{ readonly dir: string; readonly helperPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath };
}

async function createRawOutputHelper(
  output: string,
): Promise<{ readonly dir: string; readonly helperPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(output)});
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath };
}

async function createExitHelper({
  code,
  stderr,
}: {
  readonly code: number;
  readonly stderr: string;
}): Promise<{ readonly dir: string; readonly helperPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${code.toString()});
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath };
}

async function createSessionHelper(): Promise<{
  readonly dir: string;
  readonly helperPath: string;
  readonly requestLogPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  const requestLogPath = path.join(dir, "requests.ndjson");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const requestLogPath = ${JSON.stringify(requestLogPath)};
let buffer = "";

function responseFor(request) {
	  if (
	    request.kind === "permissions.state" ||
	    request.kind === "permissions.request_accessibility" ||
	    request.kind === "permissions.request_screen_recording"
	  ) {
    return {
      id: request.id,
      status: "succeeded",
	      result: { accessibility: true, screenRecording: true }
	    };
	  }
	  if (request.kind === "permissions.probe_automation") {
	    return {
	      id: request.id,
	      status: "succeeded",
	      result: {
	        status: "denied",
	        reason: "Not authorized to send Apple events. (-1743)"
	      }
	    };
	  }
  if (request.kind === "apps.list") {
    return {
      id: request.id,
      status: "succeeded",
      result: { apps: ["Safari"] }
    };
  }
  if (request.kind === "app.state") {
    return {
      id: request.id,
      status: "succeeded",
      result: {
        app: request.payload.app,
        snapshotId: request.payload.snapshotId,
        elements: [
          {
            index: 0,
            role: "AXWindow",
            children: [{ index: 1, role: "AXButton", name: "Open" }]
          }
        ],
        elementIdsByIndex: ["w0", "w0.e0"],
        screenshot: "data:image/png;base64,abc123",
        screenshotSource: "window",
        screenshotSourceName: "Example",
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotSourceBounds: { x: 0, y: 0, width: 800, height: 600 }
      }
    };
  }
  if (request.kind === "element.click") {
    if (request.payload.x !== undefined && request.payload.y !== undefined) {
      return {
        id: request.id,
        status: "succeeded",
        result: {
          snapshotId: request.payload.snapshotId,
          screenX: 400,
          screenY: 300,
          button: request.payload.button
        }
      };
    }
    return {
      id: request.id,
      status: "succeeded",
      result: {
        snapshotId: request.payload.snapshotId,
        elementIndex: request.payload.elementIndex,
        button: request.payload.button
      }
    };
  }
  if (request.kind === "keyboard.press_key") {
    const foregroundRecovery = request.payload.foregroundRecovery
      ? {
          foregroundRecovery: {
            triggered: true,
            policy: request.payload.foregroundRecovery
          }
        }
      : {};
    return {
      id: request.id,
      status: "succeeded",
      result: {
        normalizedKey: request.payload.key,
        ...foregroundRecovery
      }
    };
  }
  return { id: request.id, status: "succeeded", result: {} };
}

function handleLine(line) {
  if (line.trim().length === 0) return;
  const request = JSON.parse(line);
  fs.appendFileSync(requestLogPath, JSON.stringify(request) + "\\n");
  process.stdout.write(JSON.stringify(responseFor(request)) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath, requestLogPath };
}

// A serve-mode helper that makes concurrency observable: it logs how many
// requests are in flight when each one arrives, defers its response so overlap
// would be visible, records every process launch, and never answers a request
// for the "HANG" app so the client-side timeout/respawn path can be exercised.
async function createConcurrencyHelper(responseDelayMs: number): Promise<{
  readonly dir: string;
  readonly helperPath: string;
  readonly requestLogPath: string;
  readonly startLogPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  const requestLogPath = path.join(dir, "requests.ndjson");
  const startLogPath = path.join(dir, "starts.log");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const requestLogPath = ${JSON.stringify(requestLogPath)};
const startLogPath = ${JSON.stringify(startLogPath)};
const responseDelayMs = ${responseDelayMs.toString()};
fs.appendFileSync(startLogPath, String(process.pid) + "\\n");
let inFlight = 0;
let buffer = "";

function handleLine(line) {
  if (line.trim().length === 0) return;
  const request = JSON.parse(line);
  inFlight += 1;
  fs.appendFileSync(
    requestLogPath,
    JSON.stringify({ id: request.id, app: request.payload.app, inFlight }) + "\\n"
  );
  const app = request.payload.app;
  if (app === "HANG") return;
  setTimeout(() => {
    inFlight -= 1;
    if (app === "FAIL") {
      process.stdout.write(
        JSON.stringify({
          id: request.id,
          status: "failed",
          error: { code: "app_open_failed", message: "Unable to open " + app }
        }) + "\\n"
      );
      return;
    }
    process.stdout.write(
      JSON.stringify({ id: request.id, status: "succeeded", result: {} }) + "\\n"
    );
  }, responseDelayMs);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath, requestLogPath, startLogPath };
}

async function createStubbornSessionHelper(): Promise<{
  readonly dir: string;
  readonly helperPath: string;
  readonly shutdownLogPath: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  const shutdownLogPath = path.join(dir, "shutdown.log");
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const shutdownLogPath = ${JSON.stringify(shutdownLogPath)};
let buffer = "";
setInterval(() => {}, 1_000);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(
      JSON.stringify({ id: request.id, status: "succeeded", result: {} }) + "\\n"
    );
  }
});
process.stdin.on("end", () => {
  fs.appendFileSync(shutdownLogPath, "eof\\n");
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath, shutdownLogPath };
}

async function createRuntimeExitHelper(
  outcome: { readonly code: number } | { readonly signal: "SIGTERM" },
): Promise<{ readonly dir: string; readonly helperPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "computer-use-helper-"));
  const helperPath = path.join(dir, "helper");
  const exitStatement =
    "signal" in outcome
      ? `process.kill(process.pid, ${JSON.stringify(outcome.signal)});`
      : `process.exit(${outcome.code.toString()});`;
  await writeFile(
    helperPath,
    `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes("\\n")) {
    ${exitStatement}
  }
});
`,
  );
  await chmod(helperPath, 0o755);
  return { dir, helperPath };
}

describe("computer use native backend", () => {
  it("reads permissions from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: { accessibility: true, screenRecording: false },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.getPermissions()).resolves.toEqual({
        accessibility: true,
        screenRecording: false,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("requests accessibility permission through the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: { accessibility: true, screenRecording: true },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.requestAccessibilityPermission()).resolves.toEqual({
        accessibility: true,
        screenRecording: true,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("requests screen recording permission through the native helper", async () => {
    const helper = await createSessionHelper();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      await expect(backend.requestScreenRecordingPermission()).resolves.toEqual(
        {
          accessibility: true,
          screenRecording: true,
        },
      );

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        kind: "permissions.request_screen_recording",
      });
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("probes browser automation permission through the native helper", async () => {
    const helper = await createSessionHelper();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      await expect(
        backend.probeAutomationPermission("chrome"),
      ).resolves.toEqual({
        status: "denied",
        updatedAt: null,
        reason: "Not authorized to send Apple events. (-1743)",
      });

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        kind: "permissions.probe_automation",
        payload: { target: "chrome" },
      });
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads coordinate click screen points from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        dispatchMode: "background_mouse_event",
        frontmostRestored: true,
        screenX: 900,
        screenY: 800,
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(
        backend.clickPoint({
          app: "Safari",
          snapshotId: "snap_1",
          x: 400,
          y: 300,
          screenshotSource: "window",
          screenshotWidth: 800,
          screenshotHeight: 600,
          sourceBounds: { x: 100, y: 200, width: 1600, height: 1200 },
          windowId: 123,
          windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
          button: "right",
          clickCount: 2,
        }),
      ).resolves.toEqual({
        dispatchMode: "background_mouse_event",
        frontmostRestored: true,
        screenX: 900,
        screenY: 800,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads app-open dispatch metadata from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        dispatchMode: "background_app_open",
        dispatchTarget: "target_app",
        inputRisk: "background_app_launch",
        frontmostRestored: false,
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.openApp("Things")).resolves.toEqual({
        dispatchMode: "background_app_open",
        dispatchTarget: "target_app",
        inputRisk: "background_app_launch",
        frontmostRestored: false,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads structured app records from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        apps: [
          {
            name: "TextEdit",
            bundleId: "com.apple.TextEdit",
            appPath: "/System/Applications/TextEdit.app",
            running: true,
            pid: 42,
          },
          "Safari",
        ],
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.listApps()).resolves.toEqual([
        {
          name: "TextEdit",
          bundleId: "com.apple.TextEdit",
          appPath: "/System/Applications/TextEdit.app",
          running: true,
          pid: 42,
        },
        {
          name: "Safari",
        },
      ]);
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reads normalized key names from the native helper", async () => {
    const helper = await createHelper({
      status: "succeeded",
      result: {
        dispatchMode: "background_keyboard_event",
        frontmostRestored: false,
        normalizedKey: "Command+K",
      },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(
        backend.pressKey({ app: "Safari", key: "cmd+k" }),
      ).resolves.toEqual({
        dispatchMode: "background_keyboard_event",
        frontmostRestored: false,
        normalizedKey: "Command+K",
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["app_not_found", "Unable to open Things: Unable to find application"],
    ["app_open_failed", "Unable to open Things"],
    [
      "automation_permission_denied",
      "Not authorized to send Apple events to Google Chrome. (-1743)",
    ],
    ["element_action_unsupported", "Element does not support a primary click"],
    [
      "element_not_editable",
      "The focused element in Things is not editable. Click into a text field or editable area before typing.",
    ],
    ["window_unavailable", "Unable to resolve a background window target"],
  ])("preserves %s helper failures", async (code, message) => {
    const helper = await createHelper({
      status: "failed",
      error: { code, message },
    });

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
      });

      await expect(backend.openApp("Things")).rejects.toMatchObject({
        code,
        message,
      });
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("does not report expected helper failures", async () => {
    const helper = await createHelper({
      status: "failed",
      error: { code: "app_open_failed", message: "Unable to open Things" },
    });
    const onRuntimeError = vi.fn();

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
        onRuntimeError,
      });

      await expect(backend.openApp("Things")).rejects.toMatchObject({
        code: "app_open_failed",
      });
      expect(onRuntimeError).not.toHaveBeenCalled();
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reports invalid one-shot helper protocol responses", async () => {
    const helper = await createRawOutputHelper("not-json\n");
    const onRuntimeError = vi.fn();

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
        onRuntimeError,
      });

      await expect(backend.listApps()).rejects.toBeInstanceOf(Error);
      expect(onRuntimeError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          helperPath: helper.helperPath,
          mode: "oneshot",
          requestKind: "apps.list",
          stage: "protocol",
        }),
      );
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reports one-shot helper process exits", async () => {
    const helper = await createExitHelper({
      code: 2,
      stderr: "helper crashed",
    });
    const onRuntimeError = vi.fn();

    try {
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        mode: "oneshot",
        onRuntimeError,
      });

      await expect(backend.openApp("Things")).rejects.toMatchObject({
        message: "helper crashed",
      });
      expect(onRuntimeError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          helperPath: helper.helperPath,
          mode: "oneshot",
          requestKind: "app.open",
          stage: "exit",
          exitCode: 2,
          stderr: "helper crashed",
        }),
      );
    } finally {
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("uses a session runtime for multiple commands in one helper process", async () => {
    const helper = await createSessionHelper();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      await expect(
        backend.getAppState("Safari", "snap_1"),
      ).resolves.toMatchObject({
        app: "Safari",
        snapshotId: "snap_1",
        elementIdsByIndex: ["w0", "w0.e0"],
      });
      await expect(
        backend.clickElement({
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          button: "left",
          clickCount: 1,
        }),
      ).resolves.toEqual({
        snapshotId: "snap_1",
        elementIndex: 1,
        button: "left",
      });
      await expect(
        backend.clickPoint({
          app: "Safari",
          snapshotId: "snap_1",
          x: 200,
          y: 150,
          screenshotSource: "window",
          screenshotWidth: 800,
          screenshotHeight: 600,
          sourceBounds: { x: 0, y: 0, width: 800, height: 600 },
          button: "right",
          clickCount: 1,
        }),
      ).resolves.toEqual({
        snapshotId: "snap_1",
        screenX: 400,
        screenY: 300,
        button: "right",
      });

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as Record<string, unknown>;
        });
      expect(requests).toHaveLength(3);
      expect(requests[0]).toMatchObject({
        kind: "app.state",
        payload: { app: "Safari", snapshotId: "snap_1" },
      });
      expect(requests[1]).toMatchObject({
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          elementIndex: 1,
          button: "left",
          clickCount: 1,
        },
      });
      expect(requests[2]).toMatchObject({
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          x: 200,
          y: 150,
          screenshotSource: "window",
          button: "right",
        },
      });
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent native requests to one in-flight at a time", async () => {
    const helper = await createConcurrencyHelper(40);
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      const apps = Array.from({ length: 8 }, (_, index) => {
        return `app${index.toString()}`;
      });
      await Promise.all(
        apps.map((app) => {
          return backend.openApp(app);
        }),
      );

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as {
            readonly id: string;
            readonly app: string;
            readonly inFlight: number;
          };
        });

      expect(requests).toHaveLength(8);
      // Serialization means the helper never sees more than one request at once.
      expect(
        Math.max(
          ...requests.map((request) => {
            return request.inFlight;
          }),
        ),
      ).toBe(1);
      // The helper receives requests in submission order (FIFO queue).
      expect(
        requests.map((request) => {
          return request.app;
        }),
      ).toStrictEqual(apps);
      expect(
        requests.map((request) => {
          return request.id;
        }),
      ).toStrictEqual(
        Array.from({ length: 8 }, (_, index) => {
          return `desktop_${(index + 1).toString()}`;
        }),
      );
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("keeps the serialized queue alive when one request fails", async () => {
    const helper = await createConcurrencyHelper(20);
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      const results = await Promise.allSettled([
        backend.openApp("ok-a"),
        backend.openApp("ok-b"),
        backend.openApp("FAIL"),
        backend.openApp("ok-c"),
        backend.openApp("ok-d"),
      ]);

      expect(
        results.map((result) => {
          return result.status;
        }),
      ).toStrictEqual([
        "fulfilled",
        "fulfilled",
        "rejected",
        "fulfilled",
        "fulfilled",
      ]);
      const failed = results[2];
      if (failed?.status !== "rejected") {
        throw new Error("expected the FAIL request to reject");
      }
      expect(failed.reason).toMatchObject({ code: "app_open_failed" });
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("treats a normal EOF exit during disposal as expected", async () => {
    const helper = await createSessionHelper();
    const onRuntimeError = vi.fn();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
      shutdownGraceMs: 100,
      onRuntimeError,
    });

    try {
      await expect(backend.openApp("Safari")).resolves.toEqual({});
      await backend.dispose("app_quit");

      expect(onRuntimeError).not.toHaveBeenCalled();
      await expect(backend.openApp("Mail")).rejects.toMatchObject({
        code: "accessibility_unavailable",
        message: expect.stringContaining("runtime is closed"),
      });
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it.each(["app_quit", "update_relaunch"] as const)(
    "treats an owned SIGTERM escalation during %s as expected",
    async (reason) => {
      const helper = await createStubbornSessionHelper();
      const onRuntimeError = vi.fn();
      const backend = createComputerUseNativeBackend({
        helperPath: helper.helperPath,
        shutdownGraceMs: 50,
        onRuntimeError,
      });

      try {
        await expect(backend.openApp("Safari")).resolves.toEqual({});
        await backend.dispose(reason);

        expect(await readFile(helper.shutdownLogPath, "utf8")).toBe("eof\n");
        expect(onRuntimeError).not.toHaveBeenCalled();
      } finally {
        await backend.dispose();
        await rm(helper.dir, { recursive: true, force: true });
      }
    },
  );

  it("classifies an unowned SIGTERM as a genuine runtime interruption", async () => {
    const helper = await createRuntimeExitHelper({ signal: "SIGTERM" });
    const onRuntimeError = vi.fn();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
      onRuntimeError,
    });

    try {
      await expect(backend.openApp("Safari")).rejects.toMatchObject({
        code: "accessibility_unavailable",
        message: expect.stringContaining("terminated by SIGTERM"),
      });
      expect(onRuntimeError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({
          mode: "serve",
          stage: "exit",
          exitCode: null,
          signal: "SIGTERM",
          terminationReason: "unexpected_exit",
          pendingRequestCount: 1,
          queuedRequestCount: 0,
        }),
      );
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("classifies an unowned status-zero exit as a runtime interruption", async () => {
    const helper = await createRuntimeExitHelper({ code: 0 });
    const onRuntimeError = vi.fn();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
      onRuntimeError,
    });

    try {
      await expect(backend.openApp("Safari")).rejects.toMatchObject({
        code: "accessibility_unavailable",
        message: expect.stringContaining("exited with status 0"),
      });
      expect(onRuntimeError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({
          mode: "serve",
          stage: "exit",
          exitCode: 0,
          signal: null,
          terminationReason: "unexpected_exit",
          pendingRequestCount: 1,
          queuedRequestCount: 0,
        }),
      );
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("reports a nonzero persistent-runtime exit as a genuine crash", async () => {
    const helper = await createRuntimeExitHelper({ code: 9 });
    const onRuntimeError = vi.fn();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
      onRuntimeError,
    });

    try {
      await expect(backend.openApp("Safari")).rejects.toMatchObject({
        code: "accessibility_unavailable",
        message: expect.stringContaining("exited with status 9"),
      });
      expect(onRuntimeError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({
          mode: "serve",
          stage: "exit",
          exitCode: 9,
          signal: null,
          terminationReason: "unexpected_exit",
          pendingRequestCount: 1,
        }),
      );
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("does not dispatch queued requests after disposal starts", async () => {
    const helper = await createConcurrencyHelper(250);
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
      shutdownGraceMs: 20,
    });
    const resultsPromise = Promise.allSettled([
      backend.openApp("active"),
      backend.openApp("queued"),
    ]);

    try {
      await vi.waitFor(async () => {
        const requests = (await readFile(helper.requestLogPath, "utf8"))
          .trim()
          .split("\n");
        expect(requests).toHaveLength(1);
      });
      await backend.dispose("app_quit");

      const results = await resultsPromise;
      expect(results.map((result) => result.status)).toStrictEqual([
        "rejected",
        "rejected",
      ]);
      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n");
      const starts = (await readFile(helper.startLogPath, "utf8"))
        .trim()
        .split("\n");
      expect(requests).toHaveLength(1);
      expect(starts).toHaveLength(1);
    } finally {
      await backend.dispose();
      await resultsPromise;
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("requires generation retirement after a request times out", async () => {
    const helper = await createConcurrencyHelper(20);
    const onRuntimeError = vi.fn();
    // Generous enough that a legitimate request (which must cold-start a fresh
    // helper process after the kill) never trips it, while the never-answered
    // "HANG" request always does.
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
      requestTimeoutMs: 2_000,
      onRuntimeError,
    });

    try {
      await expect(backend.openApp("HANG")).rejects.toMatchObject({
        code: "accessibility_unavailable",
        message: expect.stringContaining("timed out running app.open"),
      });
      // The old backend cannot make its process-owned snapshots/actions valid
      // in a replacement. Fresh work belongs to a newly constructed generation.
      await expect(backend.openApp("ok")).rejects.toThrow("closed");

      const starts = (await readFile(helper.startLogPath, "utf8"))
        .trim()
        .split("\n");
      expect(starts).toHaveLength(1);
      expect(onRuntimeError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          helperPath: helper.helperPath,
          mode: "serve",
          requestKind: "app.open",
          stage: "timeout",
          terminationReason: "timeout_replace",
          pendingRequestCount: 1,
        }),
      );
      expect(onRuntimeError).toHaveBeenCalledTimes(1);
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });

  it("forwards foreground recovery policy to native helper actions", async () => {
    const helper = await createSessionHelper();
    const backend = createComputerUseNativeBackend({
      helperPath: helper.helperPath,
    });

    try {
      await backend.clickElement({
        app: "Safari",
        elementId: "w0.e0",
        button: "left",
        clickCount: 1,
        foregroundRecovery: "always",
      });
      await backend.clickPoint({
        app: "Safari",
        snapshotId: "snap_1",
        x: 200,
        y: 150,
        screenshotSource: "window",
        screenshotWidth: 800,
        screenshotHeight: 600,
        sourceBounds: { x: 0, y: 0, width: 800, height: 600 },
        button: "left",
        clickCount: 1,
        foregroundRecovery: "on-window-unavailable",
      });
      await backend.typeText({
        app: "Safari",
        snapshotId: "snap_1",
        text: "hello",
        foregroundRecovery: "never",
      });
      await backend.pressKey({
        app: "Safari",
        snapshotId: "snap_1",
        key: "cmd+k",
        foregroundRecovery: "always",
      });

      const requests = (await readFile(helper.requestLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as {
            readonly kind: string;
            readonly payload?: Record<string, unknown>;
          };
        });
      expect(
        requests.map((request) => {
          return request.kind;
        }),
      ).toStrictEqual([
        "element.click",
        "element.click",
        "keyboard.type_text",
        "keyboard.press_key",
      ]);
      expect(requests[0]?.payload).toMatchObject({
        foregroundRecovery: "always",
      });
      expect(requests[1]?.payload).toMatchObject({
        foregroundRecovery: "on-window-unavailable",
      });
      expect(requests[2]?.payload).toMatchObject({
        snapshotId: "snap_1",
        foregroundRecovery: "never",
      });
      expect(requests[3]?.payload).toMatchObject({
        snapshotId: "snap_1",
        foregroundRecovery: "always",
      });
    } finally {
      await backend.dispose();
      await rm(helper.dir, { recursive: true, force: true });
    }
  });
});

it("ignores duplicate and unowned replies, and bounds protocol diagnostics without retaining private output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "native-frame-ownership-"));
  const helperPath = path.join(dir, "helper.cjs");
  await writeFile(
    helperPath,
    `#!${process.execPath}
const fs = require('node:fs');
let previous;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if (request.kind === 'permissions.state') {
    fs.writeSync(2, 'private-token-and-app-content'.repeat(1000));
    fs.writeSync(1, JSON.stringify({id:request.id,status:'succeeded',result:[]})+'\\n');
    return;
  }
  if(previous) fs.writeSync(1, JSON.stringify({id:previous,status:'failed',error:{code:'permission_denied'}})+'\\n');
  fs.writeSync(1, JSON.stringify({id:'unowned',status:'invalid'})+'\\n');
  fs.writeSync(1, JSON.stringify({id:request.id,status:'succeeded',result:{apps:['Fresh']}})+'\\n');
  previous=request.id;
});
`,
  );
  await chmod(helperPath, 0o755);
  const onRuntimeError = vi.fn();
  const backend = createComputerUseNativeBackend({
    helperPath,
    onRuntimeError,
  });
  try {
    for (let index = 0; index < 20; index++)
      await expect(backend.listApps()).resolves.toEqual([{ name: "Fresh" }]);
    await expect(backend.getPermissions()).rejects.toThrow("invalid result");
    const context = onRuntimeError.mock.calls[0]?.[1] as {
      phases: { elapsedMs: number }[];
      stderrBytes: number;
      pendingRequestCount: number;
    };
    expect(context.phases).toHaveLength(12);
    expect(
      context.phases.every(
        (phase) => phase.elapsedMs >= 0 && phase.elapsedMs <= 120_000,
      ),
    ).toBe(true);
    expect(context.stderrBytes).toBeLessThanOrEqual(4096);
    expect(context.pendingRequestCount).toBe(1);
    expect(JSON.stringify(onRuntimeError.mock.calls)).not.toContain(
      "private-token",
    );
    expect(JSON.stringify(onRuntimeError.mock.calls)).not.toContain("Fresh");
    await backend.dispose();
    await expect(backend.listApps()).rejects.toThrow("closed");
    expect(onRuntimeError).toHaveBeenCalledTimes(1);
  } finally {
    await backend.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

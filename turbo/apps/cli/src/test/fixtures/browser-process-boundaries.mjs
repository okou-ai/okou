import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Substitute external executables and HTTP only; the CLI, worker and IPC stay real.
if (process.argv[2] !== "__browser-proxy") {
  const config = JSON.parse(readFileSync("boundaries.json", "utf8"));
  const spawn = childProcess.spawn;
  const spawnSync = childProcess.spawnSync;
  childProcess.spawn = (program, args, options) => {
    if (program !== "/usr/local/bin/guest-task-exec")
      return spawn(program, args, options);
    return spawn(
      "python3",
      [
        fileURLToPath(new URL("./guest-task-helper.py", import.meta.url)),
        "normal",
        process.cwd(),
        ...args,
      ],
      options,
    );
  };
  childProcess.spawnSync = (program, args, options) => {
    if (program !== "agent-browser") return spawnSync(program, args, options);
    return spawnSync(
      process.execPath,
      [
        "-e",
        'const fs = require("node:fs"); fs.writeFileSync("endpoint", process.argv.at(-1)); process.exit(JSON.parse(fs.readFileSync("boundaries.json", "utf8")).driverExit);',
        "--",
        ...args,
      ],
      options,
    );
  };
  syncBuiltinESMExports();

  const response = {
    browser: {
      threadId: "c0000000-0000-4000-a000-000000000010",
      name: "browser",
      status: "active",
      viewerUrl: "https://app.okou.ai/browsers/test-output",
      liveUrl: null,
      screenshotUrl: null,
      timeoutMinutes: 240,
      idleExpiresAt: "2026-11-03T10:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-11-03T10:00:00.000Z",
      updatedAt: "2026-11-03T10:00:00.000Z",
      window: {
        instanceId: "d0000000-0000-4000-a000-000000000010",
        primaryWindowId: 0,
      },
    },
    cdpUrl: config.cdpUrl,
    extension: {
      id: "11111111-1111-4111-8111-111111111111",
      runtimeId: "abcdefghijklmnopabcdefghijklmnop",
      version: "0.5.1",
    },
  };
  setupServer(
    http.post("http://browser-api.test/api/browsers/use", () => {
      return HttpResponse.json(response);
    }),
    http.post("http://browser-api.test/api/browsers", () => {
      return HttpResponse.json(response, { status: 201 });
    }),
  ).listen({ onUnhandledRequest: "error" });
}

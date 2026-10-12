import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(
    fileURLToPath(
      new URL("../../../../.computer-use-process-", import.meta.url),
    ),
  );
  await build({
    config: false,
    entry: [fileURLToPath(new URL("../../../okou.ts", import.meta.url))],
    outDir: directory,
    outExtension: () => {
      return { js: ".js" };
    },
    format: ["esm"],
    splitting: false,
    dts: false,
    silent: true,
    external: ["ably", "commander"],
    shims: true,
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    define: {
      __CLI_VERSION__: JSON.stringify("0.0.0-test"),
      __DEFAULT_SENTRY_DSN__: JSON.stringify(""),
    },
  });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test.each(["headers", "body", "websocket"] as const)(
  "exits naturally after printing a result while Ably %s are still pending",
  async (pending) => {
    let tokenStarted = false;
    let tokenFinished = false;
    let tokenRequests = 0;
    let pendingUpgrade: Duplex | undefined;
    let resolveTokenClosed!: () => void;
    const tokenClosed = new Promise<void>((resolve) => {
      resolveTokenClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.resume();
      if (request.url?.includes("/requestToken")) {
        tokenStarted = true;
        tokenRequests++;
        if (pending === "websocket") {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              token: "test-token",
              issued: Date.now(),
              expires: Date.now() + 60_000,
              capability:
                '{"computer-use-result:user:org:command-process":["subscribe"]}',
            }),
          );
          return;
        }
        response.once("close", () => {
          tokenFinished = response.writableEnded;
          resolveTokenClosed();
        });
        if (pending === "body") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write('{"token":"');
        }
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST") {
        response.end(
          JSON.stringify({
            commandId: "command-process",
            status: "queued",
            realtime: {
              channelName: "computer-use-result:user:org:command-process",
              eventName: "resultChanged",
              tokenRequest: {
                keyName: "test.key",
                timestamp: Date.now(),
                nonce: "test-nonce",
                mac: "test-signature",
                capability:
                  '{"computer-use-result:user:org:command-process":["subscribe"]}',
              },
            },
          }),
        );
        return;
      }
      const complete =
        pending === "websocket" ? Boolean(pendingUpgrade) : tokenStarted;
      response.end(
        JSON.stringify({
          id: "command-process",
          kind: "apps.list",
          status: complete ? "succeeded" : "running",
          hostId: "host-process",
          hostName: "Desktop",
          payload: {},
          timeoutMs: 30_000,
          createdAt: "2026-10-12T00:00:00Z",
          claimedAt: "2026-10-12T00:00:01Z",
          completedAt: complete ? "2026-10-12T00:00:02Z" : null,
          ...(complete
            ? {
                result: {
                  apps: [{ name: "Chrome", bundleId: "com.google.Chrome" }],
                },
              }
            : {}),
        }),
      );
    });
    server.on("upgrade", (_request, socket) => {
      pendingUpgrade = socket;
      socket.once("end", () => {
        return socket.end();
      });
      socket.once("close", resolveTokenClosed);
      socket.resume();
    });
    await new Promise<void>((resolve) => {
      return server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP server");
    const origin = `http://127.0.0.1:${address.port}`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(
          new URL(
            "../../../test/fixtures/realtime-http-redirect.mjs",
            import.meta.url,
          ),
        ),
        join(directory, "okou.js"),
        "computer-use",
        "list-apps",
      ],
      {
        env: {
          ...process.env,
          OKOU_TOKEN: "test-token",
          OKOU_API_BACKEND_URL: origin,
          SENTRY_DSN: "",
          VERCEL_AUTOMATION_BYPASS_SECRET: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      pendingUpgrade?.destroy();
      server.closeAllConnections();
      await Promise.allSettled([exited]);
      await new Promise<void>((resolve) => {
        return server.close(() => {
          return resolve();
        });
      });
    });

    const code = await exited;
    expect(code).toBe(0);
    expect(stdout).toContain("Chrome");
    expect(stderr).toBe("");
    expect(tokenStarted).toBe(true);
    expect(tokenRequests).toBe(1);
    await tokenClosed;
    expect(tokenFinished).toBe(false);
  },
);

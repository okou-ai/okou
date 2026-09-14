import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";

let directory: string;
beforeAll(async () => {
  // Keep the SDK external so the child uses the same locked SDK as production.
  directory = await mkdtemp(join(process.cwd(), ".sentry-process-"));
  await build({
    config: false,
    entry: [
      fileURLToPath(
        new URL("../test/fixtures/sentry-process.ts", import.meta.url),
      ),
    ],
    outDir: directory,
    format: ["esm"],
    splitting: false,
    dts: false,
    silent: true,
    external: ["@sentry/node", "commander"],
    define: {
      __CLI_VERSION__: JSON.stringify("0.0.0-test"),
      __DEFAULT_SENTRY_DSN__: JSON.stringify(""),
    },
  });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const eventSchema = z.object({
  tags: z.record(z.string(), z.string()),
  exception: z.object({
    values: z.array(
      z.object({
        type: z.string(),
        value: z.string(),
        stacktrace: z.object({
          frames: z.array(z.object({ filename: z.string() })),
        }),
      }),
    ),
  }),
});

test.each([
  {
    mode: "exception",
    enabled: true,
    exitCode: 1,
    sentinel: "PRIVATE_UNCAUGHT_EXCEPTION_33940",
  },
  {
    mode: "rejection",
    enabled: true,
    exitCode: 0,
    sentinel: "PRIVATE_UNHANDLED_REJECTION_33940",
  },
  {
    mode: "exception",
    enabled: false,
    exitCode: 1,
    sentinel: "PRIVATE_UNCAUGHT_EXCEPTION_33940",
  },
])(
  "preserves real process behavior for $mode with DSN enabled=$enabled",
  async ({ mode, enabled, exitCode, sentinel }) => {
    const envelopes: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        envelopes.push(body);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected a TCP test endpoint");
      const child = spawn(
        process.execPath,
        [join(directory, "sentry-process.js"), mode],
        {
          env: {
            ...process.env,
            SENTRY_DSN: enabled
              ? `http://public@127.0.0.1:${address.port}/1`
              : "",
            SENTRY_ENVIRONMENT: "PRIVATE_ENVIRONMENT_33940",
            SENTRY_TRACE: "33940abc33940abc33940abc33940abc-33940abc33940abc-1",
            SENTRY_BAGGAGE: "sentry-release=PRIVATE_BAGGAGE_33940",
            http_proxy: "",
            https_proxy: "",
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
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(code).toBe(exitCode);
      expect(stdout).toBe("");
      expect(stderr).toContain(sentinel);
      expect(envelopes).toHaveLength(enabled ? 1 : 0);
      for (const envelope of envelopes) {
        expect(envelope).not.toContain("PRIVATE_");
        expect(envelope).not.toContain("33940abc");
        expect(envelope).not.toContain(directory);
        const lines = envelope.split("\n");
        expect(lines).toHaveLength(3);
        const payload: unknown = JSON.parse(lines[2]!);
        expect(payload).not.toHaveProperty("environment");
        const event = eventSchema.parse(payload);
        expect(event.tags).toStrictEqual({
          app: "cli",
          "cli.phase": "command",
          "cli.operation": "probe",
        });
        expect(event.exception.values).toMatchObject([
          { type: "TypeError", value: "TypeError" },
        ]);
        expect(
          event.exception.values[0]!.stacktrace.frames.length,
        ).toBeGreaterThan(0);
        expect(
          event.exception.values[0]!.stacktrace.frames.every((frame) => {
            return frame.filename === "cli.js";
          }),
        ).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  },
);

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { agentLoopCommand } from "../__agent-loop";

const previousExit = process.exitCode;
const entryFixture = fileURLToPath(
  new URL("../../test/fixtures/pi-startup-cli-entry.mjs", import.meta.url),
);

it.each(["__main_loop__", "__agent-loop"])(
  "reports startup phases through %s without changing a failed command",
  async (entry) => {
    const result = await new Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), entryFixture, entry],
        {
          env: {
            ...process.env,
            SENTRY_DSN: "",
            OKOU_RUN_ID: "00000000-0000-4000-8000-000000000123",
            OKOU_PI_PREPARATION_TIMING: "1",
            OKOU_PI_MODEL_CONFIG: "invalid-json",
            OKOU_PI_SESSION_ID: "test-session",
            OKOU_PI_LAUNCH_PAYLOAD_FILE: "/unused-invalid-config-launch.json",
            OKOU_PI_SESSION_ROLE: "parent",
          },
        },
        (error, stdout, stderr) => {
          resolve({
            code: error && typeof error.code === "number" ? error.code : 0,
            stderr,
            stdout,
          });
        },
      );
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "OKOU_PI_MODEL_CONFIG must contain valid JSON",
    );
    const records = result.stderr
      .split("\n")
      .filter((line) => {
        return line.startsWith("{");
      })
      .map((line) => {
        return JSON.parse(line) as Record<string, unknown>;
      });
    expect(
      records.map((record) => {
        return record.phase;
      }),
    ).toEqual(
      expect.arrayContaining([
        "cli_node_bootstrap",
        "cli_initial_imports",
        "cli_instrument",
        "cli_entry_imports",
        "cli_proxy",
        "cli_command_import",
        "cli_config",
      ]),
    );
    for (const record of records) {
      expect(record).toMatchObject({
        type: "pi_preparation_timing",
        runId: "00000000-0000-4000-8000-000000000123",
      });
      expect(record.startedAt).toEqual(expect.any(Number));
      expect(record.finishedAt).toEqual(expect.any(Number));
      expect(record.durationMs).toEqual(expect.any(Number));
      expect(Number.isFinite(record.durationMs)).toBe(true);
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.outcome).toBe(
        record.phase === "cli_config" ? "error" : "success",
      );
    }
  },
);

afterEach(() => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps a failed command terminal when its stderr sink throws", async () => {
  vi.stubEnv("OKOU_RUN_ID", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => {
    throw new Error("PRIVATE_SINK_SENTINEL");
  });
  await expect(
    agentLoopCommand.parseAsync(["node", "okou"]),
  ).resolves.toBeDefined();
  expect(log).toHaveBeenCalledWith(
    "The main loop requires a guest-launched Pi session.",
  );
  expect(process.exitCode).toBe(1);
});

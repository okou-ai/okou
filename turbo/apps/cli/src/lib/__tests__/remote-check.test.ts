import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sshCommand } from "../../commands/ssh";
import { createVncCommand } from "../../commands/vnc";

const helper = vi.hoisted(() => {
  return {
    raw: "",
    code: 0,
    missing: false,
    requests: [] as string[],
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((file: string, args: string[], options: unknown) => {
      expect(file).toBe("/usr/local/bin/runner-rpc-client");
      expect(args).toEqual([]);
      expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
      if (helper.missing)
        return original.spawn("/nonexistent/active-check-helper", [], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      const child = original.spawn(
        process.execPath,
        [
          "-e",
          `
      let request = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => request += chunk);
      process.stdin.on('end', () => {
        process.send(request);
        process.stdout.end(Buffer.from(process.env.CHECK_TEST_REPLY, 'base64'), () => process.exit(Number(process.env.CHECK_TEST_EXIT)));
      });
    `,
        ],
        {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            CHECK_TEST_REPLY: Buffer.from(helper.raw).toString("base64"),
            CHECK_TEST_EXIT: String(helper.code),
          },
        },
      );
      child.on("message", (message: unknown) => {
        if (typeof message === "string") helper.requests.push(message);
      });
      return child;
    }),
  };
});
const connection = "B0000000-0000-4000-8000-000000000001";
const output = vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
function token(capabilities = ["ssh:write", "vnc:write"]) {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", runId: "a0000000-0000-4000-8000-000000000001", capabilities })).toString("base64url")}.signature`,
  );
}
function response(
  status = "passed",
  message = "Runner evidence: authenticated at this time; later operations untested. 诊断 🧭",
) {
  const result = { type: "active_check", status, message };
  helper.raw = JSON.stringify({ type: "result", data: result }) + "\n";
  return result;
}
async function invoke(protocol: "ssh" | "vnc", ...args: string[]) {
  const command = protocol === "ssh" ? sshCommand : createVncCommand();
  const check = command.commands.find((c) => {
    return c.name() === "check";
  });
  for (const option of check?.options ?? [])
    check?.setOptionValue(option.attributeName(), option.defaultValue);
  await command.parseAsync(["check", ...args], { from: "user" });
}
const result = () => {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
};
beforeEach(() => {
  token();
  helper.raw = "";
  helper.code = 0;
  helper.missing = false;
  helper.requests.length = 0;
  output.mockClear();
  vi.mocked(spawn).mockClear();
});
afterEach(() => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
});

it.each(["ssh", "vnc"] as const)(
  "issues exactly one %s check without discovery or replay",
  async (protocol) => {
    const expected = response();
    await invoke(
      protocol,
      connection,
      ...(protocol === "vnc" ? ["--mode", "exclusive"] : []),
      "--json",
    );
    expect(result()).toEqual(expected);
    expect(
      helper.requests.map((raw) => {
        return JSON.parse(raw);
      }),
    ).toEqual([
      {
        version: 1,
        method: `${protocol}.check`,
        params: {
          connectionId: connection.toLowerCase(),
          ...(protocol === "vnc" ? { mode: "exclusive" } : {}),
        },
      },
    ]);
    expect(process.exitCode).toBe(0);
  },
);
it.each(["failed", "blocked"])(
  "preserves %s and returns a nonzero exit",
  async (status) => {
    const expected = response(status);
    await invoke("ssh", connection, "--json");
    expect(result()).toEqual(expected);
    expect(process.exitCode).toBe(1);
  },
);
it("uses the exact same Runner explanation for human output", async () => {
  const expected = response();
  await invoke("ssh", connection);
  expect(output).toHaveBeenCalledWith(expected.message);
});
it.each(["ssh", "vnc"] as const)(
  "rejects read-only %s access before helper IO",
  async (protocol) => {
    token(["ssh:read", "vnc:read"]);
    await expect(
      invoke(
        protocol,
        connection,
        ...(protocol === "vnc" ? ["--mode", "shared"] : []),
      ),
    ).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
  },
);
it("requires a valid UUID and an explicit VNC mode", async () => {
  await expect(invoke("ssh", "bad-id")).rejects.toThrow("CLI exit");
  await expect(invoke("vnc", connection)).rejects.toThrow();
  await expect(
    invoke("vnc", connection, "--mode", "invented"),
  ).rejects.toThrow();
  expect(spawn).not.toHaveBeenCalled();
});
it.each([
  "unknown_status",
  "duplicate",
  "truncated",
  "unsafe",
  "oversized",
  "exit_failure",
])("rejects %s without trusting outcome or leaking text", async (mode) => {
  response(
    mode === "unknown_status" ? "invented" : "passed",
    mode === "oversized"
      ? "secret-canary".repeat(800)
      : mode === "unsafe"
        ? "\u001bsecret-canary"
        : "secret-canary",
  );
  if (mode === "duplicate") helper.raw += helper.raw;
  if (mode === "truncated") helper.raw = helper.raw.trimEnd();
  if (mode === "exit_failure") helper.code = 1;
  await invoke("ssh", connection, "--json");
  expect(result()).toMatchObject({ type: "active_check", status: "blocked" });
  expect(result().message).toContain("protocol");
  expect(JSON.stringify(output.mock.calls)).not.toContain("secret-canary");
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
});
it("surfaces a finite Runner rejection without fallback", async () => {
  helper.raw =
    JSON.stringify({
      type: "error",
      code: "unavailable",
      delivery: "not_dispatched",
    }) + "\n";
  helper.code = 1;
  await invoke("ssh", connection, "--json");
  expect(result()).toMatchObject({ status: "blocked" });
  expect(result().message).toContain("unavailable");
  expect(result().message).toContain("did not dispatch");
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("reports a missing helper without attempting another executable", async () => {
  helper.missing = true;
  await invoke("vnc", connection, "--mode", "shared", "--json");
  expect(result()).toMatchObject({ status: "blocked" });
  expect(result().message).toContain("No check started.");
  expect(spawn).toHaveBeenCalledTimes(1);
});

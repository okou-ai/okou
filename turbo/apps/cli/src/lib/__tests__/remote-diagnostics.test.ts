import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sshCommand } from "../../commands/ssh";
import { createVncCommand } from "../../commands/vnc";

const helper = vi.hoisted(() => {
  return {
    replies: [] as { raw: string; code: number }[],
    requests: [] as string[],
    missing: false,
  };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(
      (file: string, args: string[], options: { stdio: string[] }) => {
        expect(file).toBe("/usr/local/bin/runner-rpc-client");
        expect(args).toEqual([]);
        expect(options).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
        if (helper.missing)
          return original.spawn("/nonexistent/diagnostic-test-helper", [], {
            stdio: ["pipe", "pipe", "pipe"],
          });
        const reply = helper.replies[0];
        if (!reply) throw new Error("Unexpected helper invocation");
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
        process.stdout.end(Buffer.from(process.env.DIAGNOSTIC_TEST_REPLY, 'base64'), () => process.exit(Number(process.env.DIAGNOSTIC_TEST_EXIT)));
      });
    `,
          ],
          {
            stdio: ["pipe", "pipe", "pipe", "ipc"],
            env: {
              ...process.env,
              DIAGNOSTIC_TEST_REPLY: Buffer.from(reply.raw).toString("base64"),
              DIAGNOSTIC_TEST_EXIT: String(reply.code),
            },
          },
        );
        child.on("message", (message: unknown) => {
          if (typeof message === "string") {
            helper.requests.push(message);
            helper.replies.shift();
          }
        });
        return child;
      },
    ),
  };
});

const run = "a0000000-0000-4000-8000-000000000001";
const connection = "b0000000-0000-4000-8000-000000000001";
const attempt = "c0000000-0000-4000-8000-000000000001";
const session = "d0000000-0000-4000-8000-000000000001";
const output = vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});
function token(capabilities = ["ssh:read", "vnc:read"]) {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, runId: run })).toString("base64url")}.signature`,
  );
}
function response(data: unknown) {
  helper.replies.push({
    raw: JSON.stringify({ type: "result", data }) + "\n",
    code: 0,
  });
}
function found(protocol: "ssh" | "vnc") {
  return {
    status: "found",
    message: `Runner explains ${protocol}: SSH dependency rejected the host key; current connectivity has not been checked. 诊断 🧭`,
  };
}
function result(): unknown {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}
async function invoke(protocol: "ssh" | "vnc", ...args: string[]) {
  // SSH registration itself is exercised; create a fresh VNC tree per invocation.
  const command = protocol === "ssh" ? sshCommand : createVncCommand();
  const diagnose = command.commands.find((c) => {
    return c.name() === "diagnose";
  });
  for (const option of diagnose?.options ?? [])
    diagnose?.setOptionValue(option.attributeName(), option.defaultValue);
  await command.parseAsync(["diagnose", ...args], { from: "user" });
}
beforeEach(() => {
  token();
  helper.replies.length = 0;
  helper.requests.length = 0;
  helper.missing = false;
  output.mockClear();
  vi.mocked(spawn).mockClear();
});
afterEach(() => {
  process.exitCode = 0;
  vi.unstubAllEnvs();
});

it.each(["ssh", "vnc"] as const)(
  "reads %s history with exact selectors in one passive request",
  async (protocol) => {
    response(found(protocol));
    await invoke(
      protocol,
      connection,
      "--attempt-id",
      attempt,
      "--session-id",
      session,
      "--json",
    );
    expect(result()).toEqual(found(protocol));
    expect(
      helper.requests.map((raw) => {
        return JSON.parse(raw);
      }),
    ).toEqual([
      {
        version: 1,
        method: `${protocol}.diagnose`,
        params: {
          connectionId: connection,
          attemptId: attempt,
          sessionId: session,
        },
      },
    ]);
    expect(process.exitCode).toBe(0);
  },
);
it("passes arbitrary Runner wording unchanged in human output", async () => {
  response(found("vnc"));
  await invoke("vnc");
  expect(output).toHaveBeenCalledWith(found("vnc").message);
});
it.each(["ssh", "vnc"] as const)(
  "preserves opaque %s authority failure guidance in human and JSON output",
  async (protocol) => {
    const query = {
      status: "authority_unavailable",
      message:
        "Diagnostic history could not be read because the authority lookup timed out. Check API availability and the Runner's API connection. Current connectivity has not been checked.",
    };
    response(query);
    await invoke(protocol);
    expect(output).toHaveBeenLastCalledWith(query.message);
    expect(process.exitCode).toBe(1);
    response(query);
    await invoke(protocol, "--json");
    expect(result()).toEqual(query);
    expect(process.exitCode).toBe(1);
    expect(helper.requests).toHaveLength(2);
  },
);
it.each(["no_failure", "not_retained", "authority_unavailable", "unavailable"])(
  "preserves %s and its explanation without inventing connectivity",
  async (status) => {
    response({
      status,
      message: "Runner's explanation with no known network conclusion.",
    });
    await invoke("ssh", "--json");
    expect(result()).toEqual({
      status,
      message: "Runner's explanation with no known network conclusion.",
    });
    expect(helper.requests).toHaveLength(1);
    expect(process.exitCode).toBe(status === "no_failure" ? 0 : 1);
  },
);
it("reports an RPC rejection without trying business methods", async () => {
  helper.replies.push({
    raw:
      JSON.stringify({
        type: "error",
        code: "invalid_request",
        delivery: "not_dispatched",
      }) + "\n",
    code: 1,
  });
  await invoke("vnc", "--json");
  expect(result()).toMatchObject({
    status: "unavailable",
    reason: "invalid_request",
  });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("reports the unavailable packaged helper", async () => {
  helper.missing = true;
  await invoke("ssh", "--json");
  expect(result()).toMatchObject({
    status: "unavailable",
    reason: "helper_unavailable",
  });
});
it.each([
  "non_text",
  "unknown_status",
  "duplicate",
  "unterminated",
  "oversized",
  "unsafe",
])("rejects %s query envelopes without emitting their text", async (mode) => {
  const query = found("ssh");
  response(
    mode === "non_text"
      ? { status: "found", message: { secret: "secret-canary" } }
      : mode === "unknown_status"
        ? { status: "invented", message: "secret-canary" }
        : mode === "oversized"
          ? { ...query, message: "secret-canary".repeat(800) }
          : mode === "unsafe"
            ? { ...query, message: String.fromCharCode(27) + "secret-canary" }
            : query,
  );
  const reply = helper.replies[0]!;
  if (mode === "duplicate") reply.raw += reply.raw;
  if (mode === "unterminated") reply.raw = reply.raw.trimEnd();
  await invoke("ssh", "--json");
  expect(result()).toMatchObject({ status: "unavailable", reason: "protocol" });
  expect(JSON.stringify(output.mock.calls)).not.toContain("secret-canary");
  expect(helper.requests).toHaveLength(1);
});
it.each(["ssh", "vnc"] as const)(
  "rejects missing %s read authority and malformed selectors before spawning",
  async (protocol) => {
    token([]);
    await expect(invoke(protocol, "--json")).rejects.toThrow("CLI exit");
    token();
    await expect(invoke(protocol, "bad-id", "--json")).rejects.toThrow(
      "CLI exit",
    );
    expect(spawn).not.toHaveBeenCalled();
  },
);

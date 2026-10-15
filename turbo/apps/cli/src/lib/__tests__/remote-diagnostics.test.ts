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
        if (JSON.parse(request).method === 'ssh.diagnostics.capabilities') { process.stdout.end(JSON.stringify({type:'error',code:'unknown_method',delivery:'not_dispatched'})+String.fromCharCode(10),()=>process.exit(1)); return; }
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
          if (
            typeof message === "string" &&
            JSON.parse(message).method !== "ssh.diagnostics.capabilities"
          ) {
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
function capabilities(passive = true) {
  response({ schema_version: 1, passive_query: passive, active_check: false });
}
function report(protocol: "ssh" | "vnc") {
  return {
    schema_version: 1,
    run_id: run,
    assignment_id: run,
    attempt_id: attempt,
    sequence: 1,
    observed_at: "2026-10-15T00:00:00Z",
    protocol,
    connection_id: connection,
    session_id: session,
    configuration_created_at: null,
    configuration_generation: 7,
    operation: "session",
    stage: protocol === "ssh" ? "ssh_operation" : "vnc_operation",
    cause: { source: protocol, code: "disconnected" },
    dependencies: [],
    native: null,
    detail: "not_observed",
    truncated: false,
  };
}
function found(protocol: "ssh" | "vnc") {
  return {
    schema_version: 1,
    status: "found",
    report: report(protocol),
    retention: { capacity: 64, evicted: 80, latest_failure_pinned: true },
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
  "queries %s history with exact selectors using only passive methods",
  async (protocol) => {
    capabilities();
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
      { version: 1, method: "remote.diagnostics.capabilities", params: {} },
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
it("explains nested SSH evidence and unobserved current connectivity in human output", async () => {
  capabilities();
  const query = found("vnc");
  response({
    ...query,
    report: {
      ...query.report,
      dependencies: [
        {
          protocol: "ssh",
          connection_id: run,
          cause: { source: "ssh", code: "host_key_mismatch" },
          configuration_created_at: null,
          configuration_generation: null,
        },
      ],
    },
  });
  await invoke("vnc");
  expect(output).toHaveBeenCalledWith(
    expect.stringContaining("ssh/host_key_mismatch"),
  );
  expect(output).toHaveBeenCalledWith(
    expect.stringContaining("current connectivity has not been checked"),
  );
});
it.each(["no_failure", "not_retained", "authority_unavailable"])(
  "preserves %s without inventing a connectivity result",
  async (status) => {
    capabilities();
    response({ ...found("ssh"), status, report: null });
    await invoke("ssh", "--json");
    expect(result()).toMatchObject({ status, report: null });
    expect(helper.requests).toHaveLength(2);
  },
);
it("stops at disabled capability negotiation", async () => {
  capabilities(false);
  await invoke("ssh", "--json");
  expect(result()).toEqual({ status: "unavailable", reason: "disabled" });
  expect(spawn).toHaveBeenCalledTimes(2);
});
it("reports an old owner without trying business methods", async () => {
  helper.replies.push({
    raw:
      JSON.stringify({
        type: "error",
        code: "unknown_method",
        delivery: "not_dispatched",
      }) + "\n",
    code: 1,
  });
  await invoke("vnc", "--json");
  expect(result()).toEqual({ status: "unavailable", reason: "unsupported" });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("reports the unavailable packaged helper", async () => {
  helper.missing = true;
  await invoke("ssh", "--json");
  expect(result()).toEqual({
    status: "unavailable",
    reason: "helper_unavailable",
  });
});
it.each([
  "foreign_run",
  "wrong_subject",
  "wrong_attempt",
  "wrong_session",
  "unknown_version",
  "raw_text",
  "duplicate",
  "unterminated",
  "oversized",
])("rejects %s without disclosing untrusted response text", async (mode) => {
  capabilities();
  const query = found("ssh");
  if (mode === "foreign_run") query.report.run_id = connection;
  if (mode === "wrong_subject") query.report.connection_id = run;
  if (mode === "wrong_attempt") query.report.attempt_id = run;
  if (mode === "wrong_session") query.report.session_id = run;
  response(
    mode === "unknown_version"
      ? { ...query, schema_version: 2 }
      : mode === "raw_text"
        ? { ...query, provider: "secret-canary" }
        : query,
  );
  const reply = helper.replies[1]!;
  if (mode === "duplicate") reply.raw += reply.raw;
  if (mode === "unterminated") reply.raw = reply.raw.trimEnd();
  if (mode === "oversized") reply.raw = "secret-canary".repeat(3000);
  await invoke(
    "ssh",
    connection,
    "--attempt-id",
    attempt,
    "--session-id",
    session,
    "--json",
  );
  expect(result()).toMatchObject({
    status: "unavailable",
    reason: mode === "unknown_version" ? "unsupported_version" : "protocol",
  });
  expect(JSON.stringify(output.mock.calls)).not.toContain("secret-canary");
  expect(helper.requests).toHaveLength(2);
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createShellCommand } from "../shell";

const base = "http://localhost:3000/api/computer-use";
const session = {
  id: "00000000-0000-4000-8000-000000000001",
  state: "open",
  initialCwd: "/Users/test",
  cwd: "/Users/test/project",
  commandState: "running",
  exitCode: null,
  shellExitCode: null,
  shellExitSignal: null,
  closeReason: null,
  oldestCursor: 0,
  endCursor: 9,
  idleRemainingSeconds: 900,
  cols: 120,
  rows: 40,
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});

beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "sandbox-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  log.mockClear();
  error.mockClear();
});
afterEach(() => {
  return vi.unstubAllEnvs();
});

describe("computer-use shell", () => {
  it("requests access once and returns the trusted approval link without dispatching Shell input", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${base}/shell/authorizations`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          id: session.id,
          status: "pending",
          computerName: "Work Mac",
          requestExpiresAt: "2099-10-20T11:00:00.000Z",
          authorizationUrl: `https://app.okou.ai/computer-use/shell/authorize/${session.id}`,
        });
      }),
    );
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "request-access",
      "--reason",
      "Run project tests",
    ]);
    expect(requests).toStrictEqual([{ reason: "Run project tests" }]);
    expect(log.mock.calls.flat().join("\n")).toContain(
      `https://app.okou.ai/computer-use/shell/authorize/${session.id}`,
    );
    expect(log.mock.calls.flat().join("\n")).toContain("end the current Run");
  });

  it("preserves structured access state in JSON and gives recovery guidance for a rejected command", async () => {
    const approved = {
      id: session.id,
      status: "approved",
      computerName: "Work Mac",
      grantExpiresAt: "2099-10-20T11:00:00.000Z",
    };
    server.use(
      http.post(`${base}/shell/authorizations`, () => {
        return HttpResponse.json(approved);
      }),
      http.post(`${base}/shell/commands`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "SHELL_AUTHORIZATION_REQUIRED",
              message:
                "Run okou computer-use shell request-access --reason <reason>, share its link, and end this Run.",
            },
          },
          { status: 403 },
        );
      }),
    );
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "request-access",
      "--reason",
      "Run tests",
      "--json",
    ]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual(approved);
    await expect(
      createShellCommand().parseAsync(["node", "okou", "cmd", "pwd"]),
    ).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).toContain("request-access");
  });

  it("supports positional status/close and closes all without a session ID", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${base}/shell/commands`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ commandId: "operation", status: "queued" });
      }),
      http.get(`${base}/commands/operation`, () => {
        return HttpResponse.json({
          id: "operation",
          kind: "shell.close",
          status: "succeeded",
          hostId: "host",
          hostName: "Mac",
          payload: {},
          timeoutMs: 25000,
          createdAt: "now",
          claimedAt: null,
          completedAt: null,
          result: { closed: true },
        });
      }),
    );
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "status",
      session.id,
    ]);
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "close",
      session.id,
    ]);
    await createShellCommand().parseAsync(["node", "okou", "close", "--all"]);
    expect(requests).toStrictEqual([
      {
        kind: "shell.status",
        sessionId: session.id,
        waitMs: 10000,
        realtime: true,
      },
      {
        kind: "shell.close",
        sessionId: session.id,
        waitMs: 10000,
        realtime: true,
      },
      { kind: "shell.close", all: true, waitMs: 10000, realtime: true },
    ]);
  });
  it("does not retry uncertain input submission and provides recovery guidance", async () => {
    let submissions = 0;
    server.use(
      http.post(`${base}/shell/commands`, () => {
        submissions++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(
      createShellCommand().parseAsync(["node", "okou", "cmd", "echo once"]),
    ).rejects.toThrow("process.exit called");
    expect(submissions).toBe(1);
    expect(error.mock.calls.flat().join("\n")).toContain("Do not replay input");
  });
  it("submits one operation, retains running state and escapes terminal output in JSON", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${base}/shell/commands`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ commandId: "operation", status: "queued" });
      }),
      http.get(`${base}/commands/operation`, () => {
        return HttpResponse.json({
          id: "operation",
          kind: "shell.cmd",
          status: "succeeded",
          hostId: "host",
          hostName: "Mac",
          payload: {},
          timeoutMs: 25000,
          createdAt: "2026-10-15T00:00:00Z",
          claimedAt: null,
          completedAt: null,
          result: {
            session,
            outputBase64: Buffer.from("hello\u001b[31m\u0007").toString(
              "base64",
            ),
            nextCursor: 9,
            lostBytes: 0,
            moreAvailable: false,
            reason: "wait_elapsed",
          },
        });
      }),
    );
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "cmd",
      "sleep 60",
      "--json",
    ]);
    expect(requests).toStrictEqual([
      { kind: "shell.cmd", command: "sleep 60", waitMs: 10000, realtime: true },
    ]);
    const printed = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(printed)).toMatchObject({
      session: { commandState: "running" },
      reason: "wait_elapsed",
      nextCursor: 9,
    });
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("\u0007");
  });
  it("observes without resending a command and preserves exact interactive input", async () => {
    const requests: unknown[] = [];
    server.use(
      http.post(`${base}/shell/commands`, async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({ commandId: "operation", status: "queued" });
      }),
      http.get(`${base}/commands/operation`, () => {
        return HttpResponse.json({
          id: "operation",
          kind: "shell.cmd",
          status: "succeeded",
          hostId: "host",
          hostName: "Mac",
          payload: {},
          timeoutMs: 25000,
          createdAt: "now",
          claimedAt: null,
          completedAt: null,
          result: { session },
        });
      }),
    );
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "cmd",
      "--session",
      session.id,
      "--cursor",
      "9",
    ]);
    await createShellCommand().parseAsync([
      "node",
      "okou",
      "cmd",
      "--session",
      session.id,
      "--input",
      "yes\n",
    ]);
    expect(requests).toStrictEqual([
      {
        kind: "shell.cmd",
        sessionId: session.id,
        cursor: 9,
        waitMs: 10000,
        realtime: true,
      },
      {
        kind: "shell.cmd",
        sessionId: session.id,
        input: "yes\n",
        waitMs: 10000,
        realtime: true,
      },
    ]);
  });
  it.each([
    ["cmd", "echo bad", "--input", "bad"],
    ["cmd", "--wait", "1x"],
    ["cmd", "echo bad", "--wait", "31"],
    ["cmd", "--new"],
    ["close"],
    ["close", session.id, "--all"],
  ])("rejects invalid options before submitting %j", async (...args) => {
    await expect(
      createShellCommand().parseAsync(["node", "okou", ...args]),
    ).rejects.toThrow("process.exit called");
    expect(error).toHaveBeenCalled();
  });
});

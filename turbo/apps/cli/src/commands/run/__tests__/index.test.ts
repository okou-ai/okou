import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../index";

const helper = vi.hoisted(() => {
  return { response: "", exit: 0, requests: [] as string[] };
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
        const script = `
          let request = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', chunk => request += chunk);
          process.stdin.on('end', () => {
            process.send(request);
            process.stdout.end(Buffer.from(process.env.RUN_USAGE_RESPONSE, 'base64'), () => process.exit(Number(process.env.RUN_USAGE_EXIT)));
          });
        `;
        const child = original.spawn(process.execPath, ["-e", script], {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            RUN_USAGE_RESPONSE: Buffer.from(helper.response).toString("base64"),
            RUN_USAGE_EXIT: String(helper.exit),
          },
        });
        child.on("message", (message: unknown) => {
          if (typeof message === "string") helper.requests.push(message);
        });
        return child;
      },
    ),
  };
});

const runId = "a0000000-0000-4000-8000-000000000001";
const complete = {
  schemaVersion: 1,
  runId,
  combined: {
    state: "observed",
    coverage: "complete",
    observedTokens: {
      input: 11,
      cacheRead: 22,
      cacheCreation: 33,
      output: 44,
      total: 110,
    },
  },
  sources: {
    apiFirstTurn: {
      state: "observed",
      sampledAt: 0,
      coverage: "complete",
      tokens: {
        input: 1,
        cacheRead: 2,
        cacheCreation: 3,
        output: 4,
        total: 10,
      },
    },
    sandboxProxy: {
      state: "observed",
      sampledAtMs: 1,
      revision: 2,
      coverage: "complete",
      reasons: [],
      observedResponses: 1,
      outstandingResponses: 0,
      tokens: {
        input: 10,
        cacheRead: 20,
        cacheCreation: 30,
        output: 40,
        total: 100,
      },
    },
  },
};
const partialZero = {
  schemaVersion: 1,
  runId,
  combined: {
    state: "observed",
    coverage: "partial",
    observedTokens: {
      input: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      total: 0,
    },
  },
  sources: {
    apiFirstTurn: { state: "no-inference", sampledAt: 0 },
    sandboxProxy: { state: "unavailable", reason: "launch-unavailable" },
  },
};

function token(capabilities = ["run-usage:read"]) {
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities, userId: "owner", orgId: "org", runId })).toString("base64url")}.signature`,
  );
}

function response(...messages: unknown[]) {
  helper.response =
    messages
      .map((message) => {
        return JSON.stringify(message);
      })
      .join("\n") + "\n";
}

async function invoke(json = true) {
  await runCommand.parseAsync(json ? ["usage", "--json"] : ["usage"], {
    from: "user",
  });
}

const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((): never => {
  throw new Error("CLI exit");
});

function jsonOutput(): unknown {
  return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
}

beforeEach(() => {
  token();
  helper.requests.length = 0;
  helper.exit = 0;
  response({ type: "result", data: complete });
  vi.mocked(spawn).mockClear();
  for (const option of runCommand.commands[0]?.options ?? []) {
    option.defaultValue = undefined;
    runCommand.commands[0]?.setOptionValue(option.attributeName(), undefined);
  }
});

afterEach(() => {
  process.exitCode = 0;
  output.mockClear();
  errors.mockClear();
  vi.unstubAllEnvs();
});

describe("okou run usage", () => {
  it("queries the assigned Run once and prints the strict JSON success outcome", async () => {
    await invoke();
    expect(
      helper.requests.map((request) => {
        return JSON.parse(request);
      }),
    ).toEqual([{ version: 1, method: "run.usage", params: {} }]);
    expect(jsonOutput()).toEqual({
      schemaVersion: 1,
      status: "ok",
      usage: complete,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).not.toBe(1);
  });

  it("labels partial zero as a lower bound and preserves source distinctions", async () => {
    response({ type: "result", data: partialZero });
    await invoke(false);
    const text = output.mock.calls
      .map((call) => {
        return String(call[0]);
      })
      .join("\n");
    expect(text).toContain("partial; lower bounds");
    expect(text).toContain("Total: 0+");
    expect(text).toContain("API first turn: no inference");
    expect(text).toContain("Sandbox proxy: unavailable (launch-unavailable)");
    expect(process.exitCode).not.toBe(1);
  });

  it.each([
    ["unknown_method", "unsupported-runner"],
    ["unavailable", "feature-unavailable"],
    ["resource_exhausted", "busy"],
    ["timed_out", "timed-out"],
    ["protocol", "invalid-response"],
    ["transport", "transport"],
  ] as const)("maps Runner %s without fallback", async (code, kind) => {
    helper.exit = 1;
    response({ type: "error", code, delivery: "not_dispatched" });
    await invoke();
    expect(jsonOutput()).toEqual({
      schemaVersion: 1,
      status: "error",
      error: { kind, delivery: "not-dispatched" },
    });
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("accepts unavailable and overflow as truthful business results", async () => {
    const unavailable = {
      schemaVersion: 1,
      runId,
      combined: { state: "unavailable", reason: "no-observation" },
      sources: {
        apiFirstTurn: { state: "unavailable", reason: "missing-handoff" },
        sandboxProxy: { state: "unavailable", reason: "not-observed" },
      },
    };
    response({ type: "result", data: unavailable });
    await invoke();
    expect(jsonOutput()).toMatchObject({
      status: "ok",
      usage: { combined: { state: "unavailable" } },
    });
    expect(process.exitCode).not.toBe(1);

    const maximum = Number.MAX_SAFE_INTEGER;
    const overflow = {
      schemaVersion: 1,
      runId,
      combined: { state: "overflow", coverage: "partial" },
      sources: {
        apiFirstTurn: {
          state: "observed",
          sampledAt: 0,
          coverage: "complete",
          tokens: {
            input: maximum,
            cacheRead: maximum,
            cacheCreation: maximum,
            output: maximum,
            total: null,
          },
        },
        sandboxProxy: { state: "unavailable", reason: "not-observed" },
      },
    };
    response({ type: "result", data: overflow });
    await invoke();
    expect(jsonOutput()).toMatchObject({
      status: "ok",
      usage: { combined: { state: "overflow" } },
    });
    expect(process.exitCode).not.toBe(1);
  });

  it.each([
    [{ type: "event", data: {} }],
    [
      { type: "result", data: complete },
      { type: "result", data: complete },
    ],
    [{ type: "result", data: { ...complete, future: true } }],
    [
      {
        type: "result",
        data: {
          ...complete,
          combined: {
            ...complete.combined,
            observedTokens: { ...complete.combined.observedTokens, total: 109 },
          },
        },
      },
    ],
  ])("rejects malformed helper output without replay", async (...messages) => {
    response(...messages);
    await invoke();
    expect(jsonOutput()).toEqual({
      schemaVersion: 1,
      status: "error",
      error: { kind: "invalid-response", delivery: "unknown" },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("rejects direct execution without the rollout capability before dispatch", async () => {
    token(["billing:read", "ssh:read"]);
    await expect(invoke()).rejects.toThrow("CLI exit");
    expect(spawn).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("run-usage:read"),
    );
  });
});

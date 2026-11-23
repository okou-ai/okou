import { http, HttpResponse } from "msw";
import { beforeEach, expect, it, vi } from "vitest";
import { MCP_RUNNER_BINDING_REQUIRED } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  listRunMcpConnectors,
  reauthorizeRunMcpConnectorOAuth,
} from "../api/domains/connectors";
import { runMcpConnector } from "../../commands/__tests__/helpers/custom-connectors";
import { server } from "../../mocks/server";

const helper = vi.hoisted(() => {
  return { reply: "", requests: [] as string[] };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((file: string) => {
      expect(file).toBe("/usr/local/bin/runner-rpc-client");
      const child = original.spawn(
        process.execPath,
        [
          "-e",
          `
        let request = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => request += chunk);
        process.stdin.on('end', () => {
          process.send(request);
          process.stdout.end(process.env.MCP_TEST_REPLY);
          process.disconnect();
        });
      `,
        ],
        {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: { ...process.env, MCP_TEST_REPLY: helper.reply },
        },
      );
      child.on("message", (message: unknown) => {
        if (typeof message === "string") helper.requests.push(message);
      });
      return child;
    }),
  };
});

const api = "https://api.mcp-test.example";
const token = "test-run-credential";
const runnerRequired = () => {
  return HttpResponse.json(
    {
      error: {
        code: MCP_RUNNER_BINDING_REQUIRED,
        message: "Use this Run's Runner",
      },
    },
    { status: 409 },
  );
};

function respond(status: number, body: unknown) {
  const bytes = Buffer.from(JSON.stringify({ status, body }));
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += 16 * 1024) {
    lines.push(
      JSON.stringify({
        type: "event",
        data: bytes.subarray(start, start + 16 * 1024).toString("base64"),
      }),
    );
  }
  lines.push(JSON.stringify({ type: "result", data: null }));
  helper.reply = `${lines.join("\n")}\n`;
}

beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", api);
  vi.stubEnv("OKOU_TOKEN", token);
  helper.requests.length = 0;
});

it("lists a published inventory that spans multiple Runner frames", async () => {
  const connectors = Array.from({ length: 80 }, (_, index) => {
    return runMcpConnector({
      displayName: `已发布的账号 ${index} ${"语".repeat(100)}`,
    });
  });
  server.use(http.get(`${api}/api/mcp-connectors`, runnerRequired));
  respond(200, { kind: "list", connectors });

  await expect(listRunMcpConnectors()).resolves.toStrictEqual(connectors);
  expect(
    helper.requests.map((raw) => {
      return JSON.parse(raw);
    }),
  ).toStrictEqual([
    {
      version: 1,
      method: "connector.mcp.resolve",
      params: { authorization: `Bearer ${token}`, request: { kind: "list" } },
    },
  ]);
});

it("reports a stale published account during reauthorization", async () => {
  const connector = runMcpConnector();
  server.use(
    http.post(`${api}/api/mcp-connectors/oauth2/reauthorize`, runnerRequired),
  );
  respond(409, {
    error: { code: "CONFLICT", message: "Connector account changed" },
  });

  await expect(
    reauthorizeRunMcpConnectorOAuth(
      connector.target,
      connector.connectionId,
      ["read"],
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({
    status: 409,
    code: "CONFLICT",
    message: "Connector account changed",
  });
  expect(
    helper.requests.map((raw) => {
      return JSON.parse(raw);
    }),
  ).toStrictEqual([
    {
      version: 1,
      method: "connector.mcp.resolve",
      params: {
        authorization: `Bearer ${token}`,
        request: {
          kind: "reauthorize",
          target: connector.target,
          expectedConnectionId: connector.connectionId,
          scopes: ["read"],
        },
      },
    },
  ]);
});

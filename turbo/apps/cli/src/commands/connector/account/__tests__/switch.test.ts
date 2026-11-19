import { spawn } from "node:child_process";
import { http, HttpResponse } from "msw";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../../mocks/server";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalog,
} from "../../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { stubRunConnectorAccountInventory } from "../../../__tests__/helpers/run-connector-accounts";
import { switchConnectorAccountCommand } from "../switch";
import { connectorAccountSelectionSchema } from "@okouai/api-contracts/contracts/connector-accounts";

const transport = vi.hoisted(() => {
  return {
    response: "",
    exit: 0,
    requests: [] as string[],
  };
});
vi.mock("node:child_process", async (originalImport) => {
  const original = await originalImport<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((file: string) => {
      expect(file).toBe("/usr/local/bin/runner-rpc-client");
      const child = original.spawn(
        process.execPath,
        [
          "-e",
          `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{process.send(input);process.stdout.end(Buffer.from(process.env.CONNECTOR_SWITCH_REPLY,'base64'),()=>process.exit(Number(process.env.CONNECTOR_SWITCH_EXIT)));});`,
        ],
        {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            CONNECTOR_SWITCH_REPLY: Buffer.from(transport.response).toString(
              "base64",
            ),
            CONNECTOR_SWITCH_EXIT: String(transport.exit),
          },
        },
      );
      child.on("message", (value: unknown) => {
        if (typeof value === "string") transport.requests.push(value);
      });
      return child;
    }),
  };
});
const connectionId = "11111111-1111-4111-8111-111111111111";
const target = { kind: "builtin", connectorSlug: "github" } as const;
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
let selected: unknown[] = [];
beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_AGENT_ID", "agent-1");
  vi.stubEnv(
    "OKOU_TOKEN",
    `vm0_sandbox_e30.${Buffer.from(JSON.stringify({ scope: "okou", capabilities: ["connector-account:switch"] })).toString("base64url")}.signature`,
  );
  transport.requests = [];
  transport.exit = 0;
  transport.response = `${JSON.stringify({ type: "result", data: { connectionId } })}\n`;
  selected = [];
  process.exitCode = 0;
  vi.spyOn(process, "exit").mockImplementation((code) => {
    process.exitCode = code ?? undefined;
    throw new Error("exit");
  });
  log.mockClear();
  error.mockClear();
  switchConnectorAccountCommand.setOptionValue("json", false);
  server.use(
    stubConnectorCatalog([
      catalogStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        authMethods: [authCodeMethod("oauth")],
      }),
    ]),
    stubCustomConnectors([]),
    stubRunConnectorAccountInventory({
      accounts: [
        {
          target,
          connectionId,
          displayName: "Work",
          enabled: true,
          isCurrent: false,
          isDefault: false,
        },
      ],
    }),
    http.put(
      "http://localhost:3000/api/run/connector-accounts/current",
      async ({ request }) => {
        const body = connectorAccountSelectionSchema.parse(
          await request.json(),
        );
        selected.push(body);
        return HttpResponse.json(body);
      },
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = 0;
});
const run = (selector = "github") => {
  return switchConnectorAccountCommand.parseAsync([
    "node",
    "okou",
    selector,
    "--connection-id",
    connectionId,
    "--json",
  ]);
};
describe("connector account switch", () => {
  it("saves an allowed exact selection and reports success only after the assignment RPC acknowledges that account", async () => {
    await run();
    expect(selected).toStrictEqual([{ target, connectionId }]);
    expect(
      transport.requests.map((request) => {
        return JSON.parse(request);
      }),
    ).toStrictEqual([
      {
        version: 1,
        method: "connector.account.sync",
        params: { target, connectionId },
      },
    ]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toStrictEqual({
      target,
      connectionId,
      context: "run",
      selected: true,
    });
  });
  it("gives an exact approval command when a custom display name resolves to a disabled account", async () => {
    const connector = customConnector();
    server.use(
      stubCustomConnectors([connector]),
      stubRunConnectorAccountInventory({
        accounts: [
          {
            target: { kind: "custom", customConnectorId: connector.id },
            connectionId,
            displayName: "Work",
            enabled: false,
            isCurrent: false,
            isDefault: false,
          },
        ],
      }),
    );
    await expect(run(connector.displayName)).rejects.toThrow("exit");
    expect(process.exitCode).toBe(1);
    expect(selected).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain(
      `okou connector account switch-request custom:${connector.id} --connection-id ${connectionId} --callback-prompt "<prompt>"`,
    );
  });
  it("does not claim success or replay when publication is unconfirmed", async () => {
    transport.response = `${JSON.stringify({ type: "error", code: "unavailable", delivery: "unknown" })}\n`;
    transport.exit = 1;
    await expect(run()).rejects.toThrow("exit");
    expect(selected).toHaveLength(1);
    expect(transport.requests).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain("not confirmed");
  });
  it("does not dispatch when the Run account API rejects the token", async () => {
    server.use(
      http.get("http://localhost:3000/api/run/connector-accounts", () => {
        return HttpResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Missing required capability: connector-account:switch",
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(run()).rejects.toThrow("exit");
    expect(selected).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
    expect(error.mock.calls.flat().join(" ")).toContain(
      "Missing required capability",
    );
    expect(process.exitCode).toBe(1);
  });
});

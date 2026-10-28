import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import { customConnectorCommand } from "../custom";
import { listCommand } from "../list";
import { permissionRequestCommand } from "../permission-request";
import { searchCommand } from "../search";
import { statusCommand } from "../status";

const RUN_AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_AGENT_ID = "550e8400-e29b-41d4-a716-446655440099";
const CUSTOM_CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

const commandCases = [
  { name: "list", command: listCommand, args: [] },
  { name: "status", command: statusCommand, args: ["github"] },
  { name: "search", command: searchCommand, args: ["github"] },
  { name: "list JSON", command: listCommand, args: ["--json"] },
  {
    name: "status JSON",
    command: statusCommand,
    args: ["github", "--json"],
  },
  {
    name: "search JSON",
    command: searchCommand,
    args: ["github", "--json"],
  },
  {
    name: "custom list JSON",
    command: customConnectorCommand,
    args: ["list", "--json"],
  },
  {
    name: "custom status JSON",
    command: customConnectorCommand,
    args: ["status", CUSTOM_CONNECTOR_ID, "--json"],
  },
  { name: "custom list", command: customConnectorCommand, args: ["list"] },
  {
    name: "custom status",
    command: customConnectorCommand,
    args: ["status", CUSTOM_CONNECTOR_ID],
  },
  {
    name: "custom status by slug",
    command: customConnectorCommand,
    args: ["status", "_acme-search"],
  },
  {
    name: "builtin permission-request",
    command: permissionRequestCommand,
    args: [
      "github",
      "--permission",
      "contents:read",
      "--url",
      "https://api.github.com/repos/okou-ai/okou",
    ],
  },
  {
    name: "custom permission-request",
    command: permissionRequestCommand,
    args: [`custom:${CUSTOM_CONNECTOR_ID}`, "--permission", "items:read"],
  },
  {
    name: "browser permission-request",
    command: permissionRequestCommand,
    args: ["browser", "--permission", "browser:write"],
  },
  {
    name: "computer-use permission-request",
    command: permissionRequestCommand,
    args: ["computer-use", "--permission", "computer-use:write"],
  },
];

describe("run-bound connector Agent selectors", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });
  let requests: string[];

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_AGENT_ID", RUN_AGENT_ID);
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "thread-1");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", undefined);
    for (const { command } of commandCases) {
      command.setOptionValue("agent", undefined);
      command.setOptionValue("json", false);
    }
    for (const command of customConnectorCommand.commands) {
      command.setOptionValue("agent", undefined);
      command.setOptionValue("json", false);
    }
    requests = [];
    server.use(
      http.all("*", ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json(
          { error: "Unexpected request" },
          { status: 500 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(commandCases)(
    "$name rejects another Agent before requests or authorization output",
    async ({ command, args }) => {
      await expect(
        command.parseAsync([
          "node",
          "okou",
          ...args,
          "--agent",
          OTHER_AGENT_ID,
        ]),
      ).rejects.toThrow("process.exit called");

      const error = consoleError.mock.calls.flat().join("\n");
      expect(error).toContain(`--agent ${OTHER_AGENT_ID}`);
      expect(error).toContain(`current run's Agent ${RUN_AGENT_ID}`);
      expect(error).toContain(`Remove --agent or use --agent ${RUN_AGENT_ID}`);
      expect(exit).toHaveBeenCalledWith(1);
      expect(consoleLog).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
    },
  );

  it("rejects an explicitly empty Agent selector during a run", async () => {
    await expect(
      listCommand.parseAsync(["node", "okou", "--agent", ""]),
    ).rejects.toThrow("process.exit called");

    expect(consoleError.mock.calls.flat().join("\n")).toContain(
      `Remove --agent or use --agent ${RUN_AGENT_ID}`,
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});

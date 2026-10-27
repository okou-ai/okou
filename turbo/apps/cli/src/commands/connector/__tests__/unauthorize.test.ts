import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  catalogStatusItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import {
  customMcpConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { unauthorizeCommand } from "../unauthorize";

const API = "http://localhost:3000";
const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_AGENT_ID = "550e8400-e29b-41d4-a716-446655440099";

function agentResponse(agentId: string) {
  return {
    agentId,
    isDefaultAgent: false,
    ownerId: "user-1",
    description: null,
    displayName: "Research",
    sound: null,
    avatarUrl: null,
    visibility: "private",
  };
}

function stubAgent(agentId = AGENT_ID) {
  return http.get(`${API}/api/agents/${agentId}`, () => {
    return HttpResponse.json(agentResponse(agentId));
  });
}

describe("connector unauthorize", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit called");
  });

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", API);
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    unauthorizeCommand.setOptionValue("agent", undefined);
    unauthorizeCommand.setOptionValue("json", undefined);
    server.use(
      stubConnectorCatalog([
        catalogStatusItem({ connectorSlug: "querit", label: "Querit" }),
      ]),
      stubCustomConnectors([customMcpConnector()]),
      stubAgent(),
    );
  });

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
  });

  it("removes a builtin connector from the current run's Agent without an approval link", async () => {
    let enabled = ["querit", "github"];
    const updates: unknown[] = [];
    server.use(
      http.get(`${API}/api/agents/${AGENT_ID}/user-connectors`, () => {
        return HttpResponse.json({ enabledConnectorSlugs: enabled });
      }),
      http.put(
        `${API}/api/agents/${AGENT_ID}/user-connectors`,
        async ({ request }) => {
          updates.push(await request.json());
          enabled = ["github"];
          return HttpResponse.json({ enabledConnectorSlugs: enabled });
        },
      ),
    );

    await unauthorizeCommand.parseAsync(["node", "okou", "querit"]);

    expect(updates).toEqual([
      { enabledConnectorSlugs: ["querit"], operation: "remove" },
    ]);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain(
      "✓ Unauthorized Querit (querit) for Agent Research",
    );
    expect(output).toContain("New runs no longer receive this connector");
    expect(output).not.toContain("http");
  });

  it("removes a custom connector grant by display name and prints JSON", async () => {
    const connector = customMcpConnector();
    const updates: unknown[] = [];
    server.use(
      http.get(`${API}/api/agents/${AGENT_ID}/custom-connectors`, () => {
        return HttpResponse.json({
          grants: [{ customConnectorId: connector.id, permissionNames: [] }],
        });
      }),
      http.put(
        `${API}/api/agents/${AGENT_ID}/custom-connectors`,
        async ({ request }) => {
          updates.push(await request.json());
          return HttpResponse.json({ grants: [] });
        },
      ),
    );

    await unauthorizeCommand.parseAsync([
      "node",
      "okou",
      connector.displayName,
      "--json",
    ]);

    expect(updates).toEqual([
      {
        grants: [{ customConnectorId: connector.id, permissionNames: [] }],
        operation: "remove",
      },
    ]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      agentId: AGENT_ID,
      connector: {
        kind: "custom",
        customConnectorId: connector.id,
        slug: connector.slug,
      },
      result: "unauthorized",
    });
  });

  it("reports a connector that is not authorized without writing", async () => {
    let writes = 0;
    server.use(
      http.get(`${API}/api/agents/${AGENT_ID}/user-connectors`, () => {
        return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
      }),
      http.put(`${API}/api/agents/${AGENT_ID}/user-connectors`, () => {
        writes += 1;
        return HttpResponse.json({ enabledConnectorSlugs: ["github"] });
      }),
    );

    await unauthorizeCommand.parseAsync(["node", "okou", "querit"]);

    expect(writes).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toBe(
      "Querit (querit) is not authorized for Agent Research. Nothing changed.",
    );
  });

  it("fails when the connector remains authorized after removal", async () => {
    server.use(
      http.get(`${API}/api/agents/${AGENT_ID}/user-connectors`, () => {
        return HttpResponse.json({ enabledConnectorSlugs: ["querit"] });
      }),
      http.put(`${API}/api/agents/${AGENT_ID}/user-connectors`, () => {
        return HttpResponse.json({ enabledConnectorSlugs: ["querit"] });
      }),
    );

    await expect(
      unauthorizeCommand.parseAsync(["node", "okou", "querit"]),
    ).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      `Querit is still authorized for Agent ${AGENT_ID}`,
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("requires --agent outside a run before any request", async () => {
    vi.stubEnv("OKOU_AGENT_ID", undefined);
    const requests: string[] = [];
    server.use(
      http.all("*", ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({ error: "Unexpected" }, { status: 500 });
      }),
    );

    await expect(
      unauthorizeCommand.parseAsync(["node", "okou", "querit"]),
    ).rejects.toThrow("process.exit called");

    expect(error.mock.calls.flat().join("\n")).toContain(
      "Specify the Agent with --agent <id>",
    );
    expect(requests).toEqual([]);
  });

  it("narrows the selected Agent outside a run", async () => {
    vi.stubEnv("OKOU_AGENT_ID", undefined);
    const updates: unknown[] = [];
    server.use(
      stubAgent(OTHER_AGENT_ID),
      http.get(`${API}/api/agents/${OTHER_AGENT_ID}/user-connectors`, () => {
        return HttpResponse.json({ enabledConnectorSlugs: ["querit"] });
      }),
      http.put(
        `${API}/api/agents/${OTHER_AGENT_ID}/user-connectors`,
        async ({ request }) => {
          updates.push(await request.json());
          return HttpResponse.json({ enabledConnectorSlugs: [] });
        },
      ),
    );

    await unauthorizeCommand.parseAsync([
      "node",
      "okou",
      "builtin:querit",
      "--agent",
      OTHER_AGENT_ID,
    ]);

    expect(updates).toEqual([
      { enabledConnectorSlugs: ["querit"], operation: "remove" },
    ]);
  });
});

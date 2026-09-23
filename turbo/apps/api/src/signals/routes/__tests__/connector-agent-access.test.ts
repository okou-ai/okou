import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { connectorAgentAccessContract } from "@okouai/api-contracts/contracts/connector-agent-access";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentsRoutes } from "../agents";
import { connectorAgentAccessRoutes } from "../connector-agent-access";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

describe("GET /api/connectors/agent-access", () => {
  it("returns current-user grants for visible agents in bulk and by connector", async () => {
    const routes = [...agentsRoutes, ...connectorAgentAccessRoutes];
    const headers = { authorization: "Bearer clerk-session" };
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});
    const agents = setupApp({ context, routes })(agentsMainContract);
    const grants = setupApp({ context, routes })(userBuiltinConnectorsContract);
    const access = setupApp({ context, routes })(connectorAgentAccessContract);

    const first = await accept(agents.create({ headers, body: {} }), [201]);
    const second = await accept(agents.create({ headers, body: {} }), [201]);
    await accept(
      grants.update({
        params: { id: first.body.agentId },
        body: { enabledConnectorSlugs: ["github", "slack"] },
        headers,
      }),
      [200],
    );
    await accept(
      grants.update({
        params: { id: second.body.agentId },
        body: { enabledConnectorSlugs: ["github"] },
        headers,
      }),
      [200],
    );

    const all = await accept(access.get({ query: {}, headers }), [200]);
    expect(new Set(all.body.visibleAgentIds)).toStrictEqual(
      new Set([first.body.agentId, second.body.agentId]),
    );
    expect(all.body.custom).toStrictEqual([]);
    expect(
      new Set(
        all.body.builtin.map((edge) => {
          return `${edge.connectorSlug}:${edge.agentId}`;
        }),
      ),
    ).toStrictEqual(
      new Set([
        `github:${first.body.agentId}`,
        `slack:${first.body.agentId}`,
        `github:${second.body.agentId}`,
      ]),
    );

    const github = await accept(
      access.get({ query: { builtinSlug: "github" }, headers }),
      [200],
    );
    expect(
      new Set(
        github.body.builtin.map((edge) => {
          return edge.agentId;
        }),
      ),
    ).toStrictEqual(new Set([first.body.agentId, second.body.agentId]));
    expect(github.body.custom).toStrictEqual([]);

    mocks.clerk.session(`user_${randomUUID()}`, orgId);
    const hidden = await accept(
      agents.create({ headers, body: { visibility: "private" } }),
      [201],
    );
    await accept(
      grants.update({
        params: { id: hidden.body.agentId },
        body: { enabledConnectorSlugs: ["github"] },
        headers,
      }),
      [200],
    );
    mocks.clerk.session(userId, orgId);
    const visible = await accept(
      access.get({ query: { builtinSlug: "github" }, headers }),
      [200],
    );
    expect(new Set(visible.body.visibleAgentIds)).toStrictEqual(
      new Set([first.body.agentId, second.body.agentId]),
    );
    expect(
      new Set(
        visible.body.builtin.map((edge) => {
          return edge.agentId;
        }),
      ),
    ).toStrictEqual(new Set([first.body.agentId, second.body.agentId]));
  });

  it("rejects an ambiguous filter", async () => {
    const routes = [...agentsRoutes, ...connectorAgentAccessRoutes];
    const headers = { authorization: "Bearer clerk-session" };
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const access = setupApp({ context, routes })(connectorAgentAccessContract);
    const response = await accept(
      access.get({
        query: { builtinSlug: "github", customConnectorId: randomUUID() },
        headers,
      }),
      [400],
    );
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns custom grants with selected permissions and filters by connector", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, { visibility: "private" });
    const first = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "First bulk connector",
        slug: "_bulk-first",
        prefixTemplates: ["https://bulk-first.example.test"],
        permissionBundleRef: "builtin:slack@1",
      }),
    );
    const second = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        displayName: "Second bulk connector",
        slug: "_bulk-second",
        prefixTemplates: ["https://bulk-second.example.test"],
        permissionBundleRef: "builtin:slack@1",
      }),
    );
    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      [
        { customConnectorId: first.id, permissionNames: ["chat:write"] },
        { customConnectorId: second.id, permissionNames: [] },
      ],
      [200],
    );
    mocks.clerk.session(actor.userId, actor.orgId);
    const access = setupApp({ context, routes: connectorAgentAccessRoutes })(
      connectorAgentAccessContract,
    );
    const headers = { authorization: "Bearer clerk-session" };
    const all = await accept(access.get({ query: {}, headers }), [200]);
    expect(all.body.custom).toContainEqual({
      agentId: agent.agentId,
      connectorId: first.id,
      permissionNames: ["chat:write"],
    });
    expect(all.body.custom).toContainEqual({
      agentId: agent.agentId,
      connectorId: second.id,
      permissionNames: [],
    });

    const filtered = await accept(
      access.get({ query: { customConnectorId: first.id }, headers }),
      [200],
    );
    expect(filtered.body.builtin).toStrictEqual([]);
    expect(filtered.body.custom).toStrictEqual([
      {
        agentId: agent.agentId,
        connectorId: first.id,
        permissionNames: ["chat:write"],
      },
    ]);
  });

  it("requires authentication", async () => {
    const access = setupApp({ context, routes: connectorAgentAccessRoutes })(
      connectorAgentAccessContract,
    );
    const response = await accept(
      access.get({ query: {}, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});

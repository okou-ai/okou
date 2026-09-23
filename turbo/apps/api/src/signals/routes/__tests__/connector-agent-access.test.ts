import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { connectorAgentAccessContract } from "@okouai/api-contracts/contracts/connector-agent-access";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { overrideCanonicalAgentAuthorityFixture } from "../../../test-fixtures/canonical-agent-authority";
import { agentsRoutes } from "../agents";
import { connectorAgentAccessRoutes } from "../connector-agent-access";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext({ connectorCatalog: true });
const mocks = createRouteMocks(context);

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

    await overrideCanonicalAgentAuthorityFixture({
      agentId: second.body.agentId,
      override: {
        owner: `user_${randomUUID()}`,
        visibility: "private",
        displayName: "Hidden Agent",
        updatedAt: new Date("2099-01-01T00:00:00.000Z"),
      },
      signal: context.signal,
    });
    const visible = await accept(
      access.get({ query: { builtinSlug: "github" }, headers }),
      [200],
    );
    expect(visible.body.visibleAgentIds).toStrictEqual([first.body.agentId]);
    expect(visible.body.builtin).toStrictEqual([
      { connectorSlug: "github", agentId: first.body.agentId },
    ]);
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
});

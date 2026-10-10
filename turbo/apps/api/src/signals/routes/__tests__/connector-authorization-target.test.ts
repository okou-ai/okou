import {
  agentsMainContract,
  type AgentRequest,
} from "@okouai/api-contracts/contracts/agents";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentsRoutes } from "../agents";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const agentsApi = createAuthOrgAgentsBddApi(context);
const connectorsApi = createConnectorBddApi(context);

async function createIsolatedAgent(actor: ApiTestUser, body: AgentRequest) {
  // The first real request owns the case database even if response validation fails.
  const app = await setupApp({
    context,
    routes: agentsRoutes,
    isolatePg: true,
  });
  const response = await accept(
    app(agentsMainContract).create({
      headers: agentsApi.authenticate(actor),
      body: { visibility: "public", ...body },
    }),
    [201],
  );
  return response.body;
}

function agentNotFoundBody(agentId: string) {
  return {
    error: { code: "NOT_FOUND", message: `Agent not found: ${agentId}` },
  };
}

describe("Connector authorization-target validation", () => {
  it("rejects private, foreign-org and deleted targets before manual connection or OAuth start", async () => {
    const owner = bdd.user();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const foreignOwner = bdd.user();
    const privateAgent = await createIsolatedAgent(owner, {
      displayName: "Private Authorization Target",
      visibility: "private",
    });
    const publicAgent = await agentsApi.createAgent(owner, {
      displayName: "Public Authorization Target",
    });
    const foreignAgent = await agentsApi.createAgent(foreignOwner, {
      displayName: "Foreign Authorization Target",
    });
    const deletedAgent = await agentsApi.createAgent(owner, {
      displayName: "Deleted Authorization Target",
    });
    await bdd.deleteAgent(owner, deletedAgent.agentId);
    const privateGrants = await agentsApi.readEnabledConnectorSlugs(
      owner,
      privateAgent.agentId,
    );
    const publicGrants = await agentsApi.readEnabledConnectorSlugs(
      owner,
      publicAgent.agentId,
    );

    for (const agentId of [
      privateAgent.agentId,
      foreignAgent.agentId,
      deletedAgent.agentId,
    ]) {
      const manual = await connectorsApi.requestManualGrant(
        member,
        "openai",
        "api-token",
        { apiKey: "rejected-target-token" },
        { statuses: [404], agentId, authorizeAgent: true },
      );
      expect(manual.body).toStrictEqual(agentNotFoundBody(agentId));
      const oauth = await connectorsApi.requestOauthStart(
        member,
        "slack",
        "oauth",
        { statuses: [400], agentId, authorizeAgent: true },
      );
      expect(oauth.body).toStrictEqual({
        error: {
          code: "BAD_REQUEST",
          message: `Agent not found: ${agentId}`,
        },
      });
    }

    await expect(
      connectorsApi.listBuiltinConnectors(member),
    ).resolves.toMatchObject({ connectors: [] });
    await expect(
      connectorsApi.listBuiltinConnectors(owner),
    ).resolves.toMatchObject({ connectors: [] });
    await expect(
      agentsApi.readEnabledConnectorSlugs(owner, privateAgent.agentId),
    ).resolves.toStrictEqual(privateGrants);
    await expect(
      agentsApi.readEnabledConnectorSlugs(owner, publicAgent.agentId),
    ).resolves.toStrictEqual(publicGrants);
  });

  it("authorizes an owned private target and another member's public target without substituting agents", async () => {
    const owner = bdd.user();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const privateAgent = await createIsolatedAgent(owner, {
      displayName: "Owned Private Authorization Target",
      visibility: "private",
    });
    const publicAgent = await agentsApi.createAgent(owner, {
      displayName: "Shared Public Authorization Target",
    });
    const publicGrants = await agentsApi.readEnabledConnectorSlugs(
      owner,
      publicAgent.agentId,
    );

    const privateAccount = await connectorsApi.connectManualGrant(
      owner,
      "openai",
      "api-token",
      { apiKey: "private-target-token" },
      privateAgent.agentId,
    );
    await expect(
      agentsApi.readEnabledConnectorSlugs(owner, privateAgent.agentId),
    ).resolves.toContain("openai");
    await expect(
      agentsApi.readEnabledConnectorSlugs(owner, publicAgent.agentId),
    ).resolves.toStrictEqual(publicGrants);
    await expect(
      connectorsApi.readConnectorBySlug(owner, "openai"),
    ).resolves.toMatchObject({
      id: privateAccount.id,
      connectionStatus: "connected",
    });

    const publicAccount = await connectorsApi.connectManualGrant(
      member,
      "openai",
      "api-token",
      { apiKey: "public-target-token" },
      publicAgent.agentId,
    );
    expect(publicAccount.id).not.toBe(privateAccount.id);
    await expect(
      agentsApi.readEnabledConnectorSlugs(member, publicAgent.agentId),
    ).resolves.toContain("openai");
    await expect(
      connectorsApi.readConnectorBySlug(member, "openai"),
    ).resolves.toMatchObject({
      id: publicAccount.id,
      connectionStatus: "connected",
    });
    expect(JSON.stringify(publicAccount)).not.toContain("public-target-token");
    expect(JSON.stringify(privateAccount)).not.toContain(
      "private-target-token",
    );
  });

  it("allows an absent target but never falls back from an explicit deleted target", async () => {
    const actor = bdd.user();
    const deletedAgent = await createIsolatedAgent(actor, {
      displayName: "Removed Explicit Authorization Target",
    });
    await bdd.deleteAgent(actor, deletedAgent.agentId);

    const rejected = await connectorsApi.requestManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "absent-target-token" },
      { statuses: [404], agentId: deletedAgent.agentId, authorizeAgent: true },
    );
    expect(rejected.body).toStrictEqual(
      agentNotFoundBody(deletedAgent.agentId),
    );
    await expect(
      connectorsApi.listBuiltinConnectors(actor),
    ).resolves.toMatchObject({ connectors: [] });

    const connected = await connectorsApi.requestManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "absent-target-token" },
      { statuses: [200] },
    );
    expect(connected.body).toMatchObject({
      slug: "openai",
      connectionStatus: "connected",
    });
    const account = await connectorsApi.readConnectorBySlug(actor, "openai");
    expect(connected.body).toMatchObject({ id: account.id });
    expect(JSON.stringify(connected.body)).not.toContain("absent-target-token");
  });
});

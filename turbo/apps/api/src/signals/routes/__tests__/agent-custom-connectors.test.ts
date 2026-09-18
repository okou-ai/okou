import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { agentsRoutes } from "../agents";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const connectors = createConnectorBddApi(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function agentCustomConnectorsClient() {
  return setupApp({ context, routes: agentsRoutes })(
    agentCustomConnectorsContract,
  );
}

function bearerHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createAgent(
  actor: ApiTestUser,
  body: Parameters<typeof bdd.createAgent>[1] = {},
) {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, body);
}

async function apiKeyHeaders(
  actor: ApiTestUser,
): Promise<{ readonly authorization: string }> {
  const key = await api.createCliToken(actor);
  mockClerkMembership(context, actor, actor.orgRole ?? "org:admin");
  return bearerHeaders(key.token);
}

function okouTokenFor(
  actor: ApiTestUser,
  capabilities: readonly Capability[],
): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "okou",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function createUnconfiguredCustomConnector(
  actor: ApiTestUser,
  slug: string,
) {
  return await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      displayName: `Connector ${slug}`,
      slug: `_${slug}`,
      prefixTemplates: [`https://${slug}.example.test`],
    }),
  );
}

async function createCustomConnector(actor: ApiTestUser, slug: string) {
  const connector = await createUnconfiguredCustomConnector(actor, slug);
  await connectors.setCustomConnectorSecret(
    actor,
    connector.id,
    `${slug}-secret`,
  );
  return connector;
}

async function createPermissionedCustomConnector(
  actor: ApiTestUser,
  slug: string,
) {
  return await connectors.createCustomConnector(
    actor,
    manualHttpCustomConnectorCreateBody({
      displayName: `Connector ${slug}`,
      slug: `_${slug}`,
      prefixTemplates: [`https://${slug}.example.test`],
      permissionBundleRef: "builtin:slack@1",
    }),
  );
}

describe("GET /api/custom-connectors/:id/permissions", () => {
  it("returns permission metadata for a custom connector with a bundle", async () => {
    const actor = bdd.user();
    const connector = await createPermissionedCustomConnector(
      actor,
      "permission-metadata",
    );

    const response = await connectors.readCustomConnectorPermissions(
      actor,
      connector.id,
    );

    expect(response.ref).toBe("builtin:slack@1");
    expect(response.permissions).toContainEqual(
      expect.objectContaining({ name: "chat:write" }),
    );
    expect(response.defaultPolicies["chat:write"]).toBe("deny");
  });

  it("returns 404 when the custom connector has no permission bundle", async () => {
    const actor = bdd.user();
    const connector = await createCustomConnector(actor, "no-permissions");

    const response = await connectors.requestCustomConnectorPermissions(
      actor,
      connector.id,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Custom connector permission bundle not found",
        code: "NOT_FOUND",
      },
    });
  });
});

describe("GET /api/agents/:id/custom-connectors", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await connectors.requestAgentCustomConnectors(
      null,
      randomUUID(),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await connectors.requestAgentCustomConnectors(
      actor,
      randomUUID(),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty grants for an agent with no authorized custom connectors", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });

    const response = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );

    expect(response).toStrictEqual([]);
  });

  it("accepts an API key for the agent owner", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "API Key Agent" });

    const response = await accept(
      agentCustomConnectorsClient().get({
        params: { id: agent.agentId },
        headers: await apiKeyHeaders(actor),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ grants: [] });
  });

  it("returns 404 for a non-existent agent", async () => {
    const actor = bdd.user();
    const unknownId = randomUUID();

    const response = await connectors.requestAgentCustomConnectors(
      actor,
      unknownId,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org without leaking existence", async () => {
    const owner = bdd.user();
    const requester = bdd.user();
    const agent = await createAgent(owner, { displayName: "Other Agent" });

    const response = await connectors.requestAgentCustomConnectors(
      requester,
      agent.agentId,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 403 for an agent token without agent:read capability", async () => {
    const actor = bdd.user();
    const token = okouTokenFor(actor, ["file:read"]);

    const response = await accept(
      agentCustomConnectorsClient().get({
        params: { id: randomUUID() },
        headers: bearerHeaders(token),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("PUT /api/agents/:id/custom-connectors", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await connectors.requestUpdateAgentCustomConnectors(
      null,
      randomUUID(),
      [],
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      randomUUID(),
      [],
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 for a non-existent agent", async () => {
    const actor = bdd.user();
    const unknownId = randomUUID();

    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      unknownId,
      [],
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("sets grants and round-trips through the API", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const c1 = await createCustomConnector(actor, "round-a");
    const c2 = await createCustomConnector(actor, "round-b");

    const response = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [c1.id, c2.id],
    );

    expect(new Set(response)).toStrictEqual(new Set([c1.id, c2.id]));
    const readBack = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect([...readBack].sort()).toStrictEqual([...response].sort());
  });

  it("rejects the legacy id-only request before mutating grants", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Canonical Contract Agent",
    });
    const connector = await createCustomConnector(actor, "legacy-body");
    const legacyIdField = ["enabled", "Ids"].join("");

    const response = await connectors.requestUpdateAgentCustomConnectorsRaw(
      actor,
      agent.agentId,
      { [legacyIdField]: [connector.id] },
    );

    expect(response.status).toBe(400);
    await expect(
      connectors.readAgentCustomConnectorGrants(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });

  it("persists disconnected permission grants and rejects unknown permissions atomically", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Permission Grant Agent",
    });
    const connector = await createPermissionedCustomConnector(
      actor,
      "permission-roundtrip",
    );
    const grant = {
      customConnectorId: connector.id,
      permissionNames: ["chat:write"],
    };

    const updated = await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      [grant],
      [200],
    );
    expect(updated.body).toStrictEqual({ grants: [grant] });
    await expect(
      connectors.readAgentCustomConnectorGrants(actor, agent.agentId),
    ).resolves.toStrictEqual([grant]);

    const rejected = await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      [
        {
          customConnectorId: connector.id,
          permissionNames: ["unknown:permission"],
        },
      ],
      [400],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message: `Unknown permission names for custom connector ${connector.id}: unknown:permission`,
        code: "VALIDATION_ERROR",
      },
    });
    await expect(
      connectors.readAgentCustomConnectorGrants(actor, agent.agentId),
    ).resolves.toStrictEqual([grant]);
  });

  it("replaces an existing permission selection with an explicit empty grant", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Empty Permission Agent",
    });
    const connector = await createPermissionedCustomConnector(
      actor,
      "empty-permission-selection",
    );

    await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      [
        {
          customConnectorId: connector.id,
          permissionNames: ["chat:write"],
        },
      ],
      [200],
    );
    const emptied = await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      [{ customConnectorId: connector.id, permissionNames: [] }],
      [200],
      "add",
    );

    expect(emptied.body).toStrictEqual({
      grants: [{ customConnectorId: connector.id, permissionNames: [] }],
    });
  });

  it("writes empty HTTP and MCP grants without accepted catalog state", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Catalog Independent Agent",
    });
    const httpConnector = await createUnconfiguredCustomConnector(
      actor,
      "catalog-independent-http",
    );
    const mcpConnector = await connectors.createCustomConnector(actor, {
      kind: "mcp",
      displayName: "Catalog Independent MCP",
      endpoint: "https://catalog-independent-mcp.example.test/server",
      transport: "streamable-http",
      fields: [
        {
          key: "secret",
          label: "API token",
          kind: "secret",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.secret}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
    });
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `missing-connector-catalog-${randomUUID()}`,
    );
    const grants = [
      { customConnectorId: httpConnector.id, permissionNames: [] },
      { customConnectorId: mcpConnector.id, permissionNames: [] },
    ];

    const response = await connectors.requestUpdateAgentCustomConnectorGrants(
      actor,
      agent.agentId,
      grants,
      [200],
    );

    expect(response.body).toStrictEqual({ grants });
  });

  it("returns agent not found without leaking a private agent", async () => {
    const owner = bdd.user();
    const requester = bdd.user({ orgId: owner.orgId });
    const agent = await createAgent(owner, {
      displayName: "Private Agent",
      visibility: "private",
    });
    const connector = await createUnconfiguredCustomConnector(
      requester,
      "hidden-agent-order",
    );

    const response = await connectors.requestUpdateAgentCustomConnectors(
      requester,
      agent.agentId,
      [connector.id],
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("persists a connector after its credential storage becomes incompatible", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const connector = await createCustomConnector(
      actor,
      "incompatible-storage",
    );
    const updated = await connectors.updateCustomConnector(
      actor,
      connector.id,
      {
        displayName: connector.displayName,
        prefixTemplates: connector.prefixTemplates,
        fields: [
          ...connector.fields,
          {
            key: "replacement",
            label: "Replacement secret",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: connector.headerInjections,
        queryInjections: connector.queryInjections,
        authMode: connector.authMode,
      },
    );
    expect(updated.storageVersion).toBe(connector.storageVersion + 1);

    const enabled = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [connector.id],
    );

    expect(enabled).toStrictEqual([connector.id]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([connector.id]);
  });

  it("replaces the list atomically", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const c1 = await createCustomConnector(actor, "rep-1");
    const c2 = await createCustomConnector(actor, "rep-2");

    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [c1.id]);
    const replaced = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [c2.id],
    );

    expect(replaced).toStrictEqual([c2.id]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([c2.id]);
  });

  it("serializes concurrent custom connector replaces for the same agent", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Concurrent Agent" });
    const c1 = await createCustomConnector(actor, "conc-1");
    const c2 = await createCustomConnector(actor, "conc-2");

    const sameSetUpdates = await Promise.all([
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [
        c1.id,
        c2.id,
      ]),
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [
        c1.id,
        c2.id,
      ]),
    ]);
    for (const update of sameSetUpdates) {
      expect(new Set(update)).toStrictEqual(new Set([c1.id, c2.id]));
    }

    await Promise.all([
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [c1.id]),
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [c2.id]),
    ]);
    const readBack = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect(readBack).toHaveLength(1);
    expect([c1.id, c2.id]).toContain(readBack[0]);

    await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [],
      "replace",
    );
    await Promise.all([
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c1.id],
        "add",
      ),
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c2.id],
        "add",
      ),
    ]);
    const readAfterAdds = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect(new Set(readAfterAdds)).toStrictEqual(new Set([c1.id, c2.id]));

    await Promise.all([
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c1.id],
        "remove",
      ),
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c2.id],
        "add",
      ),
    ]);
    const readAfterRemoveAdd = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect(readAfterRemoveAdd).toStrictEqual([c2.id]);
  });

  it("clears authorizations with empty array", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const connector = await createCustomConnector(actor, "clr-1");

    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    const cleared = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [],
    );

    expect(cleared).toStrictEqual([]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });

  it("allows removing an enabled custom connector after its secret is deleted", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const connector = await createCustomConnector(actor, "remove-unconfigured");

    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    await connectors.deleteDefaultCustomConnectorAccount(actor, connector.id);

    const updated = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [connector.id],
      "remove",
    );

    expect(updated).toStrictEqual([]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });

  it("returns 400 for a cross-org custom connector id", async () => {
    const actor = bdd.user();
    const other = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const otherConnector = await createCustomConnector(other, "other-org");

    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      agent.agentId,
      [otherConnector.id],
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Unknown custom connector ids: ${otherConnector.id}`,
        code: "VALIDATION_ERROR",
      },
    });
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });
});

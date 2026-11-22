import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { agentsRoutes } from "../agents";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunExecutionCredentials } from "./helpers/run-execution-credentials";

const context = testContext();
const executionToken = createRunExecutionCredentials(context).okouToken;
const bdd = createBddApi(context);
const api = createRunsApi(context);

function agentsClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsByIdContract);
}

function bearerHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

// Raw rather than through the typed client, because each case supplies its own
// credential — a Clerk session, a PAT, and a run-scoped capability token — and
// the point is that all three reach the same handler and read back the same
// agent.
async function readAgentAs(
  agentId: string,
  headers: { readonly authorization?: string },
): Promise<unknown> {
  const app = createApp({
    signal: context.signal,
    routes: agentsRoutes,
  });
  const response = await app.request(`/api/agents/${agentId}`, { headers });
  expect(response.status).toBe(200);
  return await response.json();
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
  role: "org:admin" | "org:member",
): Promise<{ readonly authorization: string }> {
  const key = await api.createCliToken(actor);
  mockClerkMembership(context, actor, role);
  return bearerHeaders(key.token);
}

describe("GET /api/agents/:id", () => {
  // Exercise every supported credential against the same declared contract
  // path. Invalid path parameters have dedicated coverage below.
  it("reads back the same agent for session, PAT, and run-capability auth", async () => {
    const actor = bdd.user({ orgRole: "org:member" });
    const agent = await createAgent(actor, {
      displayName: "Credential Parity Agent",
      visibility: "private",
    });

    const sessionBody = await readAgentAs(agent.agentId, {
      authorization: "Bearer clerk-session",
    });

    const patBody = await readAgentAs(
      agent.agentId,
      await apiKeyHeaders(actor, "org:member"),
    );

    const capabilityBody = await readAgentAs(
      agent.agentId,
      bearerHeaders(await executionToken(actor)),
    );

    expect(patBody).toStrictEqual(sessionBody);
    expect(capabilityBody).toStrictEqual(sessionBody);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await bdd.requestReadAgent(null, randomUUID(), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await bdd.requestReadAgent(actor, randomUUID(), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the agent when found in the active org", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Test Agent",
      description: "Test description",
      sound: "friendly",
    });

    const response = await bdd.readAgent(actor, agent.agentId);

    expect(response).toStrictEqual({
      agentId: agent.agentId,
      isDefaultAgent: false,
      ownerId: actor.userId,
      displayName: "Test Agent",
      description: "Test description",
      sound: "friendly",
      avatarUrl: agent.avatarUrl,
      visibility: "public",
    });
  });

  it("accepts an owner API key for a private agent", async () => {
    const actor = bdd.user({ orgRole: "org:member" });
    const agent = await createAgent(actor, {
      displayName: "API Key Private Agent",
      visibility: "private",
    });

    const response = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: await apiKeyHeaders(actor, "org:member"),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: actor.userId,
      displayName: "API Key Private Agent",
      visibility: "private",
    });
  });

  it("hides private agents from same-org non-owners", async () => {
    const owner = bdd.user();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const agent = await createAgent(owner, {
      displayName: "Owner Only",
      visibility: "private",
    });

    const ownerResponse = await bdd.readAgent(owner, agent.agentId);
    expect(ownerResponse.visibility).toBe("private");

    const otherResponse = await bdd.requestReadAgent(
      member,
      agent.agentId,
      [404],
    );
    expect(otherResponse.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 for an unknown agent id", async () => {
    const actor = bdd.user();
    const unknownId = randomUUID();

    const response = await bdd.requestReadAgent(actor, unknownId, [404]);

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org without leaking existence", async () => {
    const owner = bdd.user();
    const other = bdd.user();
    const agent = await createAgent(other, {
      displayName: "Other Org Agent",
    });

    const response = await bdd.requestReadAgent(owner, agent.agentId, [404]);

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns the agent for an agent token with agent:read capability", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Okou Run Token Agent",
      description: "Read by an Okou run token",
    });
    const token = await executionToken(actor);
    mockClerkMembership(context, actor, "org:admin");

    const response = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: bearerHeaders(token),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: actor.userId,
      displayName: "Okou Run Token Agent",
      description: "Read by an Okou run token",
    });
  });
});

describe("DELETE /api/agents/:id", () => {
  it("has no route and leaves the agent readable to its owner", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor);
    const app = createApp({ signal: context.signal, routes: agentsRoutes });
    const response = await app.request(`/api/agents/${agent.agentId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(404);
    await expect(bdd.readAgent(actor, agent.agentId)).resolves.toStrictEqual(
      agent,
    );
  });
});

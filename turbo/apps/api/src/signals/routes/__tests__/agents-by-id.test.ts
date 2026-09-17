import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  countAgentStableContextPublicationsFixture,
  seedAgentStableContextPublicationFixture,
} from "../../../test-fixtures/pi-stable-context";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { agentsRoutes } from "../agents";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);
const storages = createStoragesBddApi(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

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

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function s3DeletedObjectKeys(): readonly string[] {
  return context.mocks.s3.send.mock.calls.flatMap(([command]) => {
    const input = commandInput(command);
    const request = input.Delete;
    if (
      typeof request !== "object" ||
      request === null ||
      !("Objects" in request) ||
      !Array.isArray(request.Objects)
    ) {
      return [];
    }
    return request.Objects.flatMap((object) => {
      if (
        typeof object === "object" &&
        object !== null &&
        "Key" in object &&
        typeof object.Key === "string"
      ) {
        return [object.Key];
      }
      return [];
    });
  });
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
      bearerHeaders(okouTokenFor(actor, ["agent:read"])),
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

  it("returns 400 for invalid path params", async () => {
    const actor = bdd.user();
    const response = await bdd.requestReadAgent(actor, "not-a-uuid", [400]);
    expectApiError(response.body);
    expect(response.body.error.code).toBe("BAD_REQUEST");
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
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
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

  it("returns 403 for an agent token without agent:read capability", async () => {
    const actor = bdd.user();
    const token = okouTokenFor(actor, ["file:read"]);

    const response = await accept(
      agentsClient().get({
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

  it("returns the agent for an agent token with agent:read capability", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, {
      displayName: "Okou Run Token Agent",
      description: "Read by an Okou run token",
    });
    const token = okouTokenFor(actor, ["agent:read"]);
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
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await bdd.requestDeleteAgent(null, randomUUID(), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for an agent token without agent:delete capability", async () => {
    const actor = bdd.user();
    const token = okouTokenFor(actor, ["file:read"]);

    const response = await accept(
      agentsClient().delete({
        params: { id: randomUUID() },
        headers: bearerHeaders(token),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:delete",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 for invalid path params", async () => {
    const actor = bdd.user();
    const response = await bdd.requestDeleteAgent(actor, "not-a-uuid", [400]);

    expectApiError(response.body);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 for an unknown agent id", async () => {
    const actor = bdd.user();
    const unknownId = randomUUID();

    const response = await bdd.requestDeleteAgent(actor, unknownId, [404]);

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org and leaves it readable to its owner", async () => {
    const owner = bdd.user();
    const requester = bdd.user();
    const agent = await createAgent(owner, {
      displayName: "Other Org Agent",
    });

    const response = await bdd.requestDeleteAgent(
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

    await expect(bdd.readAgent(owner, agent.agentId)).resolves.toMatchObject({
      agentId: agent.agentId,
      displayName: "Other Org Agent",
    });
  });

  it("rejects same-org members who are not the agent owner", async () => {
    const owner = bdd.user();
    const member = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    const agent = await createAgent(owner);

    const response = await bdd.requestDeleteAgent(member, agent.agentId, [403]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner or org admin can delete agent",
        code: "FORBIDDEN",
      },
    });
  });

  it("deletes the caller's own agent", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor);

    await bdd.deleteAgent(actor, agent.agentId);

    const response = await bdd.requestReadAgent(actor, agent.agentId, [404]);
    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("removes abandoned stable-context publications on ordinary deletion", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const agent = await createAgent(actor);
    await seedAgentStableContextPublicationFixture({
      orgId: actor.orgId,
      agentId: agent.agentId,
    });

    await bdd.deleteAgent(actor, agent.agentId);

    await expect(
      countAgentStableContextPublicationsFixture(agent.agentId),
    ).resolves.toBe(0);
  });

  it("sweeps the agent instructions volume after deleting the agent", async () => {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Expected org-scoped actor");
    }
    const baselineVolumes = await storages.listStorages(actor, "organization");
    const agent = await createAgent(actor, {
      displayName: "Sweep Agent",
    });

    const volumesAfterCreate = await storages.listStorages(
      actor,
      "organization",
    );
    const createdVolumes = volumesAfterCreate.filter((volume) => {
      return !baselineVolumes.some((baseline) => {
        return baseline.name === volume.name;
      });
    });
    expect(createdVolumes).toHaveLength(1);
    const instructionsVolume = createdVolumes[0];
    if (!instructionsVolume) {
      throw new Error("Expected an instructions volume");
    }

    let listedPrefix = "";
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      if (typeof input.Prefix === "string") {
        listedPrefix = input.Prefix;
        return Promise.resolve({
          Contents: [
            {
              Key: `${input.Prefix}v1/archive.tar.gz`,
              Size: 1024,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            },
            {
              Key: `${input.Prefix}v1/manifest.json`,
              Size: 256,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    await bdd.deleteAgent(actor, agent.agentId);

    expect(listedPrefix).toMatch(
      new RegExp(
        `^${actor.orgId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/$`,
      ),
    );
    expect(s3DeletedObjectKeys()).toStrictEqual([
      `${listedPrefix}v1/archive.tar.gz`,
      `${listedPrefix}v1/manifest.json`,
    ]);
    const afterVolumes = await storages.listStorages(actor, "organization");
    expect(
      afterVolumes.some((volume) => {
        return volume.name === instructionsVolume.name;
      }),
    ).toBeFalsy();
  });

  it("allows an owner API key to delete a private agent", async () => {
    const actor = bdd.user({ orgRole: "org:member" });
    const agent = await createAgent(actor, {
      displayName: "API Key Deletable Agent",
      visibility: "private",
    });
    const response = await accept(
      agentsClient().delete({
        params: { id: agent.agentId },
        headers: await apiKeyHeaders(actor, "org:member"),
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const readAfterDelete = await bdd.requestReadAgent(
      actor,
      agent.agentId,
      [404],
    );
    expect(readAfterDelete.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("allows an org admin to delete another user's public agent", async () => {
    const owner = bdd.user();
    const admin = bdd.user({ orgId: owner.orgId, orgRole: "org:admin" });
    const agent = await createAgent(owner);

    await bdd.deleteAgent(admin, agent.agentId);

    const readAfterDelete = await bdd.requestReadAgent(
      owner,
      agent.agentId,
      [404],
    );
    expect(readAfterDelete.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 409 and preserves the agent when a pending run references it", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor);
    const run = await api.createRun(actor, {
      agentId: agent.agentId,
      prompt: "keep this run pending",
      modelProvider: "anthropic-api-key",
    });
    const response = await bdd.requestDeleteAgent(actor, agent.agentId, [409]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });
    await expect(bdd.readAgent(actor, agent.agentId)).resolves.toMatchObject({
      agentId: agent.agentId,
    });

    await api.requestCancelRun(actor, run.runId, [200]);
  });
});

import { randomUUID } from "node:crypto";

import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { parseAvatarComposerUrl } from "@okouai/core/agent-avatar";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";

const context = testContext();
const authOrgApi = createAuthOrgAgentsBddApi(context);
const storageApi = createStoragesBddApi(context);
const mocks = createRouteMocks(context);

type AgentsFixture = ApiTestUser & { readonly orgId: string };

function agentsFixture(prefix: string): AgentsFixture {
  const actor = authOrgApi.user({
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
  });
  if (!actor.orgId) {
    throw new Error("Expected agent fixture to have an organization");
  }
  return {
    ...actor,
    orgId: actor.orgId,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsMainContract);
}

function agentsByIdClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsByIdContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function instructionStorageCount(
  fixture: AgentsFixture,
): Promise<number> {
  const storages = await storageApi.listStorages(fixture, "organization");
  return storages.filter((storage) => {
    return storage.name.startsWith("agent-instructions@");
  }).length;
}

describe("POST /api/agents", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().create({ headers: {}, body: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for an agent token without agent:write capability", async () => {
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    const response = await accept(
      agentsClient().create({
        headers: { authorization: `Bearer ${token}` },
        body: {},
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:write",
        code: "FORBIDDEN",
      },
    });
  });

  it("creates private agent metadata by default", async () => {
    const fixture = agentsFixture("create");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Research Agent",
          description: "Tracks research context",
          sound: "calm",
          avatarUrl: "preset:2",
        },
      }),
      [201],
    );

    expect(response.body).toMatchObject({
      ownerId: fixture.userId,
      displayName: "Research Agent",
      description: "Tracks research context",
      sound: "calm",
      avatarUrl: "preset:2",
      visibility: "private",
    });
    expect(response.body.agentId).toStrictEqual(expect.any(String));

    const ownerResponse = await accept(
      agentsByIdClient().get({
        headers: authHeaders(),
        params: { id: response.body.agentId },
      }),
      [200],
    );
    expect(ownerResponse.body.visibility).toBe("private");

    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const memberList = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(memberList.body).toStrictEqual([]);
    await accept(
      agentsByIdClient().get({
        headers: authHeaders(),
        params: { id: response.body.agentId },
      }),
      [404],
    );
  });

  it("assigns a composer avatar when none is provided", async () => {
    const fixture = agentsFixture("avatar");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "CLI Agent" },
      }),
      [201],
    );

    expect(parseAvatarComposerUrl(response.body.avatarUrl)).not.toBeNull();
  });

  it("returns 409 when the public agent limit has been reached", async () => {
    const fixture = agentsFixture("limit");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    for (let index = 0; index < 7; index += 1) {
      await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: {
            displayName: `Limit Agent ${index + 1}`,
            visibility: "public",
          },
        }),
        [201],
      );
    }

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { visibility: "public" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "This organization has reached the maximum number of agents (7). Delete an existing agent before creating a new one.",
        code: "CONFLICT",
      },
    });
  });

  it("excludes private agents from the public agent create limit", async () => {
    const fixture = agentsFixture("private-limit");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    for (let index = 0; index < 7; index += 1) {
      const response = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: `Public ${index + 1}`, visibility: "public" },
        }),
        [201],
      );
      expect(response.body.visibility).toBe("public");
    }

    const privateResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Private" },
      }),
      [201],
    );
    expect(privateResponse.body.visibility).toBe("private");

    const publicResponse = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Public Over Limit", visibility: "public" },
      }),
      [409],
    );
    expect(publicResponse.body.error.code).toBe("CONFLICT");
  });

  it("allows creating another public agent after one is deleted", async () => {
    const fixture = agentsFixture("delete-limit");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});
    const createdAgentIds: string[] = [];

    for (let index = 0; index < 7; index += 1) {
      const response = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: `Agent ${index + 1}`, visibility: "public" },
        }),
        [201],
      );
      createdAgentIds.push(response.body.agentId);
    }

    const blocked = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "Blocked", visibility: "public" },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CONFLICT");

    const deletedAgentId = createdAgentIds[0];
    if (!deletedAgentId) {
      throw new Error("Expected a created agent");
    }
    const deleteResponse = await accept(
      agentsByIdClient().delete({
        params: { id: deletedAgentId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(deleteResponse.body).toBeUndefined();

    const response = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "After Delete", visibility: "public" },
      }),
      [201],
    );
    expect(response.body.displayName).toBe("After Delete");
  });

  it("keeps concurrent public creates consistent and rejects later creates once full", async () => {
    const fixture = agentsFixture("concurrent-limit");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    for (let index = 0; index < 6; index += 1) {
      await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: {
            displayName: `Concurrent Limit ${index + 1}`,
            visibility: "public",
          },
        }),
        [201],
      );
    }
    const baselineStorageCount = await instructionStorageCount(fixture);
    expect(baselineStorageCount).toBe(6);

    const requests = ["First contender", "Second contender"].map(
      async (displayName) => {
        return await accept(
          agentsClient().create({
            headers: authHeaders(),
            body: { displayName, visibility: "public" },
          }),
          [201, 409],
        );
      },
    );

    const responses = await Promise.all(requests);
    const createdIds = responses.flatMap((response) => {
      return response.status === 201 ? [response.body.agentId] : [];
    });
    // The count is a soft limit: both concurrent requests may see a free slot.
    expect([1, 2]).toContain(createdIds.length);

    const listResponse = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      listResponse.body.filter((agent) => {
        return agent.visibility === "public";
      }),
    ).toHaveLength(6 + createdIds.length);
    for (const agentId of createdIds) {
      expect(listResponse.body).toContainEqual(
        expect.objectContaining({ agentId, visibility: "public" }),
      );
    }
    await expect(instructionStorageCount(fixture)).resolves.toBe(
      baselineStorageCount + createdIds.length,
    );

    const blocked = await accept(
      agentsClient().create({
        headers: authHeaders(),
        body: { displayName: "After concurrent creates", visibility: "public" },
      }),
      [409],
    );
    expect(blocked.body.error.code).toBe("CONFLICT");
  });
});

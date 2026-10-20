import { createBddApi } from "./helpers/api-bdd";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { createPublicConnectorActor } from "./helpers/public-connector-actor";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { agentInstructionsRoutes } from "../agent-instructions";
import { randomUUID } from "node:crypto";
import { parseAvatarComposerUrl } from "@okouai/core/agent-avatar";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";

const context = testContext();
const authOrgApi = createAuthOrgAgentsBddApi(context);
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

const trackCreatedAgent = createFixtureTracker(
  async (agent: AgentsFixture & { readonly agentId: string }) => {
    mocks.clerk.session(agent.userId, agent.orgId);
    await accept(
      agentsByIdClient().delete({
        headers: authHeaders(),
        params: { id: agent.agentId },
      }),
      [204],
    );
  },
);

describe("POST /api/agents", () => {
  it.each([
    ["displayName", 257],
    ["sound", 65],
    ["avatarUrl", 1025],
  ] as const)(
    "preserves the existing agent and instructions after an oversized %s fails",
    async (field, length) => {
      const fixture = agentsFixture("failed-create");
      mocks.clerk.session(fixture.userId, fixture.orgId);
      installDurableUserExportStorage(context, {
        prefixes: [`${fixture.orgId}/`],
      });
      const existing = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: { displayName: "Surviving agent", visibility: "public" },
        }),
        [201],
      );
      await trackCreatedAgent(
        Promise.resolve({ ...fixture, agentId: existing.body.agentId }),
      );
      await expect(
        agentsClient().create({
          headers: authHeaders(),
          body: { [field]: "x".repeat(length), visibility: "public" },
        }),
      ).rejects.toThrow("Unknown response status 500 for POST /api/agents");
      const listed = await accept(
        agentsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(listed.body).toStrictEqual([existing.body]);
      const instructions = await accept(
        setupApp({ context, routes: agentInstructionsRoutes })(
          agentInstructionsContract,
        ).get({
          headers: authHeaders(),
          params: { id: existing.body.agentId },
        }),
        [200],
      );
      expect(instructions.body.content).toBe("");
    },
  );

  it("keeps default metadata and empty instructions readable after creation", async () => {
    const fixture = agentsFixture("empty-instructions");
    mocks.clerk.session(fixture.userId, fixture.orgId);
    installDurableUserExportStorage(context, {
      prefixes: [`${fixture.orgId}/`],
    });
    const created = await accept(
      agentsClient().create({ headers: authHeaders(), body: {} }),
      [201],
    );
    await trackCreatedAgent(
      Promise.resolve({ ...fixture, agentId: created.body.agentId }),
    );
    expect(created.body).toMatchObject({
      isDefaultAgent: false,
      ownerId: fixture.userId,
      displayName: null,
      description: null,
      sound: null,
      visibility: "private",
    });
    const read = await accept(
      agentsByIdClient().get({
        headers: authHeaders(),
        params: { id: created.body.agentId },
      }),
      [200],
    );
    expect(read.body).toStrictEqual(created.body);
    const instructions = await accept(
      setupApp({ context, routes: agentInstructionsRoutes })(
        agentInstructionsContract,
      ).get({
        headers: authHeaders(),
        params: { id: created.body.agentId },
      }),
      [200],
    );
    expect(instructions.body.content).toBe("");
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().create({ headers: {}, body: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
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
    const owner = createPublicConnectorActor(context);
    const fixture = owner.actor;
    await owner.run(async () => {
      mocks.clerk.session(fixture.userId, fixture.orgId);
      context.mocks.s3.send.mockClear();
      context.mocks.s3.send.mockResolvedValue({});
      installDurableUserExportStorage(context, {
        prefixes: [`${fixture.orgId}/`],
      });
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

      const settled = await Promise.allSettled(requests);
      const responses = settled.map((result) => {
        if (result.status === "rejected") {
          throw result.reason;
        }
        return result.value;
      });
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
      for (const agentId of createdIds) {
        await createBddApi(context).updateAgentInstructions(
          fixture,
          agentId,
          `Instructions for ${agentId}`,
        );
        const instructions = setupApp({
          context,
          routes: agentInstructionsRoutes,
        })(agentInstructionsContract);
        const response = await accept(
          instructions.get({ params: { id: agentId }, headers: authHeaders() }),
          [200],
        );
        expect(response.body.content).toBe(`Instructions for ${agentId}`);
      }
      const blocked = await accept(
        agentsClient().create({
          headers: authHeaders(),
          body: {
            displayName: "After concurrent creates",
            visibility: "public",
          },
        }),
        [409],
      );
      expect(blocked.body.error.code).toBe("CONFLICT");
    });
  });
});

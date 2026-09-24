import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { overrideCanonicalAgentAuthorityFixture } from "../../../test-fixtures/canonical-agent-authority";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";

const context = testContext();
const mocks = createRouteMocks(context);

interface OrgUser {
  readonly orgId: string;
  readonly userId: string;
}

function newOrgUser(): OrgUser {
  return { orgId: `org_${randomUUID()}`, userId: `user_${randomUUID()}` };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsMainContract);
}

describe("GET /api/agents", () => {
  it("returns an agent created through POST /api/agents", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: {
          displayName: "Listed Agent",
          description: "desc",
          sound: "friendly",
        },
      }),
      [201],
    );

    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toHaveLength(1);
    expect(response.body[0]?.agentId).toBe(created.body.agentId);
    expect(response.body[0]?.ownerId).toBe(user.userId);
    expect(response.body[0]?.displayName).toBe("Listed Agent");
    expect(response.body[0]?.description).toBe("desc");
    expect(response.body[0]?.sound).toBe("friendly");
  });

  it("returns agents only scoped to caller's org", async () => {
    const user = newOrgUser();
    const otherUser = newOrgUser();
    context.mocks.s3.send.mockResolvedValue({});

    mocks.clerk.session(otherUser.userId, otherUser.orgId);
    await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "Foreign Agent" },
      }),
      [201],
    );

    mocks.clerk.session(user.userId, user.orgId);
    const response = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual([]);
  });

  it("uses canonical owner, product state, and updated-at ordering", async () => {
    const owner = newOrgUser();
    const canonicalOwner = {
      orgId: owner.orgId,
      userId: `user_${randomUUID()}`,
    };
    mocks.clerk.session(owner.userId, owner.orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const first = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "First Agent" },
      }),
      [201],
    );
    const second = await accept(
      apiClient().create({
        headers: authHeaders(),
        body: { displayName: "Second Agent" },
      }),
      [201],
    );
    await overrideCanonicalAgentAuthorityFixture({
      agentId: first.body.agentId,
      override: {
        owner: canonicalOwner.userId,
        displayName: "Canonical First Agent",
        visibility: "private",
        updatedAt: new Date("2099-01-01T00:00:00.000Z"),
      },
      signal: context.signal,
    });
    const ownerList = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      ownerList.body.map((agent) => {
        return agent.agentId;
      }),
    ).toStrictEqual([second.body.agentId]);

    mocks.clerk.session(canonicalOwner.userId, canonicalOwner.orgId);
    const canonicalOwnerList = await accept(
      apiClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(canonicalOwnerList.body).toHaveLength(2);
    expect(canonicalOwnerList.body[0]).toMatchObject({
      agentId: first.body.agentId,
      ownerId: canonicalOwner.userId,
      displayName: "Canonical First Agent",
      visibility: "private",
    });
    expect(canonicalOwnerList.body[1]?.agentId).toBe(second.body.agentId);
  });
});

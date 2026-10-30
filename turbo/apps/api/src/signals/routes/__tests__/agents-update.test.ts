import { randomUUID } from "node:crypto";

import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
  type AgentRequest,
} from "@okouai/api-contracts/contracts/agents";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { createStore } from "ccstate";

import { mockNow } from "../../../lib/time";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { cliAuthRoutes } from "../cli-auth";
import { agentInstructionsRoutes } from "../agent-instructions";
import { agentsRoutes } from "../agents";
import { onboardingStatusRoutes } from "../onboarding-status";
import { workflowsRoutes } from "../workflows";

const context = testContext();
const store = createStore();
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

async function cliAuthHeaders(
  user: OrgUser,
  role: "admin" | "member" = "admin",
): Promise<{ readonly authorization: string }> {
  await store.set(
    seedOrgMembership$,
    { orgId: user.orgId, userId: user.userId, role },
    context.signal,
  );
  mocks.clerk.session(
    user.userId,
    user.orgId,
    role === "admin" ? "org:admin" : "org:member",
  );

  const device = await accept(
    setupApp({ context, routes: cliAuthRoutes })(cliAuthDeviceContract).create({
      body: {},
    }),
    [200],
  );
  await accept(
    setupApp({ context, routes: cliAuthRoutes })(
      cliAuthApproveContract,
    ).approve({
      headers: authHeaders(),
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  const response = await accept(
    setupApp({ context, routes: cliAuthRoutes })(cliAuthTokenContract).exchange(
      {
        body: { device_code: device.body.device_code },
      },
    ),
    [200],
  );

  return { authorization: `Bearer ${response.body.access_token}` };
}

function agentsClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsByIdContract);
}

function agentsCollectionClient() {
  return setupApp({ context, routes: agentsRoutes })(agentsMainContract);
}

function onboardingStatusClient() {
  return setupApp({ context, routes: onboardingStatusRoutes })(
    onboardingStatusContract,
  );
}

function instructionsClient() {
  return setupApp({ context, routes: agentInstructionsRoutes })(
    agentInstructionsContract,
  );
}

/** Creates an agent through POST /api/agents with the user as owner. */
async function createAgentAs(
  user: OrgUser,
  body: AgentRequest = {},
): Promise<{ readonly agentId: string }> {
  mocks.clerk.session(user.userId, user.orgId);
  context.mocks.s3.send.mockResolvedValue({});
  const response = await accept(
    agentsCollectionClient().create({
      headers: authHeaders(),
      body: { visibility: "public", ...body },
    }),
    [201],
  );
  return { agentId: response.body.agentId };
}

/** Binds a workflow to the agent through POST /api/workflows. */
async function createWorkflowFor(
  user: OrgUser,
  agentId: string,
  name: string,
): Promise<void> {
  mocks.clerk.session(user.userId, user.orgId);
  await accept(
    setupApp({ context, routes: workflowsRoutes })(
      workflowsCollectionContract,
    ).create({
      headers: authHeaders(),
      body: { agentId, name },
    }),
    [201],
  );
}

describe("PUT /api/agents/:id", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("updates agent metadata while preserving omitted fields", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Old Agent",
      description: "Retained description",
      sound: "calm",
      avatarUrl: "preset:4",
    });

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: {
          displayName: "Updated Agent",
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: user.userId,
      displayName: "Updated Agent",
      description: "Retained description",
      sound: "calm",
      avatarUrl: "preset:4",
      visibility: "public",
    });

    const fetched = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(fetched.body.displayName).toBe("Updated Agent");
  });

  it("updates an agent that has workflow bindings", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user);
    await createWorkflowFor(user, agent.agentId, "existing-skill");

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { description: "Updated description" },
      }),
      [200],
    );

    expect(response.body.description).toBe("Updated description");
  });

  it.each(["public", "private"] as const)(
    "allows an owner member to update their own %s agent",
    async (visibility) => {
      const user = newOrgUser();
      const agent = await createAgentAs(user, {
        displayName: "Member Agent",
        visibility,
      });
      mocks.clerk.session(user.userId, user.orgId, "org:member");

      const response = await accept(
        agentsClient().update({
          params: { id: agent.agentId },
          headers: authHeaders(),
          body: { displayName: "Member Updated" },
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        agentId: agent.agentId,
        ownerId: user.userId,
        displayName: "Member Updated",
        visibility,
      });
    },
  );
  it("returns 403 when a non-owner member updates another user's agent", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      description: "Retained configuration",
    });
    mocks.clerk.session(`user_${randomUUID()}`, user.orgId, "org:member");

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Nope", description: "Rejected\0configuration" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can update agent configuration",
        code: "FORBIDDEN",
      },
    });
    mocks.clerk.session(user.userId, user.orgId);
    const current = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body.description).toBe("Retained configuration");
  });

  it("returns 404 for an unknown agent", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);
    const agentId = randomUUID();

    const response = await accept(
      agentsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: {},
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });

  it.each(["public", "private"] as const)(
    "applies administrator configuration permissions to another owner's %s agent",
    async (visibility) => {
      const owner = newOrgUser();
      const agent = await createAgentAs(owner, {
        description: "Original configuration",
        visibility,
      });
      mocks.clerk.session(`user_${randomUUID()}`, owner.orgId, "org:admin");
      const response = await accept(
        agentsClient().update({
          params: { id: agent.agentId },
          headers: authHeaders(),
          body: { description: "Administrator configuration" },
        }),
        [200, 403],
      );
      expect(response.status).toBe(visibility === "public" ? 200 : 403);
      mocks.clerk.session(owner.userId, owner.orgId);
      const current = await accept(
        agentsClient().get({
          params: { id: agent.agentId },
          headers: authHeaders(),
        }),
        [200],
      );
      expect(current.body.description).toBe(
        visibility === "public"
          ? "Administrator configuration"
          : "Original configuration",
      );
    },
  );

  it("rejects an administrator visibility request before admitting its text", async () => {
    const owner = newOrgUser();
    const agent = await createAgentAs(owner, {
      description: "Retained description",
    });
    mocks.clerk.session(`user_${randomUUID()}`, owner.orgId, "org:admin");
    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { visibility: "public", description: "Rejected\0description" },
      }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Only the agent owner can update agent visibility",
    );
    mocks.clerk.session(owner.userId, owner.orgId);
    const current = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      visibility: "public",
      description: "Retained description",
    });
  });

  it("edits default configuration while preserving identity and permission-error precedence", async () => {
    const owner = newOrgUser();
    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );
    const onboarding = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    const agentId = onboarding.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected onboarding to create a default Agent");
    }
    const configured = await accept(
      agentsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { description: "Shared responsibility", sound: "friendly" },
      }),
      [200],
    );
    expect(configured.body).toMatchObject({
      agentId,
      isDefaultAgent: true,
      displayName: "Okou",
      description: "Shared responsibility",
      sound: "friendly",
      visibility: "public",
    });
    const unchanged = await accept(
      agentsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: {},
      }),
      [200],
    );
    expect(unchanged.body).toStrictEqual(configured.body);
    for (const body of [
      { displayName: "Renamed", description: "Rejected\0configuration" },
      { displayName: "Renamed" },
    ]) {
      const response = await accept(
        agentsClient().update({
          params: { id: agentId },
          headers: authHeaders(),
          body,
        }),
        [400],
      );
      expect(response.body.error.code).toBe("DEFAULT_AGENT_NAME_LOCKED");
    }
    mocks.clerk.session(`user_${randomUUID()}`, owner.orgId, "org:member");
    const forbidden = await accept(
      agentsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { description: "Rejected\0configuration" },
      }),
      [403],
    );
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    mocks.clerk.session(owner.userId, owner.orgId);
    const after = await accept(
      agentsClient().get({ params: { id: agentId }, headers: authHeaders() }),
      [200],
    );
    expect(after.body).toStrictEqual(configured.body);
  });

  it("keeps private configuration when the public limit rejects promotion", async () => {
    const owner = newOrgUser();
    for (let index = 0; index < 7; index += 1) {
      await createAgentAs(owner, { visibility: "public" });
    }
    const agent = await createAgentAs(owner, {
      visibility: "private",
      description: "Retained private configuration",
    });
    await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { visibility: "public", description: "Rejected\0promotion" },
      }),
      [409],
    );
    const current = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      visibility: "private",
      description: "Retained private configuration",
    });
  });

  it("lets the owner publish and demote an Agent with its other configuration", async () => {
    const owner = newOrgUser();
    const agent = await createAgentAs(owner, {
      visibility: "private",
      displayName: "Custom Agent",
    });
    for (const visibility of ["public", "private"] as const) {
      const response = await accept(
        agentsClient().update({
          params: { id: agent.agentId },
          headers: authHeaders(),
          body: { visibility, description: `${visibility} configuration` },
        }),
        [200],
      );
      expect(response.body).toMatchObject({
        agentId: agent.agentId,
        isDefaultAgent: false,
        displayName: "Custom Agent",
        visibility,
        description: `${visibility} configuration`,
      });
      const current = await accept(
        agentsClient().get({
          params: { id: agent.agentId },
          headers: authHeaders(),
        }),
        [200],
      );
      expect(current.body).toStrictEqual(response.body);
    }
  });

  it("orders a saved Agent using the application clock", async () => {
    const owner = newOrgUser();
    mockNow(new Date("2030-10-27T00:00:00.123Z"));
    const first = await createAgentAs(owner, { displayName: "First" });
    mockNow(new Date("2030-10-27T00:01:00.456Z"));
    const second = await createAgentAs(owner, { displayName: "Second" });
    mockNow(new Date("2030-10-27T00:02:00.789Z"));
    await accept(
      agentsClient().update({
        params: { id: first.agentId },
        headers: authHeaders(),
        body: { description: "Most recently saved" },
      }),
      [200],
    );
    const listed = await accept(
      agentsCollectionClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      listed.body.map((agent) => {
        return agent.agentId;
      }),
    ).toStrictEqual([first.agentId, second.agentId]);
  });
});

describe("PATCH /api/agents/:id", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: randomUUID() },
        headers: {},
        body: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("updates metadata fields and preserves omitted fields without recomposing", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Original Agent",
      description: "Original description",
      sound: "calm",
      avatarUrl: "preset:4",
    });
    await createWorkflowFor(user, agent.agentId, "existing-skill");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: {
          displayName: "Updated Agent",
          description: "Updated description",
          avatarUrl: null,
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: user.userId,
      displayName: "Updated Agent",
      description: "Updated description",
      sound: "calm",
      avatarUrl: null,
    });

    const fetched = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(fetched.body).toMatchObject({
      displayName: "Updated Agent",
      description: "Updated description",
      avatarUrl: null,
    });
  });

  it("returns 404 for an unknown agent", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);
    const agentId = randomUUID();

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agentId },
        headers: authHeaders(),
        body: {},
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 403 when a non-owner member updates another user's agent", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user);
    mocks.clerk.session(`user_${randomUUID()}`, user.orgId, "org:member");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Nope" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner or org admin can update agent profile",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns an avatar-specific error for a forbidden avatar update", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user);
    mocks.clerk.session(`user_${randomUUID()}`, user.orgId, "org:member");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { avatarUrl: "preset:4" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner or org admin can update agent avatar",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns a profile-specific error for a forbidden default agent update", async () => {
    const owner = newOrgUser();
    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );
    const onboarding = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    const agentId = onboarding.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected onboarding to create a default agent");
    }

    mocks.clerk.session(`user_${randomUUID()}`, owner.orgId, "org:member");
    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agentId },
        headers: authHeaders(),
        body: { description: "Nope" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner or org admin can update agent profile",
        code: "FORBIDDEN",
      },
    });
  });

  it("allows an org admin to update another user's public agent", async () => {
    const user = newOrgUser();
    const adminUserId = `user_${randomUUID()}`;
    const agent = await createAgentAs(user, {
      displayName: "Owner Agent",
    });
    mocks.clerk.session(adminUserId, user.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Admin Updated" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: user.userId,
      displayName: "Admin Updated",
    });
  });

  it("returns 403 when an org admin changes another user's public agent visibility", async () => {
    const user = newOrgUser();
    const adminUserId = `user_${randomUUID()}`;
    const agent = await createAgentAs(user, {
      visibility: "public",
      description: "Retained public profile",
    });
    mocks.clerk.session(adminUserId, user.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: {
          visibility: "private",
          description: "Rejected\0profile",
        },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner can update agent visibility",
        code: "FORBIDDEN",
      },
    });
    mocks.clerk.session(user.userId, user.orgId);
    const current = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      visibility: "public",
      description: "Retained public profile",
    });
  });

  it("returns 403 when an org admin updates another user's private agent", async () => {
    const user = newOrgUser();
    const adminUserId = `user_${randomUUID()}`;
    const agent = await createAgentAs(user, { visibility: "private" });
    mocks.clerk.session(adminUserId, user.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Admin Updated" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the private agent owner can update agent profile",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 409 when changing a private agent to public would exceed the public limit", async () => {
    const user = newOrgUser();
    for (let index = 0; index < 7; index += 1) {
      await createAgentAs(user, { visibility: "public" });
    }
    const privateAgent = await createAgentAs(user, {
      visibility: "private",
      description: "Retained private profile",
    });

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: privateAgent.agentId },
        headers: authHeaders(),
        body: {
          visibility: "public",
          description: "Rejected\0promotion",
        },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
        code: "CONFLICT",
      },
    });
    const current = await accept(
      agentsClient().get({
        params: { id: privateAgent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      visibility: "private",
      description: "Retained private profile",
    });
  });

  it("edits default metadata while preserving every protected identity field", async () => {
    const owner = newOrgUser();
    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.test/default-agent.tar.gz?signature=test",
    );
    const onboarding = await accept(
      onboardingStatusClient().getStatus({ headers: authHeaders() }),
      [200],
    );
    const agentId = onboarding.body.defaultAgentId;
    if (!agentId) {
      throw new Error("Expected onboarding to create a default Agent");
    }
    const saved = await accept(
      agentsClient().updateMetadata({
        params: { id: agentId },
        headers: authHeaders(),
        body: { description: "Updated default profile", sound: "friendly" },
      }),
      [200],
    );
    expect(saved.body).toMatchObject({
      agentId,
      isDefaultAgent: true,
      displayName: "Okou",
      description: "Updated default profile",
      sound: "friendly",
      visibility: "public",
    });
    for (const [body, errorCode] of [
      [{ displayName: "Renamed" }, "DEFAULT_AGENT_NAME_LOCKED"],
      [{ avatarUrl: "preset:4" }, "DEFAULT_AGENT_AVATAR_LOCKED"],
      [{ visibility: "private" }, "DEFAULT_AGENT_VISIBILITY_LOCKED"],
    ] as const) {
      const response = await accept(
        agentsClient().updateMetadata({
          params: { id: agentId },
          headers: authHeaders(),
          body: { ...body, description: "Rejected\0profile" },
        }),
        [400],
      );
      expect(response.body.error.code).toBe(errorCode);
      const current = await accept(
        agentsClient().get({ params: { id: agentId }, headers: authHeaders() }),
        [200],
      );
      expect(current.body).toStrictEqual(saved.body);
    }
  });

  it("preserves UTF8 text encoding through metadata updates", async () => {
    const owner = newOrgUser();
    const agent = await createAgentAs(owner);
    const updated = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { description: "Profile \ud800 and \ud83d\ude00" },
      }),
      [200],
    );
    expect(updated.body.description).toBe("Profile \ufffd and \ud83d\ude00");
    const current = await accept(
      agentsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body).toStrictEqual(updated.body);
  });

  it("orders metadata edits using the application clock", async () => {
    const owner = newOrgUser();
    mockNow(new Date("2030-10-27T01:00:00.123Z"));
    const first = await createAgentAs(owner, { displayName: "First" });
    mockNow(new Date("2030-10-27T01:01:00.456Z"));
    const second = await createAgentAs(owner, { displayName: "Second" });
    mockNow(new Date("2030-10-27T01:02:00.789Z"));
    await accept(
      agentsClient().updateMetadata({
        params: { id: first.agentId },
        headers: authHeaders(),
        body: { description: "Most recently saved metadata" },
      }),
      [200],
    );
    const listed = await accept(
      agentsCollectionClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      listed.body.map((agent) => {
        return agent.agentId;
      }),
    ).toStrictEqual([first.agentId, second.agentId]);
  });

  it("allows an owner to update private agent metadata without changing visibility", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Private Agent",
      visibility: "private",
    });

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Owner Updated Private Agent" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      displayName: "Owner Updated Private Agent",
      visibility: "private",
    });
  });
});

describe("PUT /api/agents/:id/instructions", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      instructionsClient().update({
        params: { id: randomUUID() },
        headers: {},
        body: { content: "new instructions" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("updates instructions and preserves Agent metadata with workflow bindings", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Instructions Agent",
    });
    await createWorkflowFor(user, agent.agentId, "existing-skill");
    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { content: "Use the updated operating notes." },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: user.userId,
      displayName: "Instructions Agent",
    });

    const current = await accept(
      instructionsClient().get({
        params: { id: agent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      content: "Use the updated operating notes.",
      filename: "CLAUDE.md",
    });
  });

  it("allows an owner CLI token to update instructions", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "CLI Instructions Agent",
    });

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: await cliAuthHeaders(user, "member"),
        body: { content: "Use CLI-authenticated operating notes." },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: user.userId,
      displayName: "CLI Instructions Agent",
    });
  });

  it("allows an owner member to update private agent instructions", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, { visibility: "private" });
    mocks.clerk.session(user.userId, user.orgId, "org:member");

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { content: "owner update" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId: agent.agentId,
      ownerId: user.userId,
      visibility: "private",
    });
  });

  it("returns 403 when a non-owner member updates another user's instructions", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user);
    mocks.clerk.session(`user_${randomUUID()}`, user.orgId, "org:member");

    const response = await accept(
      instructionsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { content: "not allowed" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message:
          "Only the agent owner or org admin can update agent instructions",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 for an unknown agent", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);
    const agentId = randomUUID();

    const response = await accept(
      instructionsClient().update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { content: "missing" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${agentId}`, code: "NOT_FOUND" },
    });
  });
});

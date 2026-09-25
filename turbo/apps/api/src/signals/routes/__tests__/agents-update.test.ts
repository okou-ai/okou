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

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
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

function s3CommandInput(command: unknown): Record<string, unknown> {
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

function s3PutInputs(): readonly Record<string, unknown>[] {
  return context.mocks.s3.send.mock.calls.map(([command]) => {
    return s3CommandInput(command);
  });
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

  it("returns 403 for a sandbox token without agent:write capability", async () => {
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
      agentsClient().update({
        params: { id: randomUUID() },
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

  it("returns 400 for invalid path params", async () => {
    const response = await accept(
      agentsClient().update({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
        body: {},
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("updates agent metadata and model selection while preserving omitted fields", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Old Agent",
      sound: "calm",
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
      sound: "calm",
      modelProviderId: null,
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

  it("allows an owner member to update their own agent", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Member Agent",
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
    });
  });
  it("returns 403 when a non-owner member updates another user's agent", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user);
    mocks.clerk.session(`user_${randomUUID()}`, user.orgId, "org:member");

    const response = await accept(
      agentsClient().update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { displayName: "Nope" },
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
});

describe("PATCH /api/agents/:id", () => {
  it("returns 403 for a sandbox token without agent:write capability", async () => {
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
      agentsClient().updateMetadata({
        params: { id: randomUUID() },
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
      preferPersonalProvider: false,
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
    const agent = await createAgentAs(user, { visibility: "public" });
    mocks.clerk.session(adminUserId, user.orgId, "org:admin");

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { visibility: "private" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only the agent owner can update agent visibility",
        code: "FORBIDDEN",
      },
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
    const privateAgent = await createAgentAs(user, { visibility: "private" });

    const response = await accept(
      agentsClient().updateMetadata({
        params: { id: privateAgent.agentId },
        headers: authHeaders(),
        body: { visibility: "public" },
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

  it("returns 403 for a sandbox token without agent:write capability", async () => {
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
      instructionsClient().update({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
        body: { content: "new instructions" },
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

  it("returns 400 for an invalid agent id", async () => {
    const user = newOrgUser();
    mocks.clerk.session(user.userId, user.orgId);

    const response = await accept(
      instructionsClient().update({
        params: { id: "not-a-uuid" },
        headers: authHeaders(),
        body: { content: "new instructions" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "id: Invalid UUID",
        code: "BAD_REQUEST",
      },
    });
  });

  it("updates instructions storage and preserves agent metadata", async () => {
    const user = newOrgUser();
    const agent = await createAgentAs(user, {
      displayName: "Instructions Agent",
    });
    await createWorkflowFor(user, agent.agentId, "existing-skill");
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});

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

    const putInputs = s3PutInputs();
    const manifestPut = putInputs.find((input) => {
      return String(input.Key).endsWith("/manifest.json");
    });
    const archivePut = putInputs.find((input) => {
      return String(input.Key).endsWith("/archive.tar.gz");
    });
    expect(manifestPut?.Bucket).toBe("test-user-storages");
    expect(archivePut?.Bucket).toBe("test-user-storages");

    const manifestBody = JSON.parse(String(manifestPut?.Body)) as {
      readonly files: readonly { readonly path: string }[];
    };
    const paths = manifestBody.files.map((file) => {
      return file.path;
    });
    expect(paths).toStrictEqual(["CLAUDE.md", "AGENTS.md"]);
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

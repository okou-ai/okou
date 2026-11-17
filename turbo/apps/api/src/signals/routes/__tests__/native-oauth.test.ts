import { randomUUID } from "node:crypto";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now, mockNow } from "../../../lib/time";
import { projectRoutes } from "../projects";
import { chatThreadRoutes } from "../chat-threads";
import { realtimeTokenRoutes } from "../realtime-token";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { voiceIoTranscribeRoutes } from "../voice-io-transcribe";
import { voiceIoPolishRoutes } from "../voice-io-polish";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const mcp = createMcpWebApi(context);
const raw = setupRawAppRequest({
  context,
  routes: [
    ...projectRoutes,
    ...chatThreadRoutes,
    ...realtimeTokenRoutes,
    ...voiceIoQuotaRoutes,
    ...voiceIoTranscribeRoutes,
    ...voiceIoPolishRoutes,
  ],
});

function request(token: string, path: string, method = "GET", body?: unknown) {
  return raw(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function project(actor: ApiTestUser, name: string) {
  if (!actor.orgId) {
    throw new Error("Project requires an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.SingleAgent]: true,
    },
  );
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const id = createProjectOperationId(now(), randomUUID());
  return (
    await accept(
      setupApp({ context, routes: projectRoutes })(projectsContract).create({
        headers: { authorization: "Bearer clerk-session" },
        body: { id, eventId: id, name },
      }),
      [201],
    )
  ).body;
}

async function thread(actor: ApiTestUser) {
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(actor, {
    displayName: "Native OAuth",
    visibility: "private",
  });
  return await chat.createThread(actor, {
    agentId: agent.agentId,
    model: null,
  });
}

describe("native organization OAuth grants", () => {
  it("reads only the grant owner's projects without granting project mutations", async () => {
    const actor = bdd.user();
    const owned = await project(actor, "Owned project");
    const otherOrg = await project(
      bdd.user({ userId: actor.userId }),
      "Other workspace",
    );
    const otherUser = await project(
      bdd.user({ orgId: actor.orgId }),
      "Other member",
    );
    const token = mcp.authorize(actor)({
      scope: "user:org:read okou:project:read",
    });
    const listed = await request(token, "/api/projects");
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      projects: [{ id: owned.id, name: "Owned project" }],
    });
    for (const path of [
      "/api/projects/snapshot",
      "/api/projects/events",
      `/api/projects/${owned.id}`,
      `/api/projects/${owned.id}/threads`,
    ]) {
      expect((await request(token, path)).status).toBe(200);
    }
    for (const id of [otherOrg.id, otherUser.id]) {
      expect((await request(token, `/api/projects/${id}`)).status).toBe(404);
      expect((await request(token, `/api/projects/${id}/threads`)).status).toBe(
        404,
      );
    }
    expect((await request(token, "/api/projects", "POST", {})).status).toBe(
      401,
    );
    expect(
      (await request(token, `/api/projects/${owned.id}`, "PATCH", {})).status,
    ).toBe(401);
    expect(
      (await request(token, `/api/projects/${owned.id}`, "DELETE", {})).status,
    ).toBe(401);
  });

  it("reads metadata and marks only same-workspace owned threads read", async () => {
    const actor = bdd.user();
    const owned = await thread(actor);
    const otherOrg = await thread(bdd.user({ userId: actor.userId }));
    const otherUser = await thread(bdd.user({ orgId: actor.orgId }));
    const token = mcp.authorize(actor)({
      scope: "user:org:read okou:chat:read",
    });
    const metadata = await request(
      token,
      `/api/chat-threads/${owned.id}/metadata`,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({ id: owned.id });
    const marked = await request(
      token,
      `/api/chat-threads/${owned.id}/mark-read`,
      "POST",
      {},
    );
    expect(marked.status).toBe(200);
    expect(marked.body).toHaveProperty("lastReadAt");
    for (const id of [otherOrg.id, otherUser.id]) {
      expect(
        (await request(token, `/api/chat-threads/${id}/metadata`)).status,
      ).toBe(404);
      expect(
        (await request(token, `/api/chat-threads/${id}/mark-read`, "POST", {}))
          .status,
      ).toBe(404);
    }
  });

  it.each([
    {
      scope: "okou:chat:read okou:project:read okou:voice:transcribe",
      path: "/api/realtime/token",
      method: "POST",
    },
    {
      scope: "user:org:read okou:chat:send",
      path: "/api/realtime/token",
      method: "POST",
    },
    {
      scope: "user:org:read okou:chat:read",
      path: "/api/projects",
      method: "GET",
    },
    {
      scope: "user:org:read okou:chat:read",
      path: "/api/voice-io/quota",
      method: "GET",
    },
    {
      scope: "user:org:read okou:chat:send",
      path: `/api/chat-threads/${randomUUID()}/metadata`,
      method: "GET",
    },
    {
      scope: "user:org:read okou:chat:send",
      path: `/api/chat-threads/${randomUUID()}/mark-read`,
      method: "POST",
    },
    {
      scope: "user:org:read okou:chat:read",
      path: "/api/voice-io/transcribe/segment",
      method: "POST",
    },
    {
      scope: "user:org:read okou:chat:read",
      path: "/api/voice-io/polish/segments",
      method: "POST",
    },
  ])(
    "rejects insufficient grants on $path ($scope)",
    async ({ scope, path, method }) => {
      const token = mcp.authorize(bdd.user())({ scope });
      expect(
        (await request(token, path, method, method === "POST" ? {} : undefined))
          .status,
      ).toBe(path === "/api/realtime/token" ? 401 : 403);
    },
  );

  it("issues only chat subscriptions bounded by the OAuth grant's expiration", async () => {
    mockNow(Math.floor(now() / 1000) * 1000);
    const actor = bdd.user();
    const expiresAt = Math.floor(now() / 1000) + 120;
    const token = mcp.authorize(actor)({
      scope: "user:org:read okou:chat:read",
      exp: expiresAt,
    });
    const capability = {
      [`user-org:${actor.userId}:${actor.orgId}`]: ["subscribe"],
      [`run-output:${actor.userId}:${actor.orgId}:*`]: ["subscribe"],
    };
    const signed = {
      keyName: "key",
      timestamp: now(),
      ttl: 120_000,
      capability: JSON.stringify(capability),
      clientId: actor.userId,
      nonce: "nonce",
      mac: "mac",
    };
    context.mocks.ably.createTokenRequest.mockResolvedValue(signed);
    const response = await request(token, "/api/realtime/token", "POST", {});
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual(signed);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability,
      clientId: actor.userId,
      ttl: 120_000,
    });
  });
});

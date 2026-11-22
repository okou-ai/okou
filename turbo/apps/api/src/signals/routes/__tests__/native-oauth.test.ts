import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { array, number, object, record, string } from "zod";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { projectRoutes } from "../projects";
import { chatThreadRoutes } from "../chat-threads";
import { realtimeTokenRoutes } from "../realtime-token";
import { voiceIoQuotaRoutes } from "../voice-io-quota";
import { voiceIoTranscribeRoutes } from "../voice-io-transcribe";
import { voiceIoPolishRoutes } from "../voice-io-polish";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMcpWebApi } from "./helpers/mcp-web-api";
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
  await bdd.createAgent(actor, {
    displayName: "Native OAuth",
    visibility: "private",
  });
  return await chat.createThread(actor, {
    model: null,
  });
}

function signedTokenRequest(input: unknown) {
  const params = object({
    timestamp: number(),
    ttl: number(),
    capability: record(string(), array(string())),
    clientId: string(),
  }).parse(input);
  return Promise.resolve({
    ...params,
    capability: JSON.stringify(params.capability),
    keyName: "key",
    nonce: "nonce",
    mac: "mac",
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
      scope: "okou:project:read",
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

  it("creates one owned thread for repeated requests with the same client thread ID", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await bdd.createAgent(actor, {
      displayName: "Native Chat Creation",
      visibility: "private",
    });
    const authorize = mcp.authorize(actor);
    const token = authorize({ scope: "okou:chat:send okou:chat:read" });
    const readOnlyToken = authorize({
      scope: "okou:chat:read",
    });
    const payload = { clientThreadId: randomUUID(), title: "Cardputer Zero" };
    expect(
      (await request(readOnlyToken, "/api/chat-threads", "POST", payload))
        .status,
    ).toBe(403);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(
        token,
        "/api/chat-threads",
        "POST",
        payload,
      );
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        id: payload.clientThreadId,
        title: payload.title,
      });
    }
    const metadata = await request(
      token,
      `/api/chat-threads/${payload.clientThreadId}/metadata`,
    );
    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({ id: payload.clientThreadId });
  });

  it("reads metadata and marks only same-workspace owned threads read", async () => {
    const actor = bdd.user();
    const owned = await thread(actor);
    const otherOrg = await thread(bdd.user({ userId: actor.userId }));
    const otherUser = await thread(bdd.user({ orgId: actor.orgId }));
    const token = mcp.authorize(actor)({
      scope: "okou:chat:read",
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

  it.each([121, 7200])(
    "bounds chat credentials at the latest redemption time for a %is grant",
    async (remainingSeconds) => {
      mockNow(Math.floor(now() / 1000) * 1000);
      const timestamp = now();
      const actor = bdd.user();
      const expiresAtMs = timestamp + remainingSeconds * 1000;
      const token = mcp.authorize(actor)({
        scope: "okou:chat:read",
        exp: expiresAtMs / 1000,
      });
      context.mocks.ably.createTokenRequest.mockImplementation(
        signedTokenRequest,
      );
      const response = await request(token, "/api/realtime/token", "POST", {});
      expect(response.status).toBe(200);
      const signed = object({ timestamp: number(), ttl: number() }).parse(
        response.body,
      );
      expect(response.body).toStrictEqual({
        keyName: "key",
        timestamp,
        ttl: Math.min(3_600_000, remainingSeconds * 1000 - 120_000),
        capability: JSON.stringify({
          [`user-org:${actor.userId}:${actor.orgId}`]: ["subscribe"],
          [`run-output:${actor.userId}:${actor.orgId}:*`]: ["subscribe"],
        }),
        clientId: actor.userId,
        nonce: "nonce",
        mac: "mac",
      });
      // Ably starts TTL at exchange, which may be delayed for the full window.
      const latestRedemptionMs = signed.timestamp + 120_000;
      expect(latestRedemptionMs + signed.ttl).toBeLessThanOrEqual(expiresAtMs);
    },
  );

  it.each([0, 30, 119, 120])(
    "rejects a realtime grant with only %is remaining using the existing 401 envelope",
    async (remainingSeconds) => {
      mockNow(Math.floor(now() / 1000) * 1000);
      const token = mcp.authorize(bdd.user())({
        scope: "user:org:read okou:chat:read",
        exp: now() / 1000 + remainingSeconds,
      });
      context.mocks.ably.createTokenRequest.mockImplementation(
        signedTokenRequest,
      );
      const response = await request(token, "/api/realtime/token", "POST", {});
      expect(response.status).toBe(401);
      expect(response.body).toStrictEqual({
        error: { message: "Authentication required", code: "UNAUTHORIZED" },
      });
      expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects credentials when provider work crosses the OAuth expiration", async () => {
    mockNow(Math.floor(now() / 1000) * 1000);
    const expiresAtMs = now() + 300_000;
    const token = mcp.authorize(bdd.user())({
      scope: "user:org:read okou:chat:read",
      exp: expiresAtMs / 1000,
    });
    context.mocks.ably.createTokenRequest.mockImplementation(
      (input: unknown) => {
        mockNow(expiresAtMs);
        return signedTokenRequest(input);
      },
    );
    const response = await request(token, "/api/realtime/token", "POST", {});
    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
  });

  it("rejects a grant that expires during Clerk membership authentication", async () => {
    mockNow(Math.floor(now() / 1000) * 1000);
    const expiresAtMs = now() + 300_000;
    const actor = bdd.user();
    const token = mcp.authorize(actor)({
      scope: "user:org:read okou:chat:read",
      exp: expiresAtMs / 1000,
    });
    const sdk =
      await vi.importActual<typeof import("@clerk/backend")>("@clerk/backend");
    const client = sdk.createClerkClient({ secretKey: "sk_test_native_oauth" });
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      (input: unknown) => {
        return client.users.getOrganizationMembershipList(
          object({ userId: string(), limit: number().optional() }).parse(input),
        );
      },
    );
    server.use(
      http.get(
        "https://api.clerk.com/v1/users/:userId/organization_memberships",
        () => {
          mockNow(expiresAtMs);
          return HttpResponse.json({
            data: [
              {
                id: `mem_${actor.userId}`,
                object: "organization_membership",
                role: "org:member",
                created_at: 1,
                updated_at: 1,
                organization: {
                  id: actor.orgId,
                  object: "organization",
                  name: "Native OAuth",
                  slug: null,
                  image_url: "",
                  has_image: false,
                  created_at: 1,
                  updated_at: 1,
                },
                public_user_data: { user_id: actor.userId },
              },
            ],
            total_count: 1,
          });
        },
      ),
    );
    context.mocks.ably.createTokenRequest.mockImplementation(
      signedTokenRequest,
    );
    const response = await request(token, "/api/realtime/token", "POST", {});
    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });
});

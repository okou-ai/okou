import { dataRouterToolsContract } from "@okouai/api-contracts/contracts/data-router-catalog";
import { http, HttpResponse } from "msw";
import { literal, object, string } from "zod";
import { server } from "../../../mocks/server";
import { dataRouterToolsRoutes } from "../data-router-tools";
import { randomUUID } from "node:crypto";

import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { generateOkouToken, generateSandboxToken } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { paidToolsRoutes } from "../paid-tools";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: paidToolsRoutes })(paidToolsContract);
}

async function owner(overrides: { orgId?: string; userId?: string } = {}) {
  const identity = {
    orgId: overrides.orgId ?? `org_paid_tools_${randomUUID()}`,
    userId: overrides.userId ?? `user_paid_tools_${randomUUID()}`,
    membershipId: `orgmem_${randomUUID()}`,
    orgRole: "org:member" as const,
  };
  await store.set(seedOrgMembership$, identity, context.signal);
  mocks.clerk.session(identity.userId, identity.orgId, identity.orgRole);
  mocks.s3.listObjects([]);
  return identity;
}

async function listFor(identity: { orgId: string; userId: string }) {
  mocks.clerk.session(identity.userId, identity.orgId, "org:member");
  return (await accept(client().get({ headers }), [200])).body.disabledTools;
}

test("lets an ordinary member disable and re-enable a tool idempotently", async () => {
  const identity = await owner();
  await expect(listFor(identity)).resolves.toStrictEqual([]);
  for (const disabled of [false, true, true]) {
    const result = await accept(
      client().update({
        headers,
        params: { toolId: "web-search" },
        body: { disabled },
      }),
      [200],
    );
    expect(result.body).toStrictEqual({ toolId: "web-search", disabled });
  }
  await accept(
    client().update({
      headers,
      params: { toolId: "social" },
      body: { disabled: true },
    }),
    [200],
  );
  await expect(listFor(identity)).resolves.toStrictEqual([
    "social",
    "web-search",
  ]);
  for (const disabled of [false, false]) {
    await accept(
      client().update({
        headers,
        params: { toolId: "web-search" },
        body: { disabled },
      }),
      [200],
    );
  }
  await expect(listFor(identity)).resolves.toStrictEqual(["social"]);
});

test.each([
  "data-search",
  "data:future_research",
  "image-generation",
  "video-generation",
  "voice-generation",
  "avatar-video-generation",
] as const)("saves and re-enables the %s preference", async (toolId) => {
  const identity = await owner();
  await accept(
    client().update({
      headers,
      params: { toolId: "web-search" },
      body: { disabled: true },
    }),
    [200],
  );
  const disabled = await accept(
    client().update({
      headers,
      params: { toolId },
      body: { disabled: true },
    }),
    [200],
  );
  expect(disabled.body).toStrictEqual({ toolId, disabled: true });
  await expect(listFor(identity)).resolves.toStrictEqual([
    toolId,
    "web-search",
  ]);
  const enabled = await accept(
    client().update({
      headers,
      params: { toolId },
      body: { disabled: false },
    }),
    [200],
  );
  expect(enabled.body).toStrictEqual({ toolId, disabled: false });
  await expect(listFor(identity)).resolves.toStrictEqual(["web-search"]);
});

test("isolates preferences across members and workspaces", async () => {
  const current = await owner();
  await accept(
    client().update({
      headers,
      params: { toolId: "web-search" },
      body: { disabled: true },
    }),
    [200],
  );
  const peer = await owner({ orgId: current.orgId });
  await expect(listFor(peer)).resolves.toStrictEqual([]);
  await accept(
    client().update({
      headers,
      params: { toolId: "finance" },
      body: { disabled: true },
    }),
    [200],
  );
  const elsewhere = await owner({ userId: current.userId });
  await expect(listFor(elsewhere)).resolves.toStrictEqual([]);
  await accept(
    client().update({
      headers,
      params: { toolId: "scrape" },
      body: { disabled: true },
    }),
    [200],
  );
  await expect(listFor(current)).resolves.toStrictEqual(["web-search"]);
  await expect(listFor(peer)).resolves.toStrictEqual(["finance"]);
  await expect(listFor(elsewhere)).resolves.toStrictEqual(["scrape"]);
});

test("preserves independent tool changes submitted concurrently", async () => {
  const identity = await owner();
  await Promise.all(
    (["maps", "seo"] as const).map(async (toolId) => {
      await accept(
        client().update({
          headers,
          params: { toolId },
          body: { disabled: true },
        }),
        [200],
      );
    }),
  );
  await expect(listFor(identity)).resolves.toStrictEqual(["maps", "seo"]);
});

test("rejects caller-selected owners", async () => {
  const identity = await owner();
  const request = setupRawAppRequest({ context, routes: paidToolsRoutes });
  for (const [toolId, body] of [
    ["web-search", { disabled: true, userId: "another-user" }],
    ["web-search", { disabled: true, orgId: "another-org" }],
  ] as const) {
    const response = await request(`/api/paid-tools/${toolId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  await expect(listFor(identity)).resolves.toStrictEqual([]);
});

test("requires a workspace session and rejects run credentials", async () => {
  const identity = await owner();
  await accept(
    client().update({
      headers,
      params: { toolId: "web-search" },
      body: { disabled: true },
    }),
    [200],
  );
  await accept(client().get({ headers: {} }), [401]);
  mocks.clerk.session(identity.userId, null);
  await accept(client().get({ headers }), [401]);
  mocks.clerk.session(identity.userId, identity.orgId, "org:member");
  for (const token of [
    generateOkouToken(identity.userId, randomUUID(), identity.orgId),
    generateSandboxToken(identity.userId, randomUUID(), identity.orgId),
  ]) {
    const runHeaders = { authorization: `Bearer ${token}` };
    await accept(client().get({ headers: runHeaders }), [403]);
    await accept(
      client().update({
        headers: runHeaders,
        params: { toolId: "web-search" },
        body: { disabled: false },
      }),
      [403],
    );
  }
  await expect(listFor(identity)).resolves.toStrictEqual(["web-search"]);
});

test("membership deletion clears exactly its paid tool preferences", async () => {
  const current = await owner();
  const peer = await owner({ orgId: current.orgId });
  const elsewhere = await owner({ userId: current.userId });
  for (const identity of [current, peer, elsewhere]) {
    mocks.clerk.session(identity.userId, identity.orgId, "org:member");
    await accept(
      client().update({
        headers,
        params: { toolId: "web-search" },
        body: { disabled: true },
      }),
      [200],
    );
  }
  const event = {
    type: "organizationMembership.deleted",
    data: {
      id: current.membershipId,
      organization_id: current.orgId,
      user_id: current.userId,
    },
  };
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "paid-tools-test-secret");
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce(event);
  await accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({ body: JSON.stringify(event) }),
    [200],
  );
  await flushWaitUntilForTest();

  await expect(listFor(current)).resolves.toStrictEqual([]);
  await expect(listFor(peer)).resolves.toStrictEqual(["web-search"]);
  await expect(listFor(elsewhere)).resolves.toStrictEqual(["web-search"]);
});

test("discovers Router tools and schemas across pages without a local tool catalog", async () => {
  await owner();
  mockEnv("OKOU_DATA_ROUTER_URL", "https://router.test/mcp");
  mockEnv("OKOU_DATA_TOKEN", "test-router-token");
  const tool = {
    name: "future_research",
    title: "New research tool",
    description: "New Router capability",
    inputSchema: {
      type: "object" as const,
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
    _meta: { "ai.okou/data": { family: "data-search" as const } },
  };
  server.use(
    http.post("https://router.test/mcp", async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-router-token",
      );
      const message = object({
        id: string(),
        method: literal("tools/list"),
        params: object({ cursor: string().optional() }),
      }).parse(await request.json());
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.params.cursor === "next-page"
            ? { tools: [tool] }
            : {
                tools: [
                  { name: "billing_get", inputSchema: { type: "object" } },
                ],
                nextCursor: "next-page",
              },
      });
    }),
  );
  const result = await accept(
    setupApp({ context, routes: dataRouterToolsRoutes })(
      dataRouterToolsContract,
    ).list({ headers }),
    [200],
  );
  expect(result.body).toStrictEqual({ tools: [tool] });
});

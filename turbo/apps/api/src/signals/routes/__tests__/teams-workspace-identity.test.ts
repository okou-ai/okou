import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { integrationsTeamsUploadInitRoutes } from "../integrations-teams-upload-init";
import { integrationsTeamsUploadCompleteRoutes } from "../integrations-teams-upload-complete";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { object, string } from "zod";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createHash, randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, test } from "vitest";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import {
  integrationsTeamsMessageContract,
  integrationsTeamsUploadInitContract,
  integrationsTeamsUploadCompleteContract,
} from "@okouai/api-contracts/contracts/integrations";
import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { teamsConnectRoutes } from "../teams-connect";
import { teamsOauthRoutes } from "../teams-oauth";
import { integrationsTeamsMessageRoutes } from "../integrations-teams-message";
import { teamsBrowserConnectRoutes } from "../teams-browser-connect";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  postTeamsActivityForTest,
  teamsMessageActivityForTest,
} from "./helpers/teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const origin = "https://api.okou.test";

function authenticate(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: actor.orgId }, role: actor.orgRole }],
    totalCount: 1,
  });
}
function clients() {
  return setupApp({
    context,
    routes: [
      ...teamsConnectRoutes,
      ...integrationsTeamsMessageRoutes,
      ...integrationsTeamsUploadInitRoutes,
      ...integrationsTeamsUploadCompleteRoutes,
    ],
  });
}
function app() {
  return createAppWithRoutes({
    signal: context.signal,
    routes: [...teamsOauthRoutes, ...teamsBrowserConnectRoutes],
  });
}
function jwt(payload: object) {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

beforeEach(() => {
  setupTeamsConnectTestEnv();
  mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "identity-client");
  mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "identity-secret");
});

async function enabledActor(
  orgRole: "org:admin" | "org:member" = "org:member",
) {
  const actor = bdd.user({ orgRole });
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  const owner = { ...actor, orgId: actor.orgId };
  await updateFeatureSwitchesForUser(context, owner, {
    teamsWorkspaceIdentity: true,
  });
  return owner;
}
async function status(actor: ApiTestUser) {
  authenticate(actor);
  return (
    await accept(clients()(teamsConnectContract).getStatus({ headers }), [200])
  ).body;
}
async function oauth(
  actor: ApiTestUser,
  tenantId: string,
  aadObjectId: string,
  flow: "connect" | "install" | "reconnect" = "connect",
) {
  authenticate(actor);
  server.use(
    http.post(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      () => {
        return HttpResponse.json({
          access_token: "verified-ms-token",
          id_token: jwt({ tid: tenantId, oid: aadObjectId }),
        });
      },
    ),
    http.get("https://graph.microsoft.com/v1.0/me", () => {
      return HttpResponse.json({
        id: aadObjectId,
        displayName: "Verified person",
        userPrincipalName: "person@example.test",
      });
    }),
  );
  const current = await status(actor);
  const url =
    flow === "reconnect"
      ? `${origin}/api/teams/oauth/connect`
      : flow === "install"
        ? current.installUrl
        : current.connectUrl;
  if (!url) {
    throw new Error("Expected an OAuth entry URL");
  }
  const started = await app().request(url, { headers });
  expect(started.status).toBe(307);
  const state = new URL(started.headers.get("location")!).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected a Microsoft OAuth state");
  }
  return await app().request(
    `${origin}/api/integrations/teams/oauth/callback?${new URLSearchParams({ state, code: "verified-code" })}`,
    { headers },
  );
}
function expectOAuthSuccess(response: Response) {
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.searchParams.get("error")).toBeNull();
  return location;
}

test("a member connects an OAuth identity before installation and can disconnect it", async () => {
  const actor = await enabledActor();
  const fixture = teamsConnectFixture();
  expectOAuthSuccess(
    await oauth(actor, fixture.teamsTenantId, fixture.teamsAadObjectId),
  );
  await expect(status(actor)).resolves.toMatchObject({
    workspaceIdentity: true,
    isConnected: true,
    isInstalled: false,
    isAdmin: false,
    installUrl: null,
    linkedAccounts: [
      {
        tenantId: fixture.teamsTenantId,
        teamsAadObjectId: fixture.teamsAadObjectId,
      },
    ],
  });
  await accept(
    clients()(teamsConnectContract).disconnect({ headers, query: {} }),
    [200],
  );
  await expect(status(actor)).resolves.toMatchObject({
    isConnected: false,
    isInstalled: false,
    connectUrl: expect.any(String),
  });
});

test("connecting to an installed tenant leaves bot ownership with its original organization", async () => {
  const fixture = teamsConnectFixture();
  await installTeamsForTest(context.signal, fixture);
  const owner = bdd.user({ userId: fixture.userId, orgId: fixture.orgId });
  authenticate(owner);
  await accept(
    clients()(teamsConnectContract).connect({
      headers,
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsAadObjectId: fixture.teamsAadObjectId,
      },
    }),
    [200],
  );
  const actor = await enabledActor();
  expectOAuthSuccess(
    await oauth(
      actor,
      fixture.teamsTenantId,
      `external-${fixture.teamsAadObjectId}`,
    ),
  );
  await expect(status(actor)).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
  });
  await accept(
    clients()(integrationsTeamsMessageContract).sendMessage({
      headers,
      body: {
        conversationId: fixture.teamsConversationId,
        text: "No web-session source authority",
      },
    }),
    [404],
  );
  await expect(status(owner)).resolves.toMatchObject({
    isConnected: true,
    isInstalled: true,
  });
  await removeTeamsForTest(context.signal, fixture);
});

test("raw identity payloads cannot create an independent account connection", async () => {
  const actor = await enabledActor();
  const fixture = teamsConnectFixture();
  authenticate(actor);
  await accept(
    clients()(teamsConnectContract).connect({
      headers,
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsAadObjectId: fixture.teamsAadObjectId,
      },
    }),
    [403],
  );
  const response = await app().request(
    `${origin}/api/teams/connect?${new URLSearchParams({
      tenantId: fixture.teamsTenantId,
      teamsUserId: fixture.teamsUserId,
      orgId: fixture.orgId,
    })}`,
    { headers },
  );
  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location")!).pathname).toBe(
    "/api/teams/oauth/connect",
  );
  await expect(status(actor)).resolves.toMatchObject({ isConnected: false });
});

test("another user cannot take an OAuth identity and account changes require disconnect", async () => {
  const fixture = teamsConnectFixture();
  const actor = await enabledActor();
  expectOAuthSuccess(
    await oauth(actor, fixture.teamsTenantId, fixture.teamsAadObjectId),
  );
  const other = await enabledActor();
  const conflict = await oauth(
    other,
    fixture.teamsTenantId,
    fixture.teamsAadObjectId,
  );
  expect(
    new URL(conflict.headers.get("location")!).searchParams.get("error"),
  ).toMatch(/Disconnect/u);
  await expect(status(other)).resolves.toMatchObject({ isConnected: false });
  const otherOrganization = bdd.user({ userId: actor.userId });
  if (!otherOrganization.orgId) {
    throw new Error("Expected an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...otherOrganization, orgId: otherOrganization.orgId },
    { teamsWorkspaceIdentity: true },
  );
  const moved = await oauth(
    otherOrganization,
    fixture.teamsTenantId,
    fixture.teamsAadObjectId,
  );
  expect(
    new URL(moved.headers.get("location")!).searchParams.get("error"),
  ).toMatch(/Disconnect/u);

  authenticate(actor);
  // A connected account has no connect URL: a direct authenticated start is still
  // checked against the saved identity on completion.
  const started = await app().request(`${origin}/api/teams/oauth/connect`, {
    headers,
  });
  const state = new URL(started.headers.get("location")!).searchParams.get(
    "state",
  )!;
  server.use(
    http.get("https://graph.microsoft.com/v1.0/me", () => {
      return HttpResponse.json({ id: randomUUID() });
    }),
  );
  const changed = await app().request(
    `${origin}/api/integrations/teams/oauth/callback?${new URLSearchParams({ state, code: "different-account" })}`,
    { headers },
  );
  expect(
    new URL(changed.headers.get("location")!).searchParams.get("error"),
  ).toMatch(/Disconnect/u);
  expect((await status(actor)).linkedAccounts[0]?.teamsAadObjectId).toBe(
    fixture.teamsAadObjectId,
  );
  await accept(
    clients()(teamsConnectContract).disconnect({ headers, query: {} }),
    [200],
  );
  const next = teamsConnectFixture();
  expectOAuthSuccess(
    await oauth(actor, next.teamsTenantId, next.teamsAadObjectId),
  );
  expect((await status(actor)).linkedAccounts[0]?.teamsAadObjectId).toBe(
    next.teamsAadObjectId,
  );
});

test("adopting an installation-owned identity through OAuth preserves its organization", async () => {
  const fixture = teamsConnectFixture();
  await installTeamsForTest(context.signal, fixture);
  const original = bdd.user({ userId: fixture.userId, orgId: fixture.orgId });
  authenticate(original);
  await accept(
    clients()(teamsConnectContract).connect({
      headers,
      body: {
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        teamsAadObjectId: fixture.teamsAadObjectId,
      },
    }),
    [200],
  );
  const other = bdd.user({ userId: original.userId });
  if (!other.orgId) {
    throw new Error("Expected an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...other, orgId: other.orgId },
    { teamsWorkspaceIdentity: true },
  );
  const rejected = await oauth(
    other,
    fixture.teamsTenantId,
    fixture.teamsAadObjectId,
  );
  expect(
    new URL(rejected.headers.get("location")!).searchParams.get("error"),
  ).toMatch(/Disconnect/u);
  await updateFeatureSwitchesForUser(
    context,
    { ...original, orgId: fixture.orgId },
    { teamsWorkspaceIdentity: true },
  );
  expectOAuthSuccess(
    await oauth(
      original,
      fixture.teamsTenantId,
      fixture.teamsAadObjectId,
      "reconnect",
    ),
  );
  await removeTeamsForTest(context.signal, fixture);
  await expect(status(original)).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
    linkedAccounts: [{ teamsAadObjectId: fixture.teamsAadObjectId }],
  });
});

test("an administrator installs the bot separately and uninstall preserves the OAuth identity", async () => {
  const actor = await enabledActor("org:admin");
  const identity = teamsConnectFixture();
  const fixture = teamsConnectFixture({
    userId: actor.userId,
    orgId: actor.orgId,
  });
  expectOAuthSuccess(
    await oauth(actor, identity.teamsTenantId, identity.teamsAadObjectId),
  );
  const installed = expectOAuthSuccess(
    await oauth(
      actor,
      fixture.teamsTenantId,
      fixture.teamsAadObjectId,
      "install",
    ),
  );
  expect(installed.hostname).toBe("teams.microsoft.com");
  await installTeamsForTest(context.signal, fixture);
  await expect(status(actor)).resolves.toMatchObject({
    isConnected: true,
    isInstalled: true,
  });
  await accept(
    clients()(teamsConnectContract).disconnect({
      headers,
      query: { action: "uninstall" },
    }),
    [200],
  );
  await expect(status(actor)).resolves.toMatchObject({
    isConnected: true,
    isInstalled: false,
    linkedAccounts: [{ teamsAadObjectId: identity.teamsAadObjectId }],
  });
});

test.each([
  "access",
  "callback",
  "callback-disabled",
  "callback-left",
] as const)(
  "a receiving organization's bot preserves the user's own execution organization (%s)",
  async (scenario) => {
    const installations = createPublicTeamsDispatchFixture(context);
    await installations.run(async () => {
      const receiving = await installations.create({ withDefaultAgent: true });
      const actor = await enabledActor("org:admin");
      const ownRuns = publicRunOwner(context, actor);
      await ownRuns.run(async () => {
        const runs = createRunsApi(context);
        const reads = createRunReadsApi(context);
        const runnerGroup = runs.configureRunnerGroup();
        runs.acceptStorageDownloads();
        runs.acceptTelemetryIngest();
        const agentId = await bdd.bootstrapLimitedFreeOnboarding(actor, {
          displayName: "Identity's own Agent",
        });
        await runs.grantProEntitlement(actor);
        await runs.ensurePersonalSubscriptionModel(actor, {
          model: "claude-fable-5-1",
        });
        const sender = teamsConnectFixture({
          ...receiving.installation,
          orgId: actor.orgId,
          userId: actor.userId,
          teamsUserId: `29:external-${randomUUID()}`,
          teamsAadObjectId: randomUUID(),
        });
        expectOAuthSuccess(
          await oauth(actor, sender.teamsTenantId, sender.teamsAadObjectId),
        );
        let membership = true;
        const messages: { conversationId: string; text?: string }[] = [];
        server.use(
          http.get(
            `${sender.serviceUrl}v3/conversations/:conversationId/members/:memberId`,
            ({ params }) => {
              return membership
                ? HttpResponse.json({
                    id: params.memberId,
                    tenantId: sender.teamsTenantId,
                    aadObjectId: sender.teamsAadObjectId,
                  })
                : new HttpResponse(null, { status: 404 });
            },
          ),
          http.post(
            "https://login.microsoftonline.com/:tenant/oauth2/v2.0/token",
            () => {
              return HttpResponse.json({
                access_token: "graph-token",
                expires_in: 3600,
              });
            },
          ),
          http.get("https://graph.microsoft.com/v1.0/*", () => {
            return HttpResponse.json({ value: [] });
          }),
          http.post(
            `${sender.serviceUrl}v3/conversations/:conversationId/activities`,
            async ({ params, request }) => {
              const body = object({ text: string().optional() }).parse(
                await request.json(),
              );
              messages.push({
                conversationId: String(params.conversationId),
                text: body.text,
              });
              return HttpResponse.json({ id: randomUUID() });
            },
          ),
          http.post(
            `${sender.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
            async ({ params, request }) => {
              const body = object({ text: string().optional() }).parse(
                await request.json(),
              );
              messages.push({
                conversationId: String(params.conversationId),
                text: body.text,
              });
              return HttpResponse.json({ id: randomUUID() });
            },
          ),
          http.put(
            `${sender.serviceUrl}v3/conversations/:conversationId/activities/:activityId/reactions/:reaction`,
            () => {
              return HttpResponse.json({});
            },
          ),
          http.delete(
            `${sender.serviceUrl}v3/conversations/:conversationId/activities/:activityId/reactions/:reaction`,
            () => {
              return HttpResponse.json({});
            },
          ),
        );
        authenticate(actor);
        const incoming = await postTeamsActivityForTest({
          signal: context.signal,
          activity: teamsMessageActivityForTest(sender, {
            id: randomUUID(),
            text: "<at>Nova</at> Produce my report",
          }),
        });
        expect(incoming.status).toBe(200);
        await flushWaitUntilForTest();
        const listed = await reads.requestListLogs(actor, { limit: 50 }, [200]);
        expect(listed.body.data).toHaveLength(1);
        const run = listed.body.data[0]!;
        expect(run).toMatchObject({
          agentId,
          triggerSource: "teams",
          status: "pending",
        });
        await reads.requestReadLogById(receiving.actor, run.id, [404]);
        await runs.heartbeatRunner(runnerGroup);
        const claim = await ownRuns.claim(run.id);
        const token = claim.platformEnvironment?.OKOU_TOKEN;
        expect(token).toStrictEqual(expect.any(String));
        const runHeaders = { authorization: `Bearer ${token}` };
        if (scenario !== "access") {
          if (scenario === "callback-disabled") {
            await updateFeatureSwitchesForUser(context, actor, {
              teamsWorkspaceIdentity: false,
            });
          }
          if (scenario === "callback-left") {
            membership = false;
          }
          const previousMessages = messages.length;
          await createWebhookCallbackApi(context).requestAgentComplete(
            {
              runId: run.id,
              exitCode: 1,
              error: "Cannot continue session from history",
            },
            { authorization: `Bearer ${claim.sandboxToken}` },
            [200],
          );
          await flushWaitUntilForTest();
          if (scenario === "callback") {
            expect(messages).toContainEqual({
              conversationId: sender.teamsConversationId,
              text: expect.stringContaining(
                "Cannot continue session from history",
              ),
            });
          } else {
            expect(messages).toHaveLength(previousMessages);
          }
          return;
        }

        await accept(
          clients()(integrationsTeamsMessageContract).sendMessage({
            headers: runHeaders,
            body: {
              conversationId: sender.teamsConversationId,
              text: "Run-scoped result",
            },
          }),
          [200],
        );
        expect(messages).toContainEqual({
          conversationId: sender.teamsConversationId,
          text: "Run-scoped result",
        });
        await accept(
          clients()(integrationsTeamsMessageContract).sendMessage({
            headers: runHeaders,
            body: {
              conversationId: "19:another-conversation",
              text: "Unrelated destination",
            },
          }),
          [404],
        );
        await accept(
          clients()(integrationsTeamsMessageContract).sendMessage({
            headers: runHeaders,
            body: { user: "me", text: "Source authority is not a DM grant" },
          }),
          [404],
        );
        membership = false;
        await accept(
          clients()(integrationsTeamsMessageContract).sendMessage({
            headers: runHeaders,
            body: {
              conversationId: sender.teamsConversationId,
              text: "Revoked membership",
            },
          }),
          [404],
        );
        membership = true;
        await updateFeatureSwitchesForUser(context, actor, {
          teamsWorkspaceIdentity: false,
        });
        await accept(
          clients()(integrationsTeamsMessageContract).sendMessage({
            headers: runHeaders,
            body: {
              conversationId: sender.teamsConversationId,
              text: "Disabled source authority",
            },
          }),
          [404],
        );
        await updateFeatureSwitchesForUser(context, actor, {
          teamsWorkspaceIdentity: true,
        });
        installSharedThreadStorage(context);
        const bytes = Buffer.from("Canonical Teams report");
        const operationId = randomUUID();
        const prepared = await accept(
          clients()(integrationsTeamsUploadInitContract).init({
            headers: runHeaders,
            body: {
              filename: "report.txt",
              contentType: "text/plain",
              length: bytes.length,
              canonical: {
                operationId,
                checksumSha256: createHash("sha256")
                  .update(bytes)
                  .digest("hex"),
                conversationId: sender.teamsConversationId,
                text: "Pinned report",
              },
            },
          }),
          [200],
        );
        expect(prepared.body.operationId).toBe(operationId);
        const uploaded = await fetch(prepared.body.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "text/plain",
            ...prepared.body.uploadHeaders,
          },
          body: bytes,
        });
        expect(uploaded.status).toBe(200);
        const completion = {
          uploadId: prepared.body.uploadId,
          operationId,
          conversationId: "19:replacement-destination",
          text: "Replacement text",
        };
        membership = false;
        await accept(
          clients()(integrationsTeamsUploadCompleteContract).complete({
            headers: runHeaders,
            body: completion,
          }),
          [404],
        );
        membership = true;
        const delivered = await accept(
          clients()(integrationsTeamsUploadCompleteContract).complete({
            headers: runHeaders,
            body: completion,
          }),
          [200],
        );
        expect(delivered.body).toMatchObject({
          conversationId: sender.teamsConversationId,
          filename: "report.txt",
        });
        expect(
          messages.filter((message) => {
            return message.text?.startsWith("Pinned report");
          }),
        ).toHaveLength(1);
        const uncertainOperation = randomUUID();
        const uncertain = await accept(
          clients()(integrationsTeamsUploadInitContract).init({
            headers: runHeaders,
            body: {
              filename: "uncertain.txt",
              contentType: "text/plain",
              length: bytes.length,
              canonical: {
                operationId: uncertainOperation,
                checksumSha256: createHash("sha256")
                  .update(bytes)
                  .digest("hex"),
                conversationId: sender.teamsConversationId,
                text: "Uncertain file",
              },
            },
          }),
          [200],
        );
        await fetch(uncertain.body.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "text/plain",
            ...uncertain.body.uploadHeaders,
          },
          body: bytes,
        });
        let uncertainSends = 0;
        server.use(
          http.post(
            `${sender.serviceUrl}v3/conversations/:conversationId/activities`,
            async ({ request }) => {
              const body = object({ text: string().optional() }).parse(
                await request.json(),
              );
              if (body.text?.startsWith("Uncertain file")) {
                uncertainSends++;
                return HttpResponse.error();
              }
              return HttpResponse.json({ id: randomUUID() });
            },
          ),
        );
        const uncertainBody = {
          uploadId: uncertain.body.uploadId,
          operationId: uncertainOperation,
          conversationId: sender.teamsConversationId,
        };
        await accept(
          clients()(integrationsTeamsUploadCompleteContract).complete({
            headers: runHeaders,
            body: uncertainBody,
          }),
          [409],
        );
        await accept(
          clients()(integrationsTeamsUploadCompleteContract).complete({
            headers: runHeaders,
            body: uncertainBody,
          }),
          [409],
        );
        expect(uncertainSends).toBe(1);
        await removeTeamsForTest(context.signal, sender);
        await expect(status(actor)).resolves.toMatchObject({
          isConnected: true,
          isInstalled: false,
        });
        // Revocation cannot turn an acknowledged delivery into another provider send.
        authenticate(actor);
        await accept(
          clients()(teamsConnectContract).disconnect({ headers, query: {} }),
          [200],
        );
        const replayed = await accept(
          clients()(integrationsTeamsUploadCompleteContract).complete({
            headers: runHeaders,
            body: completion,
          }),
          [200],
        );
        expect(replayed.body).toStrictEqual(delivered.body);
        expect(
          messages.filter((message) => {
            return message.text?.startsWith("Pinned report");
          }),
        ).toHaveLength(1);
      });
    });
  },
);

test.each([
  "organizationMembership.deleted",
  "organization.deleted",
  "user.deleted",
] as const)(
  "%s releases independent Teams account authority",
  async (eventType) => {
    const actor = await enabledActor("org:admin");
    const fixture = teamsConnectFixture();
    expectOAuthSuccess(
      await oauth(actor, fixture.teamsTenantId, fixture.teamsAadObjectId),
    );
    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: eventType,
      data:
        eventType === "organizationMembership.deleted"
          ? {
              id: randomUUID(),
              organization_id: actor.orgId,
              user_id: actor.userId,
            }
          : {
              id:
                eventType === "organization.deleted"
                  ? actor.orgId
                  : actor.userId,
            },
    });
    await webhooks.requestClerkWebhook("{}", {}, [200]);
    await flushWaitUntilForTest();
    const next = await enabledActor("org:admin");
    expectOAuthSuccess(
      await oauth(next, fixture.teamsTenantId, fixture.teamsAadObjectId),
    );
    await expect(status(next)).resolves.toMatchObject({
      isConnected: true,
      isInstalled: false,
    });
  },
);

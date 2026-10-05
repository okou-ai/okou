import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { teamsConnectRoutes } from "../teams-connect";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { chatEventDisplayText } from "./helpers/chat-event";
import { configureNativeCliArtifact } from "./helpers/chat-events-fixture";
import { createPublicTeamsDispatchFixture } from "./helpers/public-teams-dispatch-fixture";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const TEAMS_TOKEN_URL = "https://teams-auth.test/token";

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface PublicTeamsFixture {
  readonly installation: TeamsConnectFixture;
  readonly kmsKeyId: string | undefined;
  readonly storageBucket: string;
  defaultAgentId: string | null;
  readonly subscriptionId: string;
}

function configurePublicTeamsMocks(fixture: TeamsConnectFixture): void {
  setupTeamsConnectTestEnv();
  mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-app-password");
  mockOptionalEnv("MICROSOFT_TEAMS_BOT_TOKEN_URL", TEAMS_TOKEN_URL);
  context.mocks.s3.send.mockResolvedValue({});
  server.use(
    http.post(TEAMS_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: "teams-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }),
    http.post(`${fixture.serviceUrl}v3/conversations`, () => {
      return HttpResponse.json({ id: `a:welcome-${fixture.fixtureId}` });
    }),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities`,
      () => {
        return HttpResponse.json({ id: "typing-activity" });
      },
    ),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
      () => {
        return HttpResponse.json({ id: "reply-activity" });
      },
    ),
  );
}

async function deletePublicTeamsFixture(
  owned: PublicTeamsFixture,
): Promise<void> {
  const fixture = owned.installation;
  const bdd = createBddApi(context);
  const actor = bdd.user({ userId: fixture.userId, orgId: fixture.orgId });
  const runs = createRunsApi(context);
  const reads = createRunReadsApi(context);
  configurePublicTeamsMocks(fixture);
  mockEnv("SECRETS_KMS_KEY_ID", owned.kmsKeyId);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", owned.storageBucket);
  context.mocks.ably.publish.mockResolvedValue(undefined);
  runs.acceptStorageDownloads();

  const listed = await reads.requestListLogs(actor, { limit: 50 }, [200]);
  for (const run of listed.body.data) {
    if (run.status === "pending" || run.status === "running") {
      await runs.requestCancelRun(actor, run.id, [200]);
    }
  }
  await flushWaitUntilForTest();
  // This case never claims its Run, so cancellation needs no Runner ACK.
  await removeTeamsForTest(context.signal, fixture);
  await flushWaitUntilForTest();

  context.mocks.stripe.subscriptions.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  context.mocks.stripe.invoices.list.mockResolvedValue({
    data: [],
    has_more: false,
  });
  context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
    id: owned.subscriptionId,
    status: "active",
    metadata: {},
  });
  context.mocks.stripe.subscriptions.update.mockResolvedValue({
    id: owned.subscriptionId,
  });
  context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
    id: owned.subscriptionId,
    status: "canceled",
  });
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.deleted",
    data: { id: fixture.orgId },
  });
  await webhooks.requestClerkWebhook("{}", {}, [200]);
  await flushWaitUntilForTest();

  if (owned.defaultAgentId) {
    await bdd.requestReadAgent(actor, owned.defaultAgentId, [404]);
  }
  expect(
    (await reads.requestListLogs(actor, { limit: 50 }, [200])).body.data,
  ).toStrictEqual([]);
}

const trackPublicTeamsFixture = createFixtureTracker(deletePublicTeamsFixture);

describe("Teams message launch context", () => {
  it("dispatches a Teams message with its public launch context", async () => {
    const scenario = createPublicTeamsDispatchFixture(context);
    await scenario.run(async () => {
      const owned = await scenario.create({
        withDefaultAgent: true,
        paidNative: true,
      });
      const fixture = owned.installation;
      await expect(scenario.status(owned)).resolves.toMatchObject({
        isInstalled: true,
        isConnected: true,
        tenantId: fixture.teamsTenantId,
      });
      server.use(
        http.post(
          `https://login.microsoftonline.com/${fixture.teamsTenantId}/oauth2/v2.0/token`,
          () => {
            return HttpResponse.json({
              access_token: "teams-graph-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          },
        ),
        http.get(
          "https://graph.microsoft.com/v1.0/users/:userId/teamwork/installedApps",
          () => {
            return HttpResponse.json({ value: [] });
          },
        ),
      );
      await scenario.dispatch(owned, "hello from teams diagnostics");

      const reads = createRunReadsApi(context);
      const listed = await reads.requestListLogs(
        owned.actor,
        { limit: 50 },
        [200],
      );
      expect(listed.body.data).toContainEqual(
        expect.objectContaining({
          status: "pending",
          triggerSource: "teams",
          agentId: owned.defaultAgentId,
          prompt: "hello from teams diagnostics",
        }),
      );
      const teamsRun = listed.body.data.find((run) => {
        return run.prompt === "hello from teams diagnostics";
      });
      if (!teamsRun) {
        throw new Error("Expected the Teams message to launch a Run");
      }
      const detail = await reads.requestReadLogById(
        owned.actor,
        teamsRun.id,
        [200],
      );
      expect(detail.body).toMatchObject({
        status: "pending",
        triggerSource: "teams",
        agentId: owned.defaultAgentId,
        error: null,
        prompt: "hello from teams diagnostics",
      });
      expect(detail.body.appendSystemPrompt).toContain(
        `Tenant ID: ${fixture.teamsTenantId}`,
      );
      expect(detail.body.appendSystemPrompt).toContain(
        "Conversation ID: 19:e2e-dm@thread.v2",
      );
      expect(detail.body.appendSystemPrompt).toContain(
        "Conversation type: personal",
      );
      expect(detail.body.appendSystemPrompt).toContain(
        "Thread ID: activity-e2e",
      );
      expect(detail.body.appendSystemPrompt).toContain(
        "Activity ID: activity-e2e",
      );

      const chat = createChatFilesBddApi(context);
      const threads = await chat.requestThreadEvents(owned.actor, {}, [200]);
      if (threads.status !== 200) {
        throw new Error("Expected public Teams thread events");
      }
      const thread = threads.body.events.find((event) => {
        return (
          event.kind === "created" && event.agentId === owned.defaultAgentId
        );
      });
      if (!thread) {
        throw new Error(
          "Expected the Teams Run to use a canonical chat thread",
        );
      }
      const page = await chat.listThreadEvents(
        owned.actor,
        thread.chatThreadId,
      );
      const input = page.events.find((event) => {
        return (
          event.eventType === "input.prompt" && event.runId === teamsRun.id
        );
      });
      if (input?.eventType !== "input.prompt") {
        throw new Error("Expected the Teams input associated with its Run");
      }
      expect(chatEventDisplayText(input)).toBe("hello from teams diagnostics");
      expect(input.userMessage?.parts).toContainEqual({
        type: "source",
        kind: "teams",
        href: `https://teams.microsoft.com/l/message/${encodeURIComponent("19:e2e-dm@thread.v2")}/activity-e2e?tenantId=${encodeURIComponent(fixture.teamsTenantId)}&context=${encodeURIComponent(JSON.stringify({ contextType: "chat" }))}`,
      });
    });
  });
});

describe("Teams webhook dispatch", () => {
  beforeEach(() => {
    context.mocks.clerk.users.getUserList.mockReset();
    context.mocks.clerk.users.getOrganizationMembershipList.mockReset();
  });

  it("drains a persisted Teams message when realtime publishing fails", async () => {
    const fixture = teamsConnectFixture();
    const owned = await trackPublicTeamsFixture(
      Promise.resolve({
        installation: fixture,
        kmsKeyId: env("SECRETS_KMS_KEY_ID"),
        storageBucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        defaultAgentId: null,
        subscriptionId: `sub_teams_realtime_${randomUUID()}`,
      }),
    );
    const bdd = createBddApi(context);
    const actor = bdd.user({ userId: fixture.userId, orgId: fixture.orgId });
    const runs = createRunsApi(context);
    configurePublicTeamsMocks(fixture);
    runs.acceptStorageDownloads();
    runs.configureRunnerGroup();
    configureNativeCliArtifact();
    owned.defaultAgentId = await bdd.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Teams realtime failure",
    });
    await runs.grantProEntitlement(actor, {
      subscriptionId: owned.subscriptionId,
    });
    await runs.ensureOrgModelProvider(actor, { model: "claude-fable-5-1" });
    await installTeamsForTest(context.signal, fixture);
    createRouteMocks(context).clerk.session(
      fixture.userId,
      fixture.orgId,
      "org:admin",
    );
    await accept(
      setupApp({ context, routes: teamsConnectRoutes })(
        teamsConnectContract,
      ).connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
          teamsUserDisplayName: "Teams User",
          teamsUserPrincipalName: fixture.teamsUserPrincipalName,
          teamId: fixture.teamsTeamId,
          teamName: fixture.teamsTeamName,
          serviceUrl: fixture.serviceUrl,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();

    context.mocks.ably.publish.mockClear();
    const publishError = new Error("Ably channel rate limit exceeded");
    context.mocks.ably.publish.mockRejectedValue(publishError);

    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(fixture, {
        id: "activity-e2e",
        conversation: {
          id: "19:e2e-dm@thread.v2",
          conversationType: "personal",
        },
        channelData: {
          tenant: {
            id: fixture.teamsTenantId,
            name: fixture.teamsTenantName,
          },
        },
        from: {
          id: fixture.teamsUserId,
          name: "Teams User",
          aadObjectId: fixture.teamsAadObjectId,
          userPrincipalName: fixture.teamsUserPrincipalName,
        },
        text: "dispatch despite realtime failure",
        entities: [],
        replyToId: null,
      }),
    });
    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toMatchObject({ ok: true });
    await flushWaitUntilForTest();

    const listed = await createRunReadsApi(context).requestListLogs(
      actor,
      { limit: 50 },
      [200],
    );
    expect(listed.body.data).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "pending",
          triggerSource: "teams",
          prompt: "dispatch despite realtime failure",
        }),
      ]),
    );
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("does not enqueue runs for unlinked users or missing default agents", async () => {
    const scenario = createPublicTeamsDispatchFixture(context);
    await scenario.run(async () => {
      const unlinked = await scenario.create({ withDefaultAgent: true });
      await scenario.disconnect(unlinked);
      await expect(scenario.status(unlinked)).resolves.toMatchObject({
        isInstalled: true,
        isConnected: false,
        tenantId: unlinked.installation.teamsTenantId,
      });
      if (!unlinked.defaultAgentId) {
        throw new Error(
          "Expected an independent default Agent for the unlinked gate",
        );
      }
      await createBddApi(context).requestReadAgent(
        unlinked.actor,
        unlinked.defaultAgentId,
        [200],
      );
      await scenario.dispatch(unlinked, "unlinked teams");
      expect(unlinked.notices).toContain(
        "Please connect your account to use Okou in this Teams workspace.",
      );
      const reads = createRunReadsApi(context);
      expect(
        (await reads.requestListLogs(unlinked.actor, { limit: 50 }, [200])).body
          .data,
      ).toStrictEqual([]);

      const missingDefault = await scenario.create({ withDefaultAgent: false });
      await expect(scenario.status(missingDefault)).resolves.toMatchObject({
        isInstalled: true,
        isConnected: true,
        tenantId: missingDefault.installation.teamsTenantId,
        defaultAgentName: null,
      });
      await scenario.dispatch(missingDefault, "missing default teams");
      expect(missingDefault.notices).toContain(
        "No agent is configured for this org. Please ask your org admin to set a default agent.",
      );
      expect(
        (
          await reads.requestListLogs(
            missingDefault.actor,
            { limit: 50 },
            [200],
          )
        ).body.data,
      ).toStrictEqual([]);
    });
  });
});

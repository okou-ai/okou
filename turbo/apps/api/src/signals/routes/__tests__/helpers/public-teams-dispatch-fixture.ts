import { randomUUID } from "node:crypto";

import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { teamsConnectRoutes } from "../../teams-connect";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createRunReadsApi } from "./api-bdd-run-reads";
import { createRunsApi } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { configureNativeCliArtifact } from "./chat-events-fixture";
import { deleteFeatureSwitchesForUser } from "./feature-switches";
import { createFixtureOperationOwner } from "./fixture-operation-owner";
import { createRouteMocks } from "./route-test";
import {
  installTeamsForTest,
  postTeamsActivityForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./teams-connect";

interface OwnedTeamsDispatch {
  readonly installation: TeamsConnectFixture;
  readonly actor: ApiTestUser;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly kmsKeyId: string | undefined;
  readonly storageBucket: string;
  readonly notices: string[];
  defaultAgentId: string | null;
}

/** Owns complete setup and dispatch operations for the two selected cases. */
export function createPublicTeamsDispatchFixture(context: TestContext) {
  const owned: OwnedTeamsDispatch[] = [];
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const reads = createRunReadsApi(context);
  const routes = createRouteMocks(context);

  function configureExternalMocks(fixture: OwnedTeamsDispatch): void {
    setupTeamsConnectTestEnv();
    mockEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD", "teams-app-password");
    mockOptionalEnv(
      "MICROSOFT_TEAMS_BOT_TOKEN_URL",
      "https://teams-auth.test/token",
    );
    mockEnv("SECRETS_KMS_KEY_ID", fixture.kmsKeyId);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", fixture.storageBucket);
    context.mocks.s3.send.mockResolvedValue({});
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    context.mocks.ably.publish.mockResolvedValue(undefined);
    server.use(
      http.post("https://teams-auth.test/token", () => {
        return HttpResponse.json({
          access_token: "teams-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
      http.post(`${fixture.installation.serviceUrl}v3/conversations`, () => {
        return HttpResponse.json({
          id: `a:welcome-${fixture.installation.fixtureId}`,
        });
      }),
      http.post(
        `${fixture.installation.serviceUrl}v3/conversations/:conversationId/activities`,
        async ({ request }) => {
          const body = (await request.json()) as { text?: string };
          if (body.text) {
            fixture.notices.push(body.text);
          }
          return HttpResponse.json({ id: "typing-activity" });
        },
      ),
      http.post(
        `${fixture.installation.serviceUrl}v3/conversations/:conversationId/activities/:activityId`,
        async ({ request }) => {
          const body = (await request.json()) as { text?: string };
          if (body.text) {
            fixture.notices.push(body.text);
          }
          return HttpResponse.json({ id: "reply-activity" });
        },
      ),
    );
  }

  function connectClient(fixture: OwnedTeamsDispatch) {
    routes.clerk.session(
      fixture.actor.userId,
      fixture.installation.orgId,
      "org:admin",
    );
    return setupApp({ context, routes: teamsConnectRoutes })(
      teamsConnectContract,
    );
  }

  const owner = createFixtureOperationOwner(async () => {
    for (const fixture of owned) {
      configureExternalMocks(fixture);
      await flushWaitUntilForTest();
      const listed = await reads.requestListLogs(
        fixture.actor,
        { limit: 50 },
        [200],
      );
      for (const run of listed.body.data) {
        if (run.status === "pending" || run.status === "running") {
          await runs.requestCancelRun(fixture.actor, run.id, [200]);
        }
      }
      await flushWaitUntilForTest();
      // These scenarios never claim a Runner; cancellation needs no ACK.
      await removeTeamsForTest(context.signal, fixture.installation);
      await flushWaitUntilForTest();
      await deleteFeatureSwitchesForUser(context, {
        userId: fixture.actor.userId,
        orgId: fixture.installation.orgId,
        orgRole: fixture.actor.orgRole,
      });
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureStripeBillingEnv();
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.invoices.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: fixture.subscriptionId,
        status: "active",
        metadata: {},
      });
      context.mocks.stripe.subscriptions.update.mockResolvedValue({
        id: fixture.subscriptionId,
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: fixture.subscriptionId,
        status: "canceled",
      });
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "organization.deleted",
        data: { id: fixture.installation.orgId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      if (fixture.defaultAgentId) {
        await bdd.requestReadAgent(
          fixture.actor,
          fixture.defaultAgentId,
          [404],
        );
      }
      expect(
        (await reads.requestListLogs(fixture.actor, { limit: 50 }, [200])).body
          .data,
      ).toStrictEqual([]);
      // Immutable billing history retains its unique organization provenance.
    }
  });

  return {
    run: owner.run,
    async create(options: {
      readonly withDefaultAgent: boolean;
      readonly paidNative?: boolean;
    }): Promise<OwnedTeamsDispatch> {
      const installation = teamsConnectFixture();
      const fixture: OwnedTeamsDispatch = {
        installation,
        actor: bdd.user({
          userId: installation.userId,
          orgId: installation.orgId,
        }),
        customerId: `cus_teams_dispatch_${randomUUID()}`,
        subscriptionId: `sub_teams_dispatch_${randomUUID()}`,
        kmsKeyId: env("SECRETS_KMS_KEY_ID"),
        storageBucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        notices: [],
        defaultAgentId: null,
      };
      // Register the UUID owner before onboarding, billing, or installation.
      owned.push(fixture);
      configureExternalMocks(fixture);
      if (options.withDefaultAgent) {
        fixture.defaultAgentId = await bdd.bootstrapLimitedFreeOnboarding(
          fixture.actor,
          { displayName: "Teams dispatch" },
        );
      }
      if (options.paidNative) {
        runs.configureRunnerGroup();
        configureNativeCliArtifact();
        await runs.grantProEntitlement(fixture.actor, {
          customerId: fixture.customerId,
          subscriptionId: fixture.subscriptionId,
        });
        await runs.ensureOrgModelProvider(fixture.actor, {
          model: "claude-fable-5-1",
        });
      }
      await installTeamsForTest(context.signal, installation);
      await accept(
        connectClient(fixture).connect({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            tenantId: installation.teamsTenantId,
            teamsUserId: installation.teamsUserId,
            teamsAadObjectId: installation.teamsAadObjectId,
            teamsUserDisplayName: "Teams User",
            teamsUserPrincipalName: installation.teamsUserPrincipalName,
            teamId: installation.teamsTeamId,
            teamName: installation.teamsTeamName,
            serviceUrl: installation.serviceUrl,
          },
        }),
        [200],
      );
      await flushWaitUntilForTest();
      return fixture;
    },
    async status(fixture: OwnedTeamsDispatch) {
      const response = await accept(
        connectClient(fixture).getStatus({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      return response.body;
    },
    async disconnect(fixture: OwnedTeamsDispatch): Promise<void> {
      await accept(
        connectClient(fixture).disconnect({
          headers: { authorization: "Bearer clerk-session" },
          query: {},
        }),
        [200],
      );
    },
    async dispatch(fixture: OwnedTeamsDispatch, text: string): Promise<void> {
      const installation = fixture.installation;
      const response = await postTeamsActivityForTest({
        signal: context.signal,
        activity: teamsMessageActivityForTest(installation, {
          id: "activity-e2e",
          conversation: {
            id: "19:e2e-dm@thread.v2",
            conversationType: "personal",
          },
          channelData: {
            tenant: {
              id: installation.teamsTenantId,
              name: installation.teamsTenantName,
            },
          },
          from: {
            id: installation.teamsUserId,
            name: "Teams User",
            aadObjectId: installation.teamsAadObjectId,
            userPrincipalName: installation.teamsUserPrincipalName,
          },
          text,
          entities: [],
          replyToId: null,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({ ok: true });
      await flushWaitUntilForTest();
    },
  };
}

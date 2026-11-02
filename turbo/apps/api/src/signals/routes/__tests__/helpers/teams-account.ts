import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";

import type { TestContext } from "../../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../../app-factory-core";
import { mockEnv, optionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { teamsOauthRoutes } from "../../teams-oauth";
import { seedOrgMembership$ } from "./org-membership";
import { createRouteMocks } from "./route-test";
import {
  postTeamsActivityForTest,
  teamsMessageActivityForTest,
  type TeamsConnectFixture,
} from "./teams-connect";

const memberships = createStore();

/** Connect through Microsoft OAuth, with bot installation as a separate flow. */
export async function connectTeamsAccountForTest(
  context: TestContext,
  fixture: TeamsConnectFixture,
  options: {
    readonly learnSender?: boolean;
    readonly displayName?: string;
    readonly principalName?: string;
  } = {},
): Promise<void> {
  await memberships.set(
    seedOrgMembership$,
    { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
    context.signal,
  );
  createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);
  mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "teams-fixture-client");
  mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "teams-fixture-secret");
  mockEnv(
    "MICROSOFT_TEAMS_BOT_APP_PASSWORD",
    optionalEnv("MICROSOFT_TEAMS_BOT_APP_PASSWORD") ?? "teams-test-password",
  );
  const setupConversation = `a:identity-fixture-${fixture.fixtureId}`;
  server.use(
    http.post(
      "https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token",
      () => {
        return HttpResponse.json({
          access_token: "teams-access-token",
          expires_in: 3600,
        });
      },
    ),
    http.post(`${fixture.serviceUrl}v3/conversations`, () => {
      return HttpResponse.json({ id: setupConversation });
    }),
    http.post(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      () => {
        return HttpResponse.json({
          access_token: "teams-oauth-fixture-token",
          id_token: `e30.${Buffer.from(JSON.stringify({ tid: fixture.teamsTenantId, oid: fixture.teamsAadObjectId })).toString("base64url")}.signature`,
        });
      },
    ),
    http.get("https://graph.microsoft.com/v1.0/me", () => {
      return HttpResponse.json({
        id: fixture.teamsAadObjectId,
        displayName: options.displayName ?? "Ada Lovelace",
        userPrincipalName:
          options.principalName ?? fixture.teamsUserPrincipalName,
      });
    }),
    http.get(
      `${fixture.serviceUrl}v3/conversations/:conversationId/members/:memberId`,
      ({ params }) => {
        if (params.memberId !== fixture.teamsUserId) {
          return;
        }
        return HttpResponse.json({
          id: fixture.teamsUserId,
          tenantId: fixture.teamsTenantId,
          aadObjectId: fixture.teamsAadObjectId,
        });
      },
    ),
    http.post(
      `${fixture.serviceUrl}v3/conversations/:conversationId/activities/:activityId?`,
      ({ params }) => {
        if (params.conversationId !== setupConversation) {
          return;
        }
        return HttpResponse.json({ id: "identity-confirmed" });
      },
    ),
  );
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: teamsOauthRoutes,
  });
  const headers = { authorization: "Bearer clerk-session" };
  for (const flow of ["install", "connect"]) {
    const start = await app.request(
      `https://api.okou.test/api/teams/oauth/connect?${new URLSearchParams({ flow })}`,
      { headers },
    );
    const location = start.headers.get("location");
    const state = location ? new URL(location).searchParams.get("state") : null;
    if (!state) {
      throw new Error(
        `Teams OAuth ${flow} did not return an authorization state`,
      );
    }
    const completed = await app.request(
      `https://api.okou.test/api/integrations/teams/oauth/callback?${new URLSearchParams({ state, code: "verified-fixture-code" })}`,
      { headers },
    );
    const result = completed.headers.get("location");
    if (!result || new URL(result).searchParams.has("error")) {
      throw new Error(
        `Teams OAuth ${flow} failed: ${result ?? completed.status}`,
      );
    }
    await flushWaitUntilForTest();
  }
  // A verified provider message supplies the bot-scoped Teams user ID.
  if (options.learnSender !== false) {
    const response = await postTeamsActivityForTest({
      signal: context.signal,
      activity: teamsMessageActivityForTest(fixture, {
        id: `identity-${fixture.fixtureId}`,
        text: "<at>Nova</at> connect",
        conversation: { id: setupConversation, conversationType: "personal" },
        replyToId: null,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Teams sender verification failed with ${response.status}`,
      );
    }
    await flushWaitUntilForTest();
  }
}

import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
} from "./helpers/google-text";
import { randomUUID } from "node:crypto";

import { onboardingRecommendationContract } from "@okouai/api-contracts/contracts/onboarding";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";
import { onboardingRecommendationRoutes } from "../onboarding-recommendations";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

const GMAIL_LABEL_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX";
const GMAIL_MESSAGES_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GITHUB_REPOSITORIES_URL = "https://api.github.com/user/repos";
const GOOGLE_GENERATION_URL = VERTEX_TEXT_URL;

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context, routes: onboardingRecommendationRoutes })(
    onboardingRecommendationContract,
  );
}

function rawStartRequest(body: Record<string, unknown>) {
  return setupRawAppRequest({
    context,
    routes: onboardingRecommendationRoutes,
  })("/api/onboarding/recommendations", {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("onboarding recommendations", () => {
  it("starts an owned durable job and exposes only its bounded status", async () => {
    const userId = `user_onboarding_recommendation_${randomUUID()}`;
    const orgId = `org_onboarding_recommendation_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const started = await accept(
      apiClient().start({
        headers: authHeaders(),
        body: { industry: "operations", locale: "en-US" },
      }),
      [202],
    );

    expect(started.body).toStrictEqual({
      jobId: expect.any(String),
      status: "pending",
    });
    expect(started.headers.get("cache-control")).toBe("private, no-store");

    const status = await accept(
      apiClient().get({
        headers: authHeaders(),
        params: { jobId: started.body.jobId },
      }),
      [200],
    );
    expect(status.body.jobId).toBe(started.body.jobId);
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    expect(["pending", "running", "failed"]).toContain(status.body.status);
    expect(status.body).not.toHaveProperty("error");

    const otherUserId = `user_onboarding_recommendation_other_${randomUUID()}`;
    mocks.clerk.session(otherUserId, orgId);
    const hidden = await accept(
      apiClient().get({
        headers: authHeaders(),
        params: { jobId: started.body.jobId },
      }),
      [404],
    );
    expect(hidden.body.error.code).toBe("NOT_FOUND");
    expect(hidden.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([false, true])(
    "preserves authorized context when another source fails (Gmail revoked during read: %s)",
    async (revokeGmail) => {
      bdd.acceptAgentStorageWrites();
      const actor = bdd.user({
        userId: `user_onboarding_recommendation_context_${randomUUID()}`,
        orgId: `org_onboarding_recommendation_context_${randomUUID()}`,
        orgRole: "org:admin",
      });
      if (!actor.orgId) {
        throw new Error("Expected an organization actor");
      }
      const onboarding = await bdd.readOnboardingStatus(actor);
      if (!onboarding.defaultAgentId) {
        throw new Error("Expected onboarding to create a default agent");
      }

      mockGmailConnectorOAuth({
        accessToken: "gmail-context-access-token",
        email: "owner@example.test",
        subject: `gmail-context-${randomUUID()}`,
      });
      const oauth = await connectorsApi.startOauth(
        actor,
        "gmail",
        "oauth",
        onboarding.defaultAgentId,
      );
      const state = new URL(oauth.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error("Expected a Gmail OAuth state");
      }
      await connectorsApi.completeOauthCallback("gmail", {
        code: "gmail-context-code",
        state,
      });

      mockGitHubConnectorOAuth({
        userId: 424_242,
        login: `onboarding-context-${randomUUID()}`,
      });
      const githubOauth = await connectorsApi.startOauth(
        actor,
        "github",
        "oauth",
        onboarding.defaultAgentId,
      );
      const githubState = new URL(
        githubOauth.authorizationUrl,
      ).searchParams.get("state");
      if (!githubState) {
        throw new Error("Expected a GitHub OAuth state");
      }
      await connectorsApi.completeOauthCallback("github", {
        code: "github-context-code",
        state: githubState,
      });

      mockGoogleText();
      let modelRequest = "";
      server.use(
        http.get(GMAIL_LABEL_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer gmail-context-access-token",
          );
          if (revokeGmail) {
            await connectorsApi.deleteDefaultBuiltinConnectorAccount(
              actor,
              "gmail",
            );
          }
          return HttpResponse.json({
            messagesTotal: 42,
            messagesUnread: 7,
          });
        }),
        http.get(GMAIL_MESSAGES_URL, ({ request }) => {
          expect(new URL(request.url).searchParams.get("maxResults")).toBe("5");
          return HttpResponse.json({
            messages: [{ id: "message-1", threadId: "thread-1" }],
          });
        }),
        http.get(`${GMAIL_MESSAGES_URL}/:messageId`, ({ params }) => {
          expect(params.messageId).toBe("message-1");
          return HttpResponse.json({
            id: "message-1",
            payload: {
              headers: [
                {
                  name: "Subject",
                  value:
                    "Follow up with alice@example.com at https://private.example.test/plan",
                },
                { name: "From", value: "Alice <alice@example.com>" },
                { name: "Date", value: "Mon, 22 Sep 2026 08:00:00 GMT" },
              ],
            },
          });
        }),
        http.get(GITHUB_REPOSITORIES_URL, () => {
          return HttpResponse.json(
            { message: "temporary repository failure" },
            { status: 503 },
          );
        }),
        http.post(GOOGLE_GENERATION_URL, async ({ request }) => {
          const body = vertexTextRequest(await request.json(), request.url);
          expect(body.model).toBe("gemini-3.1-flash-lite");
          expect(body.generationConfig).toMatchObject({
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: "MINIMAL" },
            responseJsonSchema: { type: "object" },
          });
          modelRequest = JSON.stringify(body);
          return HttpResponse.json({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        kind: "task",
                        title: "Clear the important replies",
                        outcome: "Three priority drafts ready for review",
                        prompt:
                          "Review my recent Gmail workload and draft the replies that need attention.",
                        profile: {
                          overview:
                            "Your inbox shows a steady flow of work that needs follow-up.",
                          professionalIdentity: [],
                          communicationStyle: [],
                          priorities: ["Keep up with important replies"],
                        },
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 25,
              totalTokenCount: 125,
            },
          });
        }),
      );

      mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
      const started = await accept(
        apiClient().start({
          headers: authHeaders(),
          body: { industry: "operations", locale: "en-US" },
        }),
        [202],
      );
      await flushWaitUntilForTest();
      const status = await accept(
        apiClient().get({
          headers: authHeaders(),
          params: { jobId: started.body.jobId },
        }),
        [200],
      );

      expect(status.body).toStrictEqual({
        jobId: started.body.jobId,
        status: "completed",
        recommendation: {
          kind: "task",
          title: "Clear the important replies",
          outcome: "Three priority drafts ready for review",
          prompt:
            "Review my recent Gmail workload and draft the replies that need attention.",
          profile: {
            overview:
              "Your inbox shows a steady flow of work that needs follow-up.",
            professionalIdentity: [],
            communicationStyle: [],
            priorities: ["Keep up with important replies"],
          },
        },
      });
      const modelBody = JSON.parse(modelRequest) as {
        readonly messages: readonly {
          readonly role: string;
          readonly content: string;
        }[];
      };
      const contextMessage = modelBody.messages.find(({ role }) => {
        return role === "user";
      });
      if (!contextMessage) {
        throw new Error("Expected the model context message");
      }
      expect(JSON.parse(contextMessage.content)).toMatchObject({
        industry: "operations",
        selectedPositioning: {
          name: "Business & operations",
          summary: "Business owners, assistants & operators",
        },
        connectedContext: expect.arrayContaining([
          {
            sourceSlug: "github",
            facts: [],
            capabilities: expect.arrayContaining([
              "read repositories and work items",
            ]),
          },
        ]),
        unavailableSourceSlugs: revokeGmail
          ? expect.arrayContaining(["gmail", "github"])
          : ["github"],
      });
      if (revokeGmail) {
        expect(JSON.parse(contextMessage.content)).toMatchObject({
          connectedContext: expect.arrayContaining([
            { sourceSlug: "gmail", facts: [], capabilities: expect.any(Array) },
          ]),
        });
      } else {
        expect(modelRequest).toContain("[email]");
        expect(modelRequest).toContain("[link]");
      }
      expect(modelRequest).toContain('"profile"');
      expect(modelRequest).toContain(
        "Combine it with connectedContext when writing the profile",
      );
      expect(modelRequest).not.toContain("alice@example.com");
      expect(modelRequest).not.toContain("private.example.test");
      expect(modelRequest).not.toContain("gmail-context-access-token");
      expect(modelRequest).not.toContain("github-access-github-context-code");
    },
  );

  it("rejects a well-formed locale that is not supported by the app", async () => {
    const userId = `user_onboarding_recommendation_locale_${randomUUID()}`;
    const orgId = `org_onboarding_recommendation_locale_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await rawStartRequest({
      industry: "operations",
      locale: "en-Ignore-All-Rules",
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("does not reveal another or nonexistent job", async () => {
    const userId = `user_onboarding_recommendation_missing_${randomUUID()}`;
    const orgId = `org_onboarding_recommendation_missing_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      apiClient().get({
        headers: authHeaders(),
        params: { jobId: randomUUID() },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

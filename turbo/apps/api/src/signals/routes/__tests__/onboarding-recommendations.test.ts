import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { onboardingRecommendationContract } from "@okouai/api-contracts/contracts/onboarding";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { onboardingRecommendationRoutes } from "../onboarding-recommendations";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  mockGitHubConnectorOAuth,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const recommendations = setupApp({
  context,
  routes: onboardingRecommendationRoutes,
})(onboardingRecommendationContract);
const oauthStart = setupApp({
  context,
  routes: builtinConnectorsRoutes,
})(builtinConnectorOauthStartContract);
const oauthCallback = setupApp({
  context,
  routes: builtinConnectorsSlugCallbackRoutes,
})(builtinConnectorsSlugCallbackContract);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function expectedRecommendation() {
  return {
    kind: "task" as const,
    title: "Prepare replies to important client emails",
    outcome: "Draft replies for the client threads waiting on you.",
    prompt:
      "Review my recent client emails and draft replies to the important ones.",
    profile: {
      overview: "Runs business operations with an active client inbox.",
      professionalIdentity: ["Business operator"],
      communicationStyle: [] as string[],
      priorities: ["Answer client email promptly"],
    },
  };
}

test("onboarding-recommendations-001 starts an owned job and shows its bounded status only to the owner", async () => {
  const orgId = `org_${randomUUID()}`;
  const ownerId = `user_${randomUUID()}`;
  const peerId = `user_${randomUUID()}`;
  const mocks = createRouteMocks(context);
  mocks.clerk.session(ownerId, orgId);

  const started = await accept(
    recommendations.start({
      headers: authHeaders(),
      body: { industry: "operations", locale: "en-US" },
    }),
    [202],
  );
  const owner = await accept(
    recommendations.get({
      headers: authHeaders(),
      params: { jobId: started.body.jobId },
    }),
    [200],
  );
  mocks.clerk.session(peerId, orgId, "org:member");
  const peer = await accept(
    recommendations.get({
      headers: authHeaders(),
      params: { jobId: started.body.jobId },
    }),
    [404],
  );

  expect(started.body).toStrictEqual({
    jobId: started.body.jobId,
    status: "pending",
  });
  expect(owner.body).toStrictEqual({
    jobId: started.body.jobId,
    status: expect.stringMatching(/^(pending|running|failed)$/),
  });
  expect(peer.body.error.code).toBe("NOT_FOUND");
  for (const response of [started, owner, peer]) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});

async function connect(actor: ApiTestUser, connectorSlug: "gmail" | "github") {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  const started = await accept(
    oauthStart.start({
      headers: authHeaders(),
      params: { connectorSlug },
      body: { authMethod: "oauth", account: { intent: "add" } },
    }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  const result = await accept(
    oauthCallback.callback({
      headers: {},
      params: { connectorSlug },
      query: { state, code: `code-${randomUUID()}`, responseMode: "json" },
    }),
    [200],
  );
  expect(result.body.status).toBe("success");
}

function mockGmailInbox() {
  server.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX",
      () => {
        return HttpResponse.json({ messagesTotal: 120, messagesUnread: 7 });
      },
    ),
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", () => {
      return HttpResponse.json({ messages: [{ id: "message-1" }] });
    }),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/message-1",
      () => {
        return HttpResponse.json({
          id: "message-1",
          payload: {
            headers: [
              {
                name: "Subject",
                value:
                  "Reply to ceo@client.example.com about https://deals.example.com/q4",
              },
              { name: "From", value: "Client CEO <ceo@client.example.com>" },
            ],
          },
        });
      },
    ),
    http.get("https://api.github.com/user/repos", () => {
      return HttpResponse.json(
        { message: "Service unavailable" },
        { status: 503 },
      );
    }),
  );
}

interface CapturedModelRequest {
  url: string;
  body: unknown;
  raw: string;
}

function mockRecommendationModel() {
  mockGoogleText();
  const captured: { latest?: CapturedModelRequest } = {};
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      const raw = await request.text();
      captured.latest = { url: request.url, body: JSON.parse(raw), raw };
      return vertexTextResponse(JSON.stringify(expectedRecommendation()));
    }),
  );
  return captured;
}

async function runGmailWithFailingGithubRecommendation() {
  mockGmailConnectorOAuth();
  mockGitHubConnectorOAuth();
  const admin = createBddApi(context).user();
  await Promise.all([connect(admin, "gmail"), connect(admin, "github")]);
  mockGmailInbox();
  const captured = mockRecommendationModel();
  createRouteMocks(context).clerk.session(
    admin.userId,
    admin.orgId,
    admin.orgRole,
  );
  const started = await accept(
    recommendations.start({
      headers: authHeaders(),
      body: { industry: "operations", locale: "en-US" },
    }),
    [202],
  );
  await flushWaitUntilForTest();
  return { started, captured };
}

test("onboarding-recommendations-002 (1/2) returns the completed recommendation when GitHub fails and Gmail succeeds", async () => {
  const { started } = await runGmailWithFailingGithubRecommendation();

  const read = await accept(
    recommendations.get({
      headers: authHeaders(),
      params: { jobId: started.body.jobId },
    }),
    [200],
  );

  expect(read.body).toStrictEqual({
    jobId: started.body.jobId,
    status: "completed",
    recommendation: expectedRecommendation(),
  });
});

test("onboarding-recommendations-002 (2/2) sends redacted Gmail context and unavailable GitHub status to Gemini without credentials", async () => {
  const { captured } = await runGmailWithFailingGithubRecommendation();

  const model = captured.latest;
  if (!model) {
    throw new Error("Expected recommendation model request");
  }
  const wire = vertexTextRequest(model.body, model.url);
  expect(wire.model).toBe("gemini-3.1-flash-lite");
  expect(wire.generationConfig).toMatchObject({
    thinkingConfig: { thinkingLevel: "MINIMAL" },
    responseMimeType: "application/json",
  });
  const userMessage = wire.messages.find((message) => {
    return message.role === "user";
  });
  const parsedPayload = JSON.parse(userMessage?.content ?? "null") as {
    readonly connectedContext?: readonly unknown[];
  };
  expect(parsedPayload.connectedContext).toHaveLength(2);
  expect(parsedPayload).toStrictEqual({
    industry: "operations",
    selectedPositioning: expect.objectContaining({
      name: "Business & operations",
    }),
    connectedContext: expect.arrayContaining([
      {
        sourceSlug: "github",
        facts: [],
        capabilities: expect.arrayContaining([expect.any(String)]),
      },
      {
        sourceSlug: "gmail",
        facts: [
          "Inbox contains 120 messages, with 7 unread.",
          "Recent email subject: Reply to [email] about [link] (from client.example.com)",
        ],
        capabilities: expect.arrayContaining([expect.any(String)]),
      },
    ]),
    unavailableSourceSlugs: ["github"],
  });
  for (const secret of [
    "gmail-access-token",
    "gmail-refresh-token",
    "github-access-",
    "ceo@client.example.com",
    "https://deals.example.com",
  ]) {
    expect(model.raw).not.toContain(secret);
  }
});

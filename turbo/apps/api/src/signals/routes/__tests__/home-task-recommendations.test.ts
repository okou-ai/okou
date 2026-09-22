import { randomUUID } from "node:crypto";

import { homeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/home-task-recommendations";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { homeTaskRecommendationRoutes } from "../home-task-recommendations";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  assistantEvent,
  createChatEventsFixture,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";

const context = testContext({ connectorCatalog: true });
const fixture = createChatEventsFixture(context);
const connectorsApi = createConnectorBddApi(context);

function recommendationsClient() {
  return setupApp({ context, routes: homeTaskRecommendationRoutes })(
    homeTaskRecommendationsContract,
  );
}

async function connectGmailWithoutAgentGrant(
  actor: Parameters<typeof connectorsApi.startOauth>[0],
  agentId: string,
): Promise<void> {
  const subject = `gmail-home-task-${randomUUID()}`;
  mockGmailConnectorOAuth({
    accessToken: "gmail-home-task-token",
    email: "home-task@example.test",
    subject,
  });
  const started = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
  );
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: "gmail-home-task-code",
    state,
  });
}

describe("GET /api/home-task-recommendations", () => {
  it("keeps evidence, destinations, Gmail access, and cache scoped to the requested Agent", async () => {
    const { actor, agentId, runnerGroup } = await fixture.entitledChatActor();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const scopedActor = { ...actor, orgId: actor.orgId };
    const thread = await fixture.chat.createThread(actor, {
      agentId,
      title: "Launch follow-up",
    });
    const run = await fixture.sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Prepare the customer launch follow-up for review.",
    });
    const claim = await fixture.claimChatRun(runnerGroup, run.runId);
    fixture.chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "I can prepare the launch follow-up next."),
    ]);
    await fixture.completeChatRunOk(run.runId, claim.sandboxHeaders);

    // The user has a Gmail account, but this Agent is intentionally never
    // granted Gmail. The recommendation request must not touch Gmail.
    await connectGmailWithoutAgentGrant(actor, agentId);
    let gmailListCalls = 0;
    let gmailDetailCalls = 0;
    server.use(
      http.get(GMAIL_LIST_URL, () => {
        gmailListCalls += 1;
        return HttpResponse.json({ messages: [{ id: "gmail-task-1" }] });
      }),
      http.get(GMAIL_MESSAGE_URL, ({ params }) => {
        gmailDetailCalls += 1;
        return HttpResponse.json({
          id: String(params["messageId"]),
          snippet: "Please send the revised launch date today.",
          internalDate: "1790000000000",
          labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
          payload: {
            headers: [
              { name: "From", value: "Customer <customer@example.test>" },
              { name: "Subject", value: "Launch date decision" },
            ],
          },
        });
      }),
    );

    const providerBodies: unknown[] = [];
    let textCalls = 0;
    let decisionCalls = 0;
    mockOptionalEnv("OPENROUTER_API_KEY", "home-task-openrouter-key");
    server.use(
      http.post(OPENROUTER_CHAT_URL, async ({ request }) => {
        const body: unknown = await request.json();
        providerBodies.push(body);
        textCalls += 1;
        const content =
          textCalls === 1
            ? JSON.stringify([
                {
                  intent: "Prepare the customer launch follow-up.",
                  reason: "The conversation leaves this as the next action.",
                  sourceRefs: ["t1"],
                  threadRef: "t1",
                },
              ])
            : textCalls === 2
              ? JSON.stringify([
                  {
                    id: "writer-cannot-pick-id",
                    title: "Prepare the launch follow-up",
                    prompt:
                      "Draft the customer launch follow-up for my review.",
                    rationale:
                      "The conversation identifies this as the next step",
                    actionability: 100,
                    target: { kind: "new-thread" },
                    connectors: ["gmail"],
                  },
                ])
              : textCalls === 3
                ? JSON.stringify([
                    {
                      intent: "Respond with the revised launch date.",
                      reason: "The important unread email requests it today.",
                      sourceRefs: ["g1"],
                      threadRef: null,
                    },
                  ])
                : JSON.stringify([
                    {
                      title: "Reply with the launch date",
                      prompt:
                        "Draft a reply with the revised launch date for my review.",
                      rationale: "An important unread email requests it today",
                    },
                  ]);
        return HttpResponse.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        });
      }),
      http.post(OPENROUTER_DECISIONS_URL, async ({ request }) => {
        const body: unknown = await request.json();
        providerBodies.push(body);
        decisionCalls += 1;
        return HttpResponse.json({
          answers: {
            c1_actionability: {
              type: "score",
              score: 2.7,
              confidence: 0.89,
              probabilities: { "0": 0, "1": 0.02, "2": 0.18, "3": 0.8 },
            },
            c1_grounded: { type: "noul", noul: 0.95 },
            c1_destination: { type: "noul", noul: 0.96 },
          },
          usage: { input_tokens: 200, output_tokens: 0 },
        });
      }),
    );
    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.HomeTaskRecommendations]: true,
    });

    const generated = await accept(
      recommendationsClient().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId },
      }),
      [200],
    );
    expect(generated.body).toMatchObject({
      status: "available",
      recommendations: [
        {
          id: "r1",
          title: "Prepare the launch follow-up",
          prompt: "Draft the customer launch follow-up for my review.",
          rationale: "The conversation identifies this as the next step",
          actionability: 90,
          target: { kind: "existing-thread", threadId: thread.id },
          connectors: [],
        },
      ],
    });
    expect(gmailListCalls).toBe(0);
    expect(gmailDetailCalls).toBe(0);
    expect(textCalls).toBe(2);
    expect(decisionCalls).toBe(1);
    for (const body of providerBodies) {
      expect(JSON.stringify(body)).not.toContain(thread.id);
    }

    // A second Agent owned by the same member has no evidence. It must not
    // receive the first Agent's cached recommendation.
    const emptyAgent = await fixture.bdd.createAgent(actor, {
      displayName: "Empty Agent",
      visibility: "private",
    });
    const isolated = await accept(
      recommendationsClient().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId: emptyAgent.agentId },
      }),
      [200],
    );
    expect(isolated.body).toMatchObject({
      status: "unavailable",
      recommendations: [],
    });
    expect(textCalls).toBe(2);
    expect(decisionCalls).toBe(1);

    const gmailAgent = await fixture.bdd.createAgent(actor, {
      displayName: "Gmail Agent",
      visibility: "private",
    });
    await fixture.api.enableAgentConnectors(actor, gmailAgent.agentId, [
      "gmail",
    ]);
    await fixture.api.applyUserPermissionGrant(actor, {
      agentId: gmailAgent.agentId,
      connectorSlug: "gmail",
      permission: "messages.detail",
      action: "allow",
    });
    const gmailGenerated = await accept(
      recommendationsClient().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId: gmailAgent.agentId },
      }),
      [200],
    );
    expect(gmailGenerated.body).toMatchObject({
      status: "available",
      recommendations: [
        {
          title: "Reply with the launch date",
          prompt: "Draft a reply with the revised launch date for my review.",
          actionability: 90,
          target: { kind: "new-thread" },
          connectors: ["gmail"],
        },
      ],
    });
    expect(gmailListCalls).toBe(1);
    expect(gmailDetailCalls).toBe(1);
    expect(textCalls).toBe(4);
    expect(decisionCalls).toBe(2);

    // The cached card is still inside its refresh window. Revoking this Agent's
    // Gmail scope must hide it immediately without another provider/Gmail read.
    await fixture.api.enableAgentConnectors(actor, gmailAgent.agentId, []);
    const revoked = await accept(
      recommendationsClient().list({
        headers: fixture.sessionHeaders(actor),
        query: { agentId: gmailAgent.agentId },
      }),
      [200],
    );
    expect(revoked.body).toMatchObject({
      status: "unavailable",
      recommendations: [],
    });
    expect(gmailListCalls).toBe(1);
    expect(gmailDetailCalls).toBe(1);
    expect(textCalls).toBe(4);
    expect(decisionCalls).toBe(2);
  });
});

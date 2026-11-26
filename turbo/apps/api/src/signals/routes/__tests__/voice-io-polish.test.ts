import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { http, HttpResponse } from "msw";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { voiceIoPolishRoutes } from "../voice-io-polish";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequestSchema,
  vertexTextResponse,
} from "./helpers/google-text";
import { createMcpWebApi } from "./helpers/mcp-web-api";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function api() {
  return setupApp({ context, routes: voiceIoPolishRoutes })(
    voiceIoPolishSegmentsContract,
  );
}

async function onboardedAdmin(): Promise<ApiTestUser> {
  const admin = bdd.user();
  bdd.acceptStorageWrites();
  await bdd.completeOnboarding(admin);
  return admin;
}

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return api();
}

/** Serve each Google response in order and record the native requests. */
function googleReplies(...replies: (() => Response)[]) {
  mockGoogleText();
  const requests: { url: string; body: unknown }[] = [];
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      requests.push({ url: request.url, body: await request.json() });
      const reply = replies[requests.length - 1];
      if (!reply) {
        throw new Error("Unexpected Google generation request");
      }
      return reply();
    }),
  );
  return requests;
}

const segments = Object.freeze([
  "um ship the nebula release Friday",
  "no Monday",
]);

function expectMergedRequest(requests: { url: string; body: unknown }[]) {
  expect(requests).toHaveLength(1);
  const sent = vertexTextRequestSchema.parse(requests[0]?.body);
  expect(sent.contents).toStrictEqual([
    { role: "user", parts: [{ text: JSON.stringify({ segments }) }] },
  ]);
  expect(sent.generationConfig.temperature).toBe(0);
  expect(sent.generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");
  expect(sent.generationConfig.maxOutputTokens).toBe(
    segments.join("").length + 4096,
  );
  expect(sent.generationConfig.responseMimeType).toBeUndefined();
  expect(
    sent.systemInstruction.parts
      .map((part) => {
        return part.text;
      })
      .join("\n"),
  ).toContain("Include every segment, not just the last one.");
}

describe("POST /api/voice-io/polish/segments", () => {
  it("voice-io-polish-014 requires authentication", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const response = await accept(
      api().post({ headers: {}, body: { segments: ["Hello"] } }),
      [401],
    );
    expect(response.status).toBe(401);
  });

  it("voice-io-polish-013 rejects an oversized combined transcript", async () => {
    const admin = await onboardedAdmin();

    const response = await accept(
      signIn(admin).post({
        headers,
        body: { segments: ["a".repeat(131_073), "b".repeat(131_072)] },
      }),
      [400],
    );
    expect(response.status).toBe(400);
  });

  it("voice-io-polish-007 rejects a candidate blocked for safety", async () => {
    const admin = await onboardedAdmin();
    googleReplies(() => {
      return vertexTextResponse("", "SAFETY");
    });

    const response = await accept(
      signIn(admin).post({
        headers,
        body: { segments: ["private user dictation"] },
      }),
      [502],
    );

    expect(response.body.error.code).toBe("VOICE_POLISH_FAILED");
  });

  it("voice-io-polish-010 rejects incomplete polish without exposing provider detail", async () => {
    const admin = await onboardedAdmin();
    const detail = "private provider detail";
    const retryAfter = { "Retry-After": "20" };
    const replies = [
      () => {
        return HttpResponse.json(
          {
            error: {
              code: 400,
              message: `Unsupported value: ${detail}`,
              status: "INVALID_ARGUMENT",
            },
          },
          { status: 400, headers: retryAfter },
        );
      },
      () => {
        return HttpResponse.json(
          { error: { code: 500, message: detail, status: "INTERNAL" } },
          { headers: retryAfter },
        );
      },
      () => {
        return HttpResponse.json(
          {
            promptFeedback: {
              blockReason: "SAFETY",
              blockReasonMessage: detail,
            },
          },
          { headers: retryAfter },
        );
      },
      () => {
        return HttpResponse.json(
          {
            candidates: [
              {
                finishReason: "MAX_TOKENS",
                content: { role: "model", parts: [{ text: detail }] },
              },
            ],
          },
          { headers: retryAfter },
        );
      },
      () => {
        return HttpResponse.json(
          {
            candidates: [
              {
                finishReason: "STOP",
                content: { role: "model", parts: [{ text: "  \n " }] },
              },
            ],
          },
          { headers: retryAfter },
        );
      },
    ];
    googleReplies(...replies);
    const client = signIn(admin);

    for (const _reply of replies) {
      const response = await accept(
        client.post({
          headers,
          body: { segments: ["um prepare the update"] },
        }),
        [502],
      );
      expect(response.body).toStrictEqual({
        error: {
          code: "VOICE_POLISH_FAILED",
          message: "Voice draft cleanup failed to produce a usable response",
        },
      });
      expect(JSON.stringify(response.body)).not.toContain(detail);
    }
  });

  it("voice-io-polish-011 merges ordered segments for a Clerk session without answering them", async () => {
    const admin = await onboardedAdmin();
    const requests = googleReplies(() => {
      return vertexTextResponse("Ship the release on Monday.");
    });

    const response = await accept(
      signIn(admin).post({ headers, body: { segments: [...segments] } }),
      [200],
    );

    expect(response.body).toStrictEqual({
      text: "Ship the release on Monday.",
    });
    expectMergedRequest(requests);
  });

  it("voice-io-polish-012 merges ordered segments for an OAuth access token without answering them", async () => {
    const admin = await onboardedAdmin();
    const issue = createMcpWebApi(context).authorize(admin);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [{ role: "org:admin", organization: { id: admin.orgId } }],
      totalCount: 1,
    });
    const token = issue({ scope: "user:org:read okou:voice:transcribe" });
    const requests = googleReplies(() => {
      return vertexTextResponse("Ship the release on Monday.");
    });

    const response = await accept(
      api().post({
        headers: { authorization: `Bearer ${token}` },
        body: { segments: [...segments] },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      text: "Ship the release on Monday.",
    });
    expectMergedRequest(requests);
  });
});

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { OPENROUTER_DECISIONS_URL, generateDecisions } from "../openrouter";

describe("OpenRouter Decisions API", () => {
  it("uses the dedicated endpoint and preserves structured answers and usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    let requestBody: unknown;
    let authorization: string | null = null;
    server.use(
      http.post(OPENROUTER_DECISIONS_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        requestBody = await request.json();
        return HttpResponse.json({
          answers: {
            actionable_c1: {
              type: "score",
              score: 2.7,
              confidence: 0.89,
            },
            grounded_c1: { type: "noul", noul: 0.94 },
          },
          usage: { input_tokens: 321, output_tokens: 0 },
        });
      }),
    );

    const request = {
      model: "typesafe/jev-1.13",
      state: { candidate: { id: "c1", sourceRefs: ["t1"] } },
      questions: {
        actionable_c1: {
          type: "score",
          instructions: "How actionable is this candidate?",
          criteria: ["No task", "Weak", "Useful", "Urgent"],
        },
      },
      user: "home-task-recommendations",
    };
    await expect(generateDecisions(request)).resolves.toStrictEqual({
      value: {
        answers: {
          actionable_c1: {
            type: "score",
            score: 2.7,
            confidence: 0.89,
          },
          grounded_c1: { type: "noul", noul: 0.94 },
        },
        usage: { input_tokens: 321, output_tokens: 0 },
      },
      usage: { input_tokens: 321, output_tokens: 0 },
    });
    expect(authorization).toBe("Bearer test-openrouter");
    expect(requestBody).toStrictEqual(request);
  });
});

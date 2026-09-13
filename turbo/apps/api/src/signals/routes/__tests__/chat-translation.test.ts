import { chatTranslationContract } from "@okouai/api-contracts/contracts/chat-translation";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
  type UsagePricingFixture,
} from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { chatTranslationRoutes } from "../chat-translation";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const mocks = createRouteMocks(context);
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TRANSLATION_MODEL = "qwen/qwen-2.5-7b-instruct";
const TRANSLATION_PRICING_ROWS = [
  {
    kind: "translation",
    provider: TRANSLATION_MODEL,
    category: "tokens.input",
    unitPrice: 100,
    unitSize: 1_000_000,
  },
  {
    kind: "translation",
    provider: TRANSLATION_MODEL,
    category: "tokens.cache_read",
    unitPrice: 100,
    unitSize: 1_000_000,
  },
  {
    kind: "translation",
    provider: TRANSLATION_MODEL,
    category: "tokens.output",
    unitPrice: 200,
    unitSize: 1_000_000,
  },
] as const;

function client(usagePricingResolution?: UsagePricingFixture["resolution"]) {
  return setupApp({
    context,
    routes: chatTranslationRoutes,
    usagePricingResolution,
  })(chatTranslationContract);
}

describe("POST /api/chat/translate", () => {
  it("translates a session user's selection and settles token usage", async () => {
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Chat translation tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    await updateFeatureSwitchesForUser(
      context,
      { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.ChatTranslation]: true },
    );
    await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 1000 });
    const pricing = await createUsagePricingFixture({
      configured: TRANSLATION_PRICING_ROWS,
    });
    onTestFinished(pricing.cleanup);
    let requestBody: unknown;
    server.use(
      http.post(OPENROUTER_URL, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          choices: [
            { finish_reason: "stop", message: { content: "你好，世界" } },
          ],
          usage: {
            prompt_tokens: 3000,
            completion_tokens: 1000,
            prompt_tokens_details: { cached_tokens: 1000 },
          },
        });
      }),
    );

    const response = await accept(
      client(pricing.resolution).translate({
        headers: {
          authorization: "Bearer clerk-session",
        },
        body: { text: "Hello, world", targetLanguage: "zh-CN" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      text: "你好，世界",
      metadata: { creditsCharged: 3 },
    });
    expect(requestBody).toMatchObject({
      model: TRANSLATION_MODEL,
      max_tokens: 8192,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: expect.stringContaining("dedicated translation engine"),
        },
        {
          role: "user",
          content: JSON.stringify({
            targetLanguage: "zh-CN",
            text: "Hello, world",
          }),
        },
      ],
    });
    server.use(
      http.post(OPENROUTER_URL, () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const unavailable = await accept(
      client(pricing.resolution).translate({
        headers: { authorization: "Bearer clerk-session" },
        body: { text: "Hello, world", targetLanguage: "zh-CN" },
      }),
      [503],
    );
    expect(unavailable.body).toStrictEqual({
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Translation is temporarily unavailable",
      },
    });
    await flushWaitUntilForTest();
  });

  it("requires session auth and the chat translation switch", async () => {
    const unauthenticated = await client().translate({
      headers: {},
      body: { text: "Hello", targetLanguage: "fr" },
    });
    expect(unauthenticated.status).toBe(401);

    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Chat translation tests require an organization");
    }
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const disabled = await client().translate({
      headers: { authorization: "Bearer clerk-session" },
      body: { text: "Hello", targetLanguage: "fr" },
    });
    expect(disabled.status).toBe(403);
  });
});

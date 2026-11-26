import { randomUUID } from "node:crypto";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { headers, jwt } from "./helpers/codex-reset-credit-expiry";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();

/** A ChatGPT `auth.json` whose id_token carries a plan but no workspace account. */
function authJsonWithoutAccountId() {
  const accessToken = jwt({ exp: Math.floor(now() / 1000) + 3600 });
  return JSON.stringify({
    tokens: {
      access_token: accessToken,
      refresh_token: `refresh-${randomUUID()}`,
      account_id: randomUUID(),
      id_token: jwt({
        email: "astra@example.com",
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
    },
  });
}

test("chat-events-pi-codex-credentials-006 (1/2) rejects storing a ChatGPT auth.json without an account id", async () => {
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const { actor } = owned;
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected the entitled member's workspace");
    }
    createRouteMocks(context).clerk.session(actor.userId, orgId);
    const providers = setupApp({
      context,
      routes: meModelProvidersUpsertRoutes,
    })(personalModelProvidersMainContract);

    const stored = await accept(
      providers.upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: authJsonWithoutAccountId() },
        },
      }),
      [400],
    );

    expect(stored.body.error.code).toBe("CODEX_AUTH_JSON_SHAPE_INVALID");
  });
});

test("chat-events-pi-codex-credentials-006 (2/2) enqueues an Astra prompt without decrypting stored secrets", async () => {
  // The rejected store left no ChatGPT source, so the entitled member has none.
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    const kms = useSecretKmsProbe();

    const sent = await owned.requestSendEvent(
      owned.actor,
      { prompt: "plan the launch with Astra", model: "gpt-6-astra" },
      [201],
    );

    expect(sent.status).toBe(201);
    expect(kms.decryptCalls).toBe(0);
  });
});

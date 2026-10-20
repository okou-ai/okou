import { createHmac, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { feishuOauthRoutes } from "../feishu-oauth";

const context = testContext();
const NOW = Date.parse("2026-08-25T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW / 1000);
const SECRET = "a".repeat(64);
const REDIRECT_URI = "https://app.okou.ai/connectors/feishu/callback";

function oauthClient() {
  return setupApp({ context, routes: feishuOauthRoutes })(feishuOauthContract);
}

function statePayload(): Readonly<Record<string, unknown>> {
  return {
    installationId: randomUUID(),
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
    callbackTarget: "app",
    redirectUri: REDIRECT_URI,
    timestamp: NOW_SECONDS,
  };
}

function signedState(
  payload: Readonly<Record<string, unknown>>,
  secret = SECRET,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

async function expectConnectError(state: string, error: string): Promise<void> {
  const response = await accept(
    oauthClient().connect({ query: { state } }),
    [400],
  );
  expect(response.body.error).toBe(error);
}

describe("Feishu OAuth state", () => {
  beforeEach(() => {
    mockEnv("SECRETS_ENCRYPTION_KEY", SECRET);
    mockNow(NOW);
  });

  it("preserves the 10-minute expiration boundary", async () => {
    expect.hasAssertions();
    await expectConnectError(
      signedState({
        ...statePayload(),
        timestamp: NOW_SECONDS - 10 * 60,
      }),
      "Feishu bot not found",
    );
    await expectConnectError(
      signedState({
        ...statePayload(),
        timestamp: NOW_SECONDS - 10 * 60 - 1,
      }),
      "Invalid or expired connect state",
    );
  });

  it("rejects a state signed with a different secret", async () => {
    expect.hasAssertions();
    await expectConnectError(
      signedState(statePayload(), "b".repeat(64)),
      "Invalid or expired connect state",
    );
  });
});

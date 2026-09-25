import { createHmac, randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";
import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { feishuOauthRoutes } from "../feishu-oauth";

const context = testContext({ connectorCatalog: true });
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

  it("passes a valid state to installation validation", async () => {
    expect.hasAssertions();
    await expectConnectError(
      signedState(statePayload()),
      "Feishu bot not found",
    );
  });

  it("verifies a state signed before the brand was retired", async () => {
    expect.hasAssertions();
    await expectConnectError(
      signedState({ ...statePayload(), publicBrand: "vm0" }),
      "Feishu bot not found",
    );
  });

  it("identifies a missing Lark bot from its signed redirect URI", async () => {
    expect.hasAssertions();
    mockEnv("APP_URL", "https://app.okou.ai");
    await expectConnectError(
      signedState({
        ...statePayload(),
        redirectUri: "https://app.okou.ai/integrations/lark/callback",
      }),
      "Lark bot not found",
    );
  });

  it("rejects an omitted redirect URI", async () => {
    expect.hasAssertions();
    const { redirectUri: _redirectUri, ...payload } = statePayload();
    await expectConnectError(
      signedState(payload),
      "Invalid or expired connect state",
    );
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

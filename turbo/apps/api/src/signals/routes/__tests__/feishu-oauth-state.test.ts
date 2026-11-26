import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { feishuOauthContract } from "@okouai/api-contracts/contracts/feishu-oauth";
import {
  larkOfficialContract,
  larkOfficialEventsContract,
} from "@okouai/api-contracts/contracts/lark-official";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { feishuOauthRoutes } from "../feishu-oauth";
import { larkOfficialRoutes } from "../lark-official";
import { larkOfficialEventsRoutes } from "../lark-official-events";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

/** Lark delivers an encrypted Official app event signed with its encrypt key. */
async function deliverOfficialEvent(payload: unknown): Promise<number> {
  const encryptKey = env("LARK_OFFICIAL_ENCRYPT_KEY");
  if (!encryptKey) {
    throw new Error("Expected the Official app encrypt key to be configured");
  }
  const iv = randomBytes(16);
  const cipher = createCipheriv(
    "aes-256-cbc",
    createHash("sha256").update(encryptKey).digest(),
    iv,
  );
  const body = JSON.stringify({
    encrypt: Buffer.concat([
      iv,
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]).toString("base64"),
  });
  const timestamp = String(Math.floor(now() / 1000));
  const nonce = randomUUID();
  const response = await setupRawAppRequest({
    context,
    routes: larkOfficialEventsRoutes,
  })(larkOfficialEventsContract.post.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": createHash("sha256")
        .update(`${timestamp}${nonce}${encryptKey}${body}`)
        .digest("hex"),
    },
    body,
  });
  return response.status;
}

/**
 * A member of a workspace with the Official Lark app configured starts the
 * Official connect and receives the app-connect state in its Lark URL.
 */
async function issuedConnectState(): Promise<string> {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const appId = `cli_${randomUUID().replaceAll("-", "")}`;
  const verificationToken = randomBytes(16).toString("hex");
  mockEnv("LARK_OFFICIAL_APP_ID", appId);
  mockEnv("LARK_OFFICIAL_APP_SECRET", randomBytes(16).toString("hex"));
  mockEnv("LARK_OFFICIAL_VERIFICATION_TOKEN", verificationToken);
  mockEnv("LARK_OFFICIAL_ENCRYPT_KEY", randomBytes(16).toString("hex"));
  const ticketStatus = await deliverOfficialEvent({
    ts: String(now() / 1000),
    token: verificationToken,
    event: { type: "app_ticket", app_id: appId, app_ticket: "app-ticket" },
  });
  if (ticketStatus !== 200) {
    throw new Error(`Expected the app ticket to be accepted: ${ticketStatus}`);
  }
  await updateFeatureSwitchesForUser(context, member, {
    [FeatureSwitchKey.LarkOfficialBot]: true,
  });
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  const started = await accept(
    setupApp({ context, routes: larkOfficialRoutes })(
      larkOfficialContract,
    ).connect({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected the Official connect URL to carry a state");
  }
  return state;
}

describe("Feishu OAuth state", () => {
  it("feishu-oauth-state-002 rejects a current state signed with a key other than the deployment key", async () => {
    const state = await issuedConnectState();
    mockEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("hex"));

    const response = await accept(
      setupApp({ context, routes: feishuOauthRoutes })(
        feishuOauthContract,
      ).connect({ query: { state } }),
      [400],
    );
    expect(response.body).toStrictEqual({
      error: "Invalid or expired connect state",
    });
  });
});

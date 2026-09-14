import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, expect, test, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { impactMarketingRoutes } from "../impact-marketing";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { createRouteMocks } from "./helpers/route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = "test-only-marketing-attribution-signing-secret";
function client() {
  return setupApp({ context, routes: impactMarketingRoutes })(
    impactMarketingContract,
  );
}

beforeEach(() => {
  mockOptionalEnv("IMPACT_APP_ORIGIN", "https://app.okou.ai");
  mockOptionalEnv("IMPACT_MARKETING_ATTRIBUTION", "true");
  mockOptionalEnv("MARKETING_ATTRIBUTION_SECRET", secret);
});
async function enabledActor() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.ImpactMarketingAttribution]: true,
  });
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(context, actor);
  });
  return actor;
}
test("disables the handoff until the server cutover is configured", async () => {
  mockOptionalEnv("IMPACT_MARKETING_ATTRIBUTION", "false");
  mocks.clerk.session("user_buyer", "org_buyer");
  const response = await accept(client().handoff({ headers, body: {} }), [200]);
  expect(response.body).toStrictEqual({ handoff: null });
});
test("issues a dedicated short-lived proof for the authenticated identity", async () => {
  const actor = await enabledActor();
  const response = await accept(client().handoff({ headers, body: {} }), [200]);
  expect(response.body.handoff?.iframeUrl).toBe(
    "https://www.okou.ai/finish-onboarding",
  );
  const [payload, signature] = (response.body.handoff?.token ?? "").split(".");
  expect(signature).toBe(
    createHmac("sha256", secret)
      .update(payload ?? "")
      .digest("base64url"),
  );
  const claims: unknown = JSON.parse(
    Buffer.from(payload ?? "", "base64url").toString(),
  );
  expect(claims).toMatchObject({
    sub: actor.userId,
    org: actor.orgId,
    admin: true,
    aud: "https://www.okou.ai",
    parent: "https://app.okou.ai",
    nonce: response.body.handoff?.nonce,
  });
  const timestamps = claims as { iat: number; exp: number };
  expect(timestamps.exp - timestamps.iat).toBe(120);
  expect(response.body.handoff?.token).not.toContain("clerk-session");
});
test("ordinary members receive no authority to alter organization billing attribution", async () => {
  const actor = await enabledActor();
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  const handoff = await accept(client().handoff({ headers, body: {} }), [200]);
  const payload = handoff.body.handoff?.token.split(".")[0] ?? "";
  expect(
    JSON.parse(Buffer.from(payload, "base64url").toString()),
  ).toMatchObject({ admin: false });
  const result = await accept(client().sync({ headers, body: {} }), [200]);
  expect(result.body).toStrictEqual({ synced: false });
});
test("resolves consented billing metadata only by the authenticated org", async () => {
  const actor = await enabledActor();
  let requestedOrg: unknown;
  server.use(
    http.post(
      "https://www.okou.ai/api/marketing/impact/lookup",
      async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
        requestedOrg = await request.json();
        return HttpResponse.json({ metadata: {} });
      },
    ),
  );
  const result = await accept(client().sync({ headers, body: {} }), [200]);
  expect(requestedOrg).toStrictEqual({ orgId: actor.orgId });
  expect(result.body.synced).toBeFalsy();
});
test("ignores cached Apps submitting old Impact query/cookie attribution after cutover", async () => {
  const userId = "user_legacy";
  mocks.clerk.session(userId, null);
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: userId,
        privateMetadata: {
          impact_attribution: {
            clickId: "old",
            capturedAt: nowDate().toISOString(),
          },
        },
      },
    ],
  });
  const response = await accept(
    setupApp({ context, routes: acquisitionAttributionRoutes })(
      acquisitionAttributionContract,
    ).recordSignup({
      headers,
      body: {
        attribution: {},
        impactAttribution: {
          clickId: "forged",
          capturedAt: nowDate().toISOString(),
        },
      },
    }),
    [200],
  );
  expect(response.body.recorded).toBeFalsy();
  expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
});

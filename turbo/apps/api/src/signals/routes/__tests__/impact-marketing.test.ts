import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { beforeEach, expect, test } from "vitest";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { impactMarketingRoutes } from "../impact-marketing";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const secret = randomBytes(32).toString("hex");
function client() {
  return setupApp({ context, routes: impactMarketingRoutes })(
    impactMarketingContract,
  );
}

beforeEach(() => {
  mockOptionalEnv("IMPACT_APP_ORIGIN", "https://app.okou.ai");
  mockOptionalEnv("MARKETING_ATTRIBUTION_SECRET", secret);
});
function authenticatedActor() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  return actor;
}

test("issues a dedicated short-lived identity proof", async () => {
  const actor = authenticatedActor();
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
  expect(claims).toStrictEqual({
    sub: actor.userId,
    org: actor.orgId,
    admin: true,
    aud: "https://www.okou.ai",
    parent: "https://app.okou.ai",
    nonce: response.body.handoff?.nonce,
    iat: expect.any(Number),
    exp: expect.any(Number),
  });
  const timestamps = claims as { iat: number; exp: number };
  expect(timestamps.exp - timestamps.iat).toBe(120);
  expect(response.body.handoff?.token).not.toContain("clerk-session");
});
test("ordinary members receive no authority to alter organization billing attribution", async () => {
  const actor = authenticatedActor();
  mocks.clerk.session(actor.userId, actor.orgId, "org:member");
  const handoff = await accept(client().handoff({ headers, body: {} }), [200]);
  const payload = handoff.body.handoff?.token.split(".")[0] ?? "";
  expect(
    JSON.parse(Buffer.from(payload, "base64url").toString()),
  ).toMatchObject({ admin: false });
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
  const cachedSignupBody = {
    attribution: {},
    impactAttribution: {
      clickId: "forged",
      capturedAt: nowDate().toISOString(),
    },
  };
  const response = await accept(
    setupApp({ context, routes: acquisitionAttributionRoutes })(
      acquisitionAttributionContract,
    ).recordSignup({
      headers,
      body: cachedSignupBody,
    }),
    [200],
  );
  expect(response.body.recorded).toBeFalsy();
  expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
});

test("does not copy retired Impact fields while recording normal signup metadata", async () => {
  const userId = "user_signup";
  mocks.clerk.session(userId, null);
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: userId,
        privateMetadata: {
          unrelated: "preserved",
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
      body: { attribution: { ga_client_id: "123.456" } },
    }),
    [200],
  );
  expect(response.body.recorded).toBeTruthy();
  expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
    userId,
    {
      privateMetadata: {
        unrelated: "preserved",
        signup_attribution: {
          ga_client_id: "123.456",
          recorded_at: expect.any(String),
        },
      },
    },
  );
});

test("signs the server-verified creation time and allowlisted observations", async () => {
  const actor = authenticatedActor();
  const createdAt = nowDate().getTime() - 60_000;
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        createdAt,
        banned: false,
        locked: false,
        privateMetadata: {},
      },
    ],
  });
  const event = {
    id: randomUUID(),
    name: "StepViewed" as const,
    at: nowDate().getTime(),
    properties: { step_key: "welcome" },
  };
  const response = await accept(
    client().handoff({
      headers,
      body: { acquisition: { version: 2, checkSignup: true, events: [event] } },
    }),
    [200],
  );
  const payload = response.body.handoff?.token.split(".")[0] ?? "";
  expect(
    JSON.parse(Buffer.from(payload, "base64url").toString()),
  ).toMatchObject({
    sub: actor.userId,
    acquisition: { version: 2, signupAt: createdAt, events: [event] },
  });
});

test("includes an already-recorded signup in the Marketing shadow comparison", async () => {
  const actor = authenticatedActor();
  const createdAt = nowDate().getTime() - 60_000;
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: actor.userId,
        createdAt,
        privateMetadata: {
          signup_attribution: { recorded_at: nowDate().toISOString() },
        },
      },
    ],
  });
  const response = await accept(
    client().handoff({
      headers,
      body: { acquisition: { version: 2, checkSignup: true, events: [] } },
    }),
    [200],
  );
  const payload = response.body.handoff?.token.split(".")[0] ?? "";
  expect(
    JSON.parse(Buffer.from(payload, "base64url").toString()).acquisition,
  ).toStrictEqual({
    version: 2,
    signupAt: createdAt,
    events: [],
  });
});

test("keeps Impact identity handoff available when the shadow signup lookup fails", async () => {
  const actor = authenticatedActor();
  context.mocks.clerk.users.getUserList.mockRejectedValue(
    new Error("Clerk unavailable"),
  );
  const response = await accept(
    client().handoff({
      headers,
      body: { acquisition: { version: 2, checkSignup: true, events: [] } },
    }),
    [200],
  );
  const payload = response.body.handoff?.token.split(".")[0] ?? "";
  expect(
    JSON.parse(Buffer.from(payload, "base64url").toString()),
  ).toMatchObject({
    sub: actor.userId,
    org: actor.orgId,
    acquisition: { version: 2, events: [] },
  });
});

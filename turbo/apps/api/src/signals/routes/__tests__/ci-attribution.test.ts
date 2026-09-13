import { randomUUID } from "node:crypto";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const attribution = Object.freeze({
  gclid: "ci-click",
  okou_campaign_id: "24220469665",
});

function client() {
  return setupApp({ context, routes: acquisitionAttributionRoutes })(
    acquisitionAttributionContract,
  );
}

describe("CI attribution", () => {
  it.each(["pr-123", "staging"])(
    "returns no conversions without Clerk directory access in %s",
    async (jobRef) => {
      mockEnv("ENV", "preview");
      mockOptionalEnv("OKOU_PREVIEW_JOB_REF", jobRef);
      mocks.clerk.session(`user_${randomUUID()}`, null);
      context.mocks.clerk.users.getUserList.mockRejectedValue(
        new Error("Clerk directory quota exhausted"),
      );
      context.mocks.clerk.users.updateUserMetadata.mockRejectedValue(
        new Error("Clerk directory quota exhausted"),
      );

      const signup = await accept(
        client().recordSignup({
          headers,
          body: {
            attribution,
            impactAttribution: {
              clickId: "ci-impact-click",
              capturedAt: nowDate().toISOString(),
            },
          },
        }),
        [200],
      );
      expect(signup.body).toStrictEqual({
        recorded: false,
        googleAdsAccountId: null,
      });

      const account = await accept(
        client().resolveGoogleAdsAccount({ headers, body: { attribution } }),
        [200],
      );
      expect(account.body).toStrictEqual({ googleAdsAccountId: null });

      const milestones = await accept(
        client().googleAdsMilestones({ headers }),
        [200],
      );
      expect(milestones.body).toStrictEqual({
        milestones: [],
        googleAdsAccountId: null,
      });
      expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.users.updateUserMetadata,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    { environment: "production", jobRef: "pr-123" },
    { environment: "development", jobRef: "pr-123" },
    { environment: "preview", jobRef: undefined },
  ] as const)(
    "keeps Clerk attribution active for $environment without a CI preview deployment",
    async ({ environment, jobRef }) => {
      mockEnv("ENV", environment);
      mockOptionalEnv("OKOU_PREVIEW_JOB_REF", jobRef);
      const userId = `user_${randomUUID()}`;
      mocks.clerk.session(userId, null);
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [{ id: userId, privateMetadata: {} }],
      });

      const signup = await accept(
        client().recordSignup({ headers, body: { attribution } }),
        [200],
      );
      expect(signup.body).toStrictEqual({
        recorded: true,
        googleAdsAccountId: "7935750692",
      });
      expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
        userId,
        {
          privateMetadata: {
            signup_attribution: {
              gclid: "ci-click",
              vm0_campaign_id: "24220469665",
              recorded_at: expect.any(String),
            },
          },
        },
      );
    },
  );

  it("still requires authentication in CI previews", async () => {
    mockEnv("ENV", "preview");
    mockOptionalEnv("OKOU_PREVIEW_JOB_REF", "pr-123");
    const response = await client().recordSignup({ body: { attribution } });
    expect(response.status).toBe(401);
  });
});

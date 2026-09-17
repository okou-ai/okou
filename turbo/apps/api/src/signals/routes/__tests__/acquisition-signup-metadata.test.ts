import { expect, test } from "vitest";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

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

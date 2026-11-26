import { randomUUID } from "node:crypto";
import { onboardingRecommendationContract } from "@okouai/api-contracts/contracts/onboarding";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { onboardingRecommendationRoutes } from "../onboarding-recommendations";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const recommendations = setupApp({
  context,
  routes: onboardingRecommendationRoutes,
})(onboardingRecommendationContract);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

test("onboarding-recommendations-001 starts an owned job and shows its bounded status only to the owner", async () => {
  const orgId = `org_${randomUUID()}`;
  const ownerId = `user_${randomUUID()}`;
  const peerId = `user_${randomUUID()}`;
  const mocks = createRouteMocks(context);
  mocks.clerk.session(ownerId, orgId);

  const started = await accept(
    recommendations.start({
      headers: authHeaders(),
      body: { industry: "operations", locale: "en-US" },
    }),
    [202],
  );
  const owner = await accept(
    recommendations.get({
      headers: authHeaders(),
      params: { jobId: started.body.jobId },
    }),
    [200],
  );
  mocks.clerk.session(peerId, orgId, "org:member");
  const peer = await accept(
    recommendations.get({
      headers: authHeaders(),
      params: { jobId: started.body.jobId },
    }),
    [404],
  );

  expect(started.body).toStrictEqual({
    jobId: started.body.jobId,
    status: "pending",
  });
  expect(owner.body).toStrictEqual({
    jobId: started.body.jobId,
    status: expect.stringMatching(/^(pending|running|failed)$/),
  });
  expect(peer.body.error.code).toBe("NOT_FOUND");
  for (const response of [started, owner, peer]) {
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});

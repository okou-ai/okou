import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();
test("onboarding-start-005 the staging onboarding page reports its start to staging Marketing", async () => {
  const start = createDeferredPromise<string>(context.signal);
  context.mocks.api(
    marketingEventsContract.record,
    ({ body, request, respond }) => {
      if (body.tag === "onboarding-start" && !start.settled()) {
        start.resolve(request.url);
      }
      return respond(204);
    },
  );
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    host: "staging-app.omby.ai",
    path: "/onboarding",
  });
  await screen.findByRole("heading", { name: "What kind of work do you do?" });
  await expect(start.promise).resolves.toBe(
    "https://staging-www.omby.ai/api/events",
  );
});

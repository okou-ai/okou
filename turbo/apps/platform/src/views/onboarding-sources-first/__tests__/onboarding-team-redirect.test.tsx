import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("onboarding-team-redirect-002 opens the experience question with the member's invite code", async () => {
  context.mocks.data.onboardingStatus({
    isAdmin: false,
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({ context, path: "/onboarding/team?redeemCode=LAUNCH50" });
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  const destination = new URL(window.location.href);
  expect([
    destination.pathname,
    destination.searchParams.get("redeemCode"),
  ]).toStrictEqual(["/onboarding/experience", "LAUNCH50"]);
});

import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { billingUsagePackCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

vi.hoisted(() => {
  // Product analytics resolves the deployment environment at module load.
  window.location.href = "https://app.okou.ai/";
});

const context = testContext();

function button(name: string): HTMLElement {
  const found = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Button not found: ${name}`);
  }
  return found;
}

test("Onboarding and checkout send their business events to Marketing", async () => {
  const posthog = context.mocks.posthog();
  const requests: Request[] = [];
  const checkoutReceived = context.mocks.deferred<Request>();
  context.mocks.api(
    marketingEventsContract.record,
    ({ request, body, respond }) => {
      if (body.tag === "checkout-start") {
        checkoutReceived.resolve(request);
      } else {
        requests.push(request);
      }
      return respond(204);
    },
  );
  const template = VIDEO_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Expected a video template");
  }
  mockChatLifecycle(context);
  context.mocks.api(billingUsagePackCheckoutContract.create, ({ respond }) => {
    return respond(200, {
      url: "https://checkout.stripe.com/test/onboarding-video",
    });
  });

  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    path: "/onboarding/video-template?choice=video",
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", {
      name: "Pick a video template to start from",
    }),
  ).resolves.toBeInTheDocument();

  click(button(`Select ${template.title} video template`));
  click(button("Continue"));

  await expect(
    screen.findByRole("heading", { name: "Customize your video" }),
  ).resolves.toBeInTheDocument();
  await fill(
    screen.getByLabelText("Custom video prompt"),
    "A 20-second launch teaser for a habit-tracking app.",
  );
  click(
    await waitFor(() => {
      return button("Upgrade Pro to run");
    }),
  );

  await waitFor(() => {
    expect(window.location.href).toBe(
      "https://checkout.stripe.com/test/onboarding-video",
    );
  });
  expect(requests).toHaveLength(2);
  await expect(requests[0]?.json()).resolves.toStrictEqual({
    eventId: expect.any(String),
    tag: "onboarding-start",
  });
  const checkoutRequest = await checkoutReceived.promise;
  await expect(checkoutRequest.json()).resolves.toStrictEqual({
    eventId: expect.any(String),
    tag: "checkout-start",
  });
  expect(posthog.events).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "PaidOnboarding: StepViewed",
        properties: expect.objectContaining({
          flow: "paid_onboarding",
          step_key: "video-template",
        }),
      }),
      expect.objectContaining({
        name: "PaidOnboarding: CheckoutCreated",
        properties: expect.objectContaining({
          checkout_source: "onboarding_video",
        }),
      }),
      expect.objectContaining({
        name: "PaidOnboarding: RedirectToStripe",
        properties: expect.objectContaining({
          checkout_source: "onboarding_video",
        }),
      }),
    ]),
  );
});

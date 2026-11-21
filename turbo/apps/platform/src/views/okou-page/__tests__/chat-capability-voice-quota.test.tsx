import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import {
  billingUsagePackManagementContract,
  billingUsagePackCatalogContract,
  billingStatusContract,
} from "@okouai/api-contracts/contracts/billing";
import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { HttpResponse } from "msw";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatCapabilityHelpers,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
async function startMeteredVoiceInput(
  tier: "limited-free-1" | "pro",
  role: "admin" | "member",
  usage: { count: number },
) {
  context.mocks.browser.voiceInput({ rms: 0.12 });
  createChatCapabilityHelpers(context).installCapabilityChat({ events: [] });
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { id: "org_default", name: "Launch team", role });
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      ...billingPlanCapabilities(tier),
      onboardingPaymentPending: false,
      hasSubscription: tier === "pro",
      subscriptionStatus: tier === "pro" ? "active" : null,
      tier,
    });
  });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, {
      count: usage.count,
      limit: 10,
      allowed: usage.count < 10,
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      supportsFreeMembers: true,
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 2000,
          bonusCredits: 200,
          totalCredits: 2200,
        },
      ],
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No managed plan" },
    });
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Voice input"));
}
test("chat-capability-voice-quota-001 offers Pro and Team to the free workspace admin at the voice limit", async () => {
  await startMeteredVoiceInput("limited-free-1", "admin", { count: 10 });
  await screen.findByText(
    "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
  );
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(
    within(chooser).findByRole("article", { name: "Pro plan" }),
  ).resolves.toBeVisible();
  await expect(
    within(chooser).findByRole("article", { name: "Team plan" }),
  ).resolves.toBeVisible();
});
test("chat-capability-voice-quota-002 offers Team after the Pro admin's transcription reaches the limit", async () => {
  const usage = { count: 9 };
  context.mocks.http.post("*" + voiceIoTranscribeContract.segment.path, () => {
    usage.count = 10;
    return HttpResponse.json(
      {
        error: {
          code: "DAILY_RATE_LIMIT_EXCEEDED",
          message: "Voice limit reached",
        },
        quota: { count: 10, limit: 10 },
      },
      { status: 429 },
    );
  });
  await startMeteredVoiceInput("pro", "admin", usage);
  click(await findEnabledButton("Stop recording"));
  await screen.findByText(
    "Voice input limit reached. Upgrade to Team for higher limits.",
  );
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(
    within(chooser).findByRole("article", { name: "Team plan" }),
  ).resolves.toBeVisible();
});
test("chat-capability-voice-quota-004 directs a free workspace member to an admin from the current chat", async () => {
  await startMeteredVoiceInput("limited-free-1", "member", { count: 10 });
  await screen.findByText(
    "Voice input limit reached. Ask a workspace admin to upgrade for higher limits.",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  findEnabledButton,
  installRunChat,
  readyChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { billingPlanCapabilities } from "../../../mocks/handlers/api-billing.ts";

type VoicePlan = "free" | "pro" | "team" | "custom";
type WorkspaceRole = "admin" | "member";

function billingStatus(tier: VoicePlan): BillingStatusResponse {
  const paid = tier !== "free";
  return {
    showUsagePack: false,
    tier,
    ...billingPlanCapabilities(tier),
    credits: paid ? 20_000 : 500,
    onboardingPaymentPending: false,
    subscriptionStatus: paid ? "active" : null,
    currentPeriodEnd: paid ? "2026-09-30T00:00:00.000Z" : null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: paid,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function installVoicePlan(tier: VoicePlan, role: WorkspaceRole): void {
  context.mocks.data.org({
    id: "org_voice_workspace",
    name: "Voice Workspace",
    role,
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier));
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      usagePacks: ([20, 50, 100, 200] as const).map((usagePackUsd) => {
        const purchasedCredits = usagePackUsd * 100;
        const bonusCredits = usagePackUsd * 10;
        return {
          usagePackUsd,
          priceUsd: usagePackUsd,
          purchasedCredits,
          bonusCredits,
          totalCredits: purchasedCredits + bonusCredits,
        };
      }),
    });
  });
  context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No legacy plan migration" },
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No managed usage pack plan" },
    });
  });
}

function installExhaustedVoiceQuota(): void {
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: false, count: 10, limit: 10 });
  });
}

async function readyVoiceInput(): Promise<HTMLElement> {
  await readyChat();
  const voiceInput = await findButton("Voice input");
  expect(voiceInput).toBeEnabled();
  return voiceInput;
}

async function expectVoiceLimitMessage(message: string): Promise<void> {
  await waitFor(() => {
    const visibleMessage = screen.getAllByText(message).find((candidate) => {
      return candidate.closest('[data-sonner-toast][data-visible="true"]');
    });
    expect(visibleMessage).toBeVisible();
  });
}

test("Offer role-aware recovery when voice quota is exhausted", async () => {
  context.mocks.browser.voiceInput();
  installVoicePlan("free", "admin");
  installExhaustedVoiceQuota();
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expectVoiceLimitMessage(
    "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
  );
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  expect(chooser).toBeVisible();
  await expect(
    within(chooser).findByRole("article", { name: "Pro plan" }),
  ).resolves.toBeVisible();
  await expect(
    within(chooser).findByRole("article", { name: "Team plan" }),
  ).resolves.toBeVisible();
});

test("Offer a Team upgrade when a Pro admin exhausts voice quota", async () => {
  context.mocks.browser.voiceInput({
    rms: 0.12,
  });
  installVoicePlan("pro", "admin");
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 9, limit: 10 });
  });
  context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
    return HttpResponse.json(
      {
        error: {
          code: "DAILY_RATE_LIMIT_EXCEEDED",
          message: "Daily voice request limit reached",
        },
        quota: { count: 10, limit: 10 },
      },
      { status: 429 },
    );
  });
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());
  click(await findEnabledButton("Stop recording"));

  await expectVoiceLimitMessage(
    "Voice input limit reached. Upgrade to Team for higher limits.",
  );
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  expect(chooser).toBeVisible();
  await expect(
    within(chooser).findByRole("article", { name: "Team plan" }),
  ).resolves.toBeVisible();
});

test.each([402, 429])(
  "Keep a recorded draft retryable after a %s quota response",
  async (status) => {
    context.mocks.browser.voiceInput({ rms: 0.12 });
    installVoicePlan("team", "admin");
    context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
      return respond(200, { allowed: true, count: 0, limit: 60 });
    });
    let exhausted = true;
    context.mocks.http.post("*/api/voice-io/transcribe/segment", () => {
      if (exhausted) {
        return HttpResponse.json(
          {
            error: {
              code: "DAILY_RATE_LIMIT_EXCEEDED",
              message: "Daily voice request limit reached",
            },
          },
          { status },
        );
      }
      return HttpResponse.json({
        transcript: "retained recording",
        polishedText: "Retained recording.",
        language: "en-US",
      });
    });
    installRunChat();
    await setupPage({
      context,
      path: RUN_PATH,
    });
    click(await readyVoiceInput());
    const stop = await findButton("Stop recording");
    await waitFor(() => {
      return expect(stop).toBeEnabled();
    });
    click(stop);
    await expectVoiceLimitMessage(
      "Voice input limit reached. Please wait for your limit to reset.",
    );
    const retry = await findEnabledButton("Retry");

    exhausted = false;
    click(retry);
    await findEnabledButton("Send");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Retained recording.",
    );
  },
);

test("Ask an admin when a member exhausts voice quota", async () => {
  context.mocks.browser.voiceInput();
  installVoicePlan("free", "member");
  installExhaustedVoiceQuota();
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expect(
    screen.findByText(
      "Voice input limit reached. Ask a workspace admin to upgrade for higher limits.",
    ),
  ).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();
});

test("Wait for voice allowance reset on a Team plan", async () => {
  context.mocks.browser.voiceInput();
  installVoicePlan("team", "admin");
  installExhaustedVoiceQuota();
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expect(
    screen.findByText(
      "Voice input limit reached. Please wait for your limit to reset.",
    ),
  ).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();
});

test("Wait for voice allowance reset on a Custom plan", async () => {
  context.mocks.browser.voiceInput();
  installVoicePlan("custom", "admin");
  installExhaustedVoiceQuota();
  installRunChat();

  await setupPage({ context, path: RUN_PATH });

  click(await readyVoiceInput());

  await expect(
    screen.findByText(
      "Voice input limit reached. Please wait for your limit to reset.",
    ),
  ).resolves.toBeVisible();
  expect(
    screen.queryByRole("dialog", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();
});

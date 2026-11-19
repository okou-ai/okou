import {
  billingStatusContract,
  billingUsagePackCatalogContract,
  billingUsagePackManagementContract,
} from "@okouai/api-contracts/contracts/billing";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  billingPlanCapabilities,
  defaultBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
function getButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButton(name, container);
  if (!button) {
    throw new Error(`Button ${name} is not available`);
  }
  return button;
}

interface VoiceQuota {
  allowed: boolean;
  count: number;
  limit: number;
}

function arrangeWorkspace(
  tier: "limited-free-1" | "pro",
  role: "admin" | "member",
  initialQuota: VoiceQuota,
): { quota: VoiceQuota } {
  const current = { quota: initialQuota };
  context.mocks.data.org({ id: "org_1", name: "Test Org", role });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      ...defaultBillingStatus(),
      tier,
      ...billingPlanCapabilities(tier),
    });
  });
  context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No usage packs" },
    });
  });
  context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
    return respond(200, {
      usagePacks: [
        {
          usagePackUsd: 20,
          priceUsd: 20,
          purchasedCredits: 2000,
          bonusCredits: 200,
          totalCredits: 2200,
        },
      ],
      supportsFreeMembers: true,
    });
  });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, current.quota);
  });
  context.mocks.browser.voiceInput({ rms: 0.1 });
  return current;
}

async function openVoiceInput(): Promise<void> {
  await setupPage({ context, path: "/" });
  const voiceInput = await findButton("Voice input");
  await waitFor(() => {
    expect(voiceInput).toBeEnabled();
  });
  click(voiceInput);
}

test("Offer role-aware recovery when voice quota is exhausted", async () => {
  arrangeWorkspace("limited-free-1", "admin", {
    allowed: false,
    count: 10,
    limit: 10,
  });

  await openVoiceInput();

  await expect(
    screen.findByText(
      "Voice input limit reached. Upgrade to Pro or Team for higher limits.",
    ),
  ).resolves.toBeInTheDocument();
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(
    within(chooser).findByRole("heading", { name: "Pro" }),
  ).resolves.toBeInTheDocument();
  expect(
    within(chooser).getByRole("heading", { name: "Team" }),
  ).toBeInTheDocument();
});

test("Offer a Team upgrade when a Pro admin exhausts voice quota", async () => {
  const current = arrangeWorkspace("pro", "admin", {
    allowed: true,
    count: 9,
    limit: 10,
  });
  let transcriptions = 0;
  context.mocks.http.post(`*${voiceIoTranscribeContract.segment.path}`, () => {
    transcriptions += 1;
    current.quota = { allowed: false, count: 10, limit: 10 };
    return HttpResponse.json(
      {
        error: {
          code: "QUOTA_EXCEEDED",
          message: "Voice input limit reached",
        },
        quota: { count: 10, limit: 10 },
      },
      { status: 402 },
    );
  });

  await openVoiceInput();
  const stop = await findButton("Stop recording");
  await waitFor(() => {
    expect(stop).toBeEnabled();
  });
  click(stop);

  await expect(
    screen.findByText(
      "Voice input limit reached. Upgrade to Team for higher limits.",
    ),
  ).resolves.toBeInTheDocument();
  expect(transcriptions).toBe(1);
  const chooser = await screen.findByRole("dialog", { name: "Choose a plan" });
  await expect(
    within(chooser).findByRole("heading", { name: "Team" }),
  ).resolves.toBeInTheDocument();
  expect(getButton("Start with Team", chooser)).toBeEnabled();
});

test("Ask an admin when a member exhausts voice quota", async () => {
  arrangeWorkspace("limited-free-1", "member", {
    allowed: false,
    count: 10,
    limit: 10,
  });

  await openVoiceInput();

  await expect(
    screen.findByText(
      "Voice input limit reached. Ask a workspace admin to upgrade for higher limits.",
    ),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(getButton("Voice input")).toBeEnabled();
  });
  expect(
    screen.queryByRole("dialog", { name: "Choose a plan" }),
  ).not.toBeInTheDocument();
});

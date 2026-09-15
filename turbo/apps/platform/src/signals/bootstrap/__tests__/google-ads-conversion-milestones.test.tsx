import {
  acquisitionAttributionContract,
  type GoogleAdsConversionMilestone,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { syncGoogleAdsConversionMilestones$ } from "../google-ads-conversion-milestones.ts";

const context = testContext();

type GoogleTagParameters = {
  readonly send_to: string;
  readonly value: number;
  readonly currency: "USD";
  readonly transaction_id?: string;
};

type GoogleTag = (
  command: "event",
  eventName: "conversion",
  parameters: GoogleTagParameters,
) => void;

const ALL_MILESTONES = [
  {
    kind: "free_trial_completed",
    transactionId: "milestone_free_trial",
  },
  {
    kind: "first_run_completed",
    transactionId: "milestone_first_run",
  },
  {
    kind: "second_run_completed",
    transactionId: "milestone_second_run",
  },
  {
    kind: "multi_day_run_completed",
    transactionId: "milestone_multi_day",
  },
  {
    kind: "one_connector_connected",
    transactionId: "milestone_one_connector",
  },
  {
    kind: "two_connectors_connected",
    transactionId: "milestone_two_connectors",
  },
] as const satisfies readonly GoogleAdsConversionMilestone[];

function reportedMilestoneEvents(
  googleTag: ReturnType<typeof vi.fn<GoogleTag>>,
  milestones: readonly GoogleAdsConversionMilestone[],
): GoogleTagParameters[] {
  const transactionIds = new Set(
    milestones.map((milestone) => {
      return milestone.transactionId;
    }),
  );
  return googleTag.mock.calls.flatMap((call) => {
    const parameters = call[2];
    return parameters.transaction_id !== undefined &&
      transactionIds.has(parameters.transaction_id)
      ? [parameters]
      : [];
  });
}

test("Each product milestone uses its defined conversion action", async () => {
  let milestoneReads = 0;
  let milestones: readonly GoogleAdsConversionMilestone[] = [];
  const googleTag = vi.fn<GoogleTag>();
  vi.stubGlobal("gtag", googleTag);
  context.mocks.api(
    acquisitionAttributionContract.googleAdsMilestones,
    ({ respond }) => {
      milestoneReads += 1;
      return respond(200, {
        milestones: [...milestones],
        googleAdsAccountId: "7935750692",
      });
    },
  );

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(milestoneReads).toBe(1);
  });

  milestones = ALL_MILESTONES;
  await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);

  expect(reportedMilestoneEvents(googleTag, ALL_MILESTONES)).toStrictEqual([
    {
      send_to: "AW-18407336975/kS5jCP6RrOccEI_YpslE",
      value: 15,
      currency: "USD",
      transaction_id: "milestone_free_trial",
    },
    {
      send_to: "AW-18407336975/uEoeCIGSrOccEI_YpslE",
      value: 5,
      currency: "USD",
      transaction_id: "milestone_first_run",
    },
    {
      send_to: "AW-18407336975/0S04CISSrOccEI_YpslE",
      value: 10,
      currency: "USD",
      transaction_id: "milestone_second_run",
    },
    {
      send_to: "AW-18407336975/ZGzhCI2SrOccEI_YpslE",
      value: 15,
      currency: "USD",
      transaction_id: "milestone_multi_day",
    },
    {
      send_to: "AW-18407336975/QpfCCIeSrOccEI_YpslE",
      value: 8,
      currency: "USD",
      transaction_id: "milestone_one_connector",
    },
    {
      send_to: "AW-18407336975/DFtNCIqSrOccEI_YpslE",
      value: 15,
      currency: "USD",
      transaction_id: "milestone_two_connectors",
    },
  ]);
});

test("Only newly earned conversion milestones are reported", async () => {
  let milestoneReads = 0;
  let milestones: readonly GoogleAdsConversionMilestone[] = [ALL_MILESTONES[1]];
  const googleTag = vi.fn<GoogleTag>();
  vi.stubGlobal("gtag", googleTag);
  context.mocks.api(
    acquisitionAttributionContract.googleAdsMilestones,
    ({ respond }) => {
      milestoneReads += 1;
      return respond(200, {
        milestones: [...milestones],
        googleAdsAccountId: "7935750692",
      });
    },
  );

  await setupPage({ context, path: "/agents", host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(milestoneReads).toBe(1);
  });

  const existingAndNewMilestones = [ALL_MILESTONES[1], ALL_MILESTONES[2]];
  milestones = existingAndNewMilestones;
  await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);

  expect(reportedMilestoneEvents(googleTag, ALL_MILESTONES)).toStrictEqual([
    {
      send_to: "AW-18407336975/0S04CISSrOccEI_YpslE",
      value: 10,
      currency: "USD",
      transaction_id: "milestone_second_run",
    },
  ]);

  await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);

  expect(reportedMilestoneEvents(googleTag, ALL_MILESTONES)).toHaveLength(1);
});

// Milestone polling has no page-visible control; this bootstrap test drives the
// existing background synchronization boundary with external API responses.
test("Unknown ownership leaves earned milestones eligible for later delivery", async () => {
  const googleTag = vi.fn<GoogleTag>();
  vi.stubGlobal("gtag", googleTag);
  let accountId: string | null = "7935750692";
  let milestones: readonly GoogleAdsConversionMilestone[] = [];
  context.mocks.api(
    acquisitionAttributionContract.googleAdsMilestones,
    ({ respond }) => {
      return respond(200, {
        milestones: [...milestones],
        googleAdsAccountId: accountId,
      });
    },
  );
  await setupPage({ context, path: "/agents", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
  accountId = null;
  milestones = ALL_MILESTONES;
  await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);
  expect(reportedMilestoneEvents(googleTag, ALL_MILESTONES)).toHaveLength(0);
  accountId = "1001302527";
  await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);
  expect(reportedMilestoneEvents(googleTag, ALL_MILESTONES)).toHaveLength(0);
  accountId = "7935750692";
  await context.store.set(syncGoogleAdsConversionMilestones$, context.signal);
  expect(reportedMilestoneEvents(googleTag, ALL_MILESTONES)).toHaveLength(6);
});

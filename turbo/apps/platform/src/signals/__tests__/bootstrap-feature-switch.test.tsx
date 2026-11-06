import { testContext } from "./test-helpers.ts";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage, startPage } from "../../__tests__/page-helper.ts";
import { bootstrapSkeleton } from "../../test/bootstrap-skeleton.ts";

const context = testContext();
test("A signed-out page does not load workspace features", async () => {
  let workspaceFeatureRequested = false;
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    workspaceFeatureRequested = true;
    return respond(200, {
      switches: { [FeatureSwitchKey.Banking]: true },
      effectiveSwitches: { [FeatureSwitchKey.Banking]: true },
    });
  });

  await setupPage({
    context,
    path: "/sign-in",
    auth: null,
  });

  // Hosted Clerk owns the form, so the mounted component marks readiness.
  await screen.findByTestId("clerk-sign-in");

  expect(workspaceFeatureRequested).toBeFalsy();
});

test("Routes wait for authoritative workspace features", async () => {
  const requestStarted = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      requestStarted.resolve(undefined);
      await withSignal(releaseResponse.promise);
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
      });
    },
  );

  const page = await startPage({ context, path: "/agents" });
  await requestStarted.promise;
  expect(bootstrapSkeleton()).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Agents" }),
  ).not.toBeInTheDocument();

  releaseResponse.resolve(undefined);
  await page.ready;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
});

test("A rate-limited Marketing session does not block authenticated startup", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  context.mocks.api(marketingHandoffsContract.session, ({ respond }) => {
    return respond(429, {
      error: {
        code: "RATE_LIMITED",
        message: "Too many uploads. Try again later.",
      },
    });
  });

  await setupPage({
    context,
    path: "/agents",
    featureSwitches: { [FeatureSwitchKey.MarketingContentHandoff]: true },
  });

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("MarketingHandoff"),
    expect.stringContaining("rate limited"),
  );
});

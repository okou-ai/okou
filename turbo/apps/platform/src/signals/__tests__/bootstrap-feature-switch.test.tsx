import { testContext } from "./test-helpers.ts";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

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

test("The app waits for authoritative workspace features before mounting", async () => {
  const requestStarted = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      requestStarted.resolve(undefined);
      await withSignal(releaseResponse.promise);
      const switches = {
        [FeatureSwitchKey.SingleAgent]: false,
      };
      return respond(200, { switches, effectiveSwitches: switches });
    },
  );

  const page = await startPage({ context, path: "/agents" });
  await requestStarted.promise;
  expect(bootstrapSkeleton()).toBeVisible();
  expect(document.getElementById("root")).toBeNull();

  releaseResponse.resolve(undefined);
  await page.ready;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
});

test("An upgrade required by the workspace switch request is shown during startup", async () => {
  context.mocks.http.get("*/api/feature-switches", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });

  const page = await startPage({ context, path: "/agents" });
  await expect(page.ready).rejects.toMatchObject({
    status: CLIENT_FORCE_UPGRADE_STATUS,
  });
  await expect(
    screen.findByRole("dialog", { name: "Update required" }),
  ).resolves.toBeVisible();
  expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
});

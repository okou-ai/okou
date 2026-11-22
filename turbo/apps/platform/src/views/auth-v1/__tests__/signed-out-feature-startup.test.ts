import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
test("bootstrap-feature-switch-001 Workspace features stay private while the signed-out member sees sign-in", async () => {
  const unexpected = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    unexpected.resolve();
    return respond(200, { switches: {}, effectiveSwitches: {} });
  });
  await setupPage({ context, path: "/sign-in", auth: null });
  await expect(screen.findByTestId("clerk-sign-in")).resolves.toBeVisible();
  expect(unexpected.settled()).toBeFalsy();
});

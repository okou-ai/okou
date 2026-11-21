import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
test("agent-suggestions-039 the empty For you destination reports zero remaining items", async () => {
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [] });
  });
  await setupPage({
    context,
    path: "/for-you",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
  await screen.findByText("All caught up");
  expect(screen.getByText("0 to go")).toBeInTheDocument();
  expect(location.pathname).toBe("/for-you");
});

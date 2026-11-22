import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
async function settings(rollout: boolean, enabled = false) {
  let active = enabled;
  context.mocks.api(feedContract.sources, ({ respond }) => {
    return respond(200, {
      suggestions: active,
      whatsNew: true,
      offers: true,
      systemUpdates: true,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: active,
      status: active ? "preparing" : "paused",
      unavailableReason: null,
    });
  });
  context.mocks.api(
    proactiveSuggestionsContract.updateWithFeed,
    ({ body, respond }) => {
      active = body.enabled;
      return respond(200, {
        enabled: active,
        status: active ? "enabled" : "paused",
        unavailableReason: null,
      });
    },
  );
  await setupPage({
    context,
    host: "app.okou.ai",
    path: rollout ? "/?settings=my-okou" : "/?settings=preference",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: rollout },
  });
  return await screen.findByRole("region", { name: "Proactive" });
}

test("proactive-learning-settings-001 My Okou offers Morning brief before Suggestions and keeps them independent", async () => {
  const region = await settings(true);
  expect(screen.getByRole("heading", { name: "My Okou" })).toBeInTheDocument();
  const morning = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  const suggestions = await within(region).findByRole("switch", {
    name: "Suggestions",
  });
  expect(
    morning.compareDocumentPosition(suggestions) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(morning).not.toBeChecked();
  expect(suggestions).not.toBeChecked();
  click(suggestions);
  await waitFor(() => {
    expect(suggestions).toBeChecked();
    expect(suggestions).toBeEnabled();
  });
  expect(morning).not.toBeChecked();
});
test("proactive-learning-settings-002 Morning brief stays available outside the Suggestions rollout", async () => {
  const region = await settings(false);
  const morning = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  await waitFor(() => {
    expect(morning).toBeEnabled();
  });
  expect(within(region).getAllByRole("switch")).toStrictEqual([morning]);
});

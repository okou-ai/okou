import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function settings() {
  let active = false;
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
    path: "/?settings=my-okou",
  });
  return await screen.findByRole("region", { name: "Proactive" });
}

test("proactive-learning-settings-001 My Okou offers Morning brief before Suggestions and keeps them independent", async () => {
  const region = await settings();
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

test("proactive-suggestions-settings-001 the member can opt in and save an explicit opt-out independently", async () => {
  const region = await settings();
  const toggle = await within(region).findByRole("switch", {
    name: "Suggestions",
  });
  const brief = await within(region).findByRole("switch", {
    name: "Morning brief",
  });
  await waitFor(() => {
    expect(toggle).toBeEnabled();
  });
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
  });
  expect(brief).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
  });
  expect(brief).not.toBeChecked();
});

import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  consentFragment,
  harbor,
  statusService,
} from "./discord-consent-fixtures.ts";

const context = testContext();
const incomplete = Object.freeze({
  needsOnboarding: true,
  onboardingComplete: false,
  isAdmin: true,
  hasOrg: true,
});
const onboardingPrompt = "Onboarding prompt";

test.each([
  ["integration-onboarding-001", "/works?discord=pending" + consentFragment],
  ["integration-onboarding-007", "/settings/discord?status=pending"],
] as const)(
  "%s keeps the interrupted callback on Discord settings for an unfinished workspace",
  async (_id, path) => {
    context.mocks.data.onboardingStatus(incomplete);
    statusService(context, () => {
      return {};
    });
    await setupPage({ context, path, auth: harbor.auth });
    await expect(
      screen.findByText("This authorization was interrupted or refreshed."),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Connection failed")).toBeInTheDocument();
    await expect(
      findAction("link", "Back to settings"),
    ).resolves.toHaveAttribute("href", "/works");
    expect(location.pathname).toBe("/settings/discord");
    expect(location.hash).toBe("");
    expect(screen.queryByLabelText(onboardingPrompt)).toBeNull();
  },
);

test("integration-onboarding-004 a browser navigation to the legacy callback takes precedence over pending onboarding", async () => {
  const lookup = context.mocks.deferred<void>();
  const answer = context.mocks.deferred<void>();
  context.mocks.api(onboardingStatusContract.getStatus, async ({ respond }) => {
    if (!lookup.settled()) {
      lookup.resolve();
    }
    await answer.promise;
    return respond(200, incomplete);
  });
  statusService(context, () => {
    return {};
  });
  const page = await startPage({ context, path: "/works", auth: harbor.auth });
  await lookup.promise;
  history.pushState(null, "", "/works?discord=pending");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await expect(
    screen.findByText("This authorization was interrupted or refreshed."),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/settings/discord");
  answer.resolve();
  await page.ready;
  expect(location.pathname).toBe("/settings/discord");
  expect(screen.queryByLabelText(onboardingPrompt)).toBeNull();
});

test("integration-onboarding-005 an unrelated Works prompt enters the unfinished workspace onboarding", async () => {
  context.mocks.data.onboardingStatus(incomplete);
  await setupPage({
    context,
    path: "/works?prompt=choose+an+output",
    auth: harbor.auth,
  });
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding");
  });
  await expect(screen.findByLabelText(onboardingPrompt)).resolves.toHaveValue(
    "choose an output",
  );
});

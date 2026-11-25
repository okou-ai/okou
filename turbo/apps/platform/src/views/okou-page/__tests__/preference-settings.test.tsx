import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  morningBriefPreferenceContract,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
async function openBrief(status: "preparing" | "error") {
  let preference: MorningBriefPreferenceResponse = {
    enabled: true,
    status,
    unavailableReason: null,
  };
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(morningBriefPreferenceContract.retry, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    ({ body, respond }) => {
      preference = {
        enabled: body.enabled,
        status: body.enabled ? "preparing" : "paused",
        unavailableReason: null,
      };
      return respond(200, preference);
    },
  );
  await setupPage({
    context,
    path: "/?settings=preference",
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: false },
  });
  return screen.findByRole("switch", { name: /morning brief/i });
}
test("preference-settings-001 the member can disable an enabled Morning Brief while its schedule is unavailable", async () => {
  const toggle = await openBrief("error");
  await expect(
    screen.findByText("Temporarily unavailable."),
  ).resolves.toBeVisible();
  expect(toggle).toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
});
test("preference-settings-007 preparing Morning Brief supports cancellation and re-enrollment", async () => {
  const toggle = await openBrief("preparing");
  const message =
    "Preparing your first Morning Brief. You can turn it off at any time.";
  await expect(screen.findByText(message)).resolves.toBeVisible();
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  click(toggle);
  await expect(screen.findByText(message)).resolves.toBeVisible();
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
});
test("preference-settings-002 the legacy settings link opens Preference on Home", async () => {
  await setupPage({ context, path: "/settings" });
  await expect(screen.findByText("Account & security")).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("?settings=preference");
});
test("Upstream Home redirect for the legacy model tab opens both subscription providers in Unified Settings", async () => {
  await setupPage({ context, path: "/settings?tab=model-configuration" });
  await waitFor(() => {
    expect(location.pathname).toBe("/");
    expect(
      screen.getByRole("heading", { name: "Use more models" }),
    ).toBeVisible();
  });
  expect(screen.getByText("Claude", { exact: true })).toBeVisible();
  expect(screen.getByText("ChatGPT (Codex)", { exact: true })).toBeVisible();
  expect(location.search).toBe("?settings=model");
  expect(location.pathname).toBe("/");
});

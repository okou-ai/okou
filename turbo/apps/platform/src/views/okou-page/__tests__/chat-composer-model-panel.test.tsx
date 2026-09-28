import {
  type OrgModelPolicy,
  type SupportedRunModel,
  getBuiltInConcreteProviderType,
  getCanonicalModelDisplayName,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  context,
  findButton,
  installRunChat,
  NEW_CHAT_PATH,
} from "./chat-run-test-fixtures.ts";
import { fillComposer } from "./chat-test-helpers.ts";

const POLICY_DATE = "2026-09-28T09:00:00.000Z";

function configurePolicies(models: readonly SupportedRunModel[]): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index): OrgModelPolicy => {
      return {
        id: `e1000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
        model,
        modelLabel: getCanonicalModelDisplayName(model),
        isDefault: index === 0,
        defaultProviderType: "built-in",
        runtimeProviderType: getBuiltInConcreteProviderType(model),
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: null,
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: POLICY_DATE,
        updatedAt: POLICY_DATE,
      };
    }),
  );
}

async function openPanel(triggerName: string): Promise<HTMLElement> {
  click(await findButton(triggerName));
  return await screen.findByRole("dialog", { name: "Chat models" });
}

async function setupPanel(
  models: readonly SupportedRunModel[],
  onThreadCreate?: Parameters<typeof installRunChat>[0] extends infer O
    ? O extends { onThreadCreate?: infer F }
      ? F
      : never
    : never,
): Promise<HTMLElement> {
  installRunChat({
    selectedModel: models[0],
    ...(onThreadCreate ? { onThreadCreate } : {}),
  });
  configurePolicies(models);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.ComposerModelPanel]: true,
    },
  });
  return await screen.findByRole("textbox", { name: "Message" });
}

test("Pick only chat models, with effort and Fast in the same panel", async () => {
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);
  const panel = await openPanel("GPT 5.6 Sol, Max");
  const models = within(panel).getByRole("radiogroup", {
    name: "Chat models",
  });
  expect(
    within(models).getByRole("radio", { name: /GPT 5.6 Sol/ }),
  ).toBeChecked();
  expect(
    within(models).getByRole("radio", { name: /Claude Sonnet 5/ }),
  ).not.toBeChecked();
  // The panel switches the chat model only: no media categories and no
  // separate effort control beside it.
  expect(within(panel).queryByText("Image")).toBeNull();
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Effort, ");
    }),
  ).toBeFalsy();
  expect(within(panel).getByRole("slider", { name: "Effort" })).toBeVisible();
  expect(within(panel).getByRole("switch", { name: "Fast" })).toBeVisible();
});

test("Keep the panel open while changing effort, Fast and model", async () => {
  const user = userEvent.setup({ delay: null });
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);
  const panel = await openPanel("GPT 5.6 Sol, Max");

  const slider = within(panel).getByRole("slider", { name: "Effort" });
  slider.focus();
  await user.keyboard("{Home}");
  await expect(findButton("GPT 5.6 Sol, Low")).resolves.toBeVisible();
  expect(panel).toBeVisible();

  click(within(panel).getByRole("switch", { name: "Fast" }));
  await expect(findButton("GPT 5.6 Sol, Low, Fast")).resolves.toBeVisible();
  expect(panel).toBeVisible();

  click(within(panel).getByRole("radio", { name: /Claude Sonnet 5/ }));
  await waitFor(() => {
    expect(
      within(panel).getByRole("radio", { name: /Claude Sonnet 5/ }),
    ).toBeChecked();
  });
  expect(panel).toBeVisible();
  // Effort follows the checked model; Fast is not offered for it.
  expect(within(panel).getByRole("slider", { name: "Effort" })).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  expect(within(panel).queryByRole("switch", { name: "Fast" })).toBeNull();
});

test("Send with the model and effort chosen in the panel", async () => {
  const user = userEvent.setup({ delay: null });
  const creates: { model?: SupportedRunModel; reasoningEffort?: string }[] = [];
  const composer = await setupPanel(
    ["gpt-5.6-sol", "claude-sonnet-5"],
    (body) => {
      creates.push(body);
    },
  );
  const panel = await openPanel("GPT 5.6 Sol, Max");
  click(within(panel).getByRole("radio", { name: /Claude Sonnet 5/ }));
  await expect(findButton("Claude Sonnet 5, High")).resolves.toBeVisible();
  within(panel).getByRole("slider", { name: "Effort" }).focus();
  await user.keyboard("{Home}");
  await expect(findButton("Claude Sonnet 5, Low")).resolves.toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Chat models" })).toBeNull();
  });
  await user.click(composer);
  await fillComposer(composer, "Run this on Sonnet");
  click(await findButton("Send"));
  await waitFor(() => {
    expect(creates).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-5",
        reasoningEffort: "low",
      }),
    );
  });
});

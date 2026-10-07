import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  mockCatalogBuiltInProvider,
  mockCatalogDisplayName,
} from "../../../mocks/handlers/api-model-catalog.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

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
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { fillComposer } from "./chat-test-helpers.ts";

function configureRunModels(models: readonly string[]): void {
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    models.map((model): AvailableRunModel => {
      return {
        model,
        modelLabel: mockCatalogDisplayName(model),
        defaultProviderType:
          model === "okou-1.0"
            ? "built-in"
            : model.startsWith("claude-")
              ? "claude-code-oauth-token"
              : "codex-oauth-token",
        runtimeProviderType:
          model === "okou-1.0"
            ? "openrouter-codex"
            : model.startsWith("claude-")
              ? "claude-code-oauth-token"
              : "codex-oauth-token",
        credentialScope: model === "okou-1.0" ? "org" : "member",
        modelProviderId: null,
        routeStatus: "valid",
      };
    }),
  );
}

async function setupPanel(
  models: readonly string[],
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
  configureRunModels(models);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  return await screen.findByRole("textbox", { name: "Message" });
}

/** The trigger names the model, optionally followed by its effort. */
function hasAutoModelTrigger(): boolean {
  const name = /^Auto(,|$)/;
  return queryAllByRoleFast("button").some((button) => {
    return (
      name.test(button.getAttribute("aria-label") ?? "") ||
      name.test(button.textContent?.trim() ?? "")
    );
  });
}

async function setupAutoComposer(subscriptionModel?: string): Promise<void> {
  installRunChat({ selectedModel: "okou-1.0" });
  if (subscriptionModel) {
    installConnectedPersonalSubscriptions(context);
  }
  const auto = autoPolicy();
  context.mocks.data.availableRunModels(
    subscriptionModel
      ? [
          auto,
          {
            ...auto,
            model: subscriptionModel,
            modelLabel: mockCatalogDisplayName(subscriptionModel),
            defaultProviderType: "codex-oauth-token",
            runtimeProviderType: "codex-oauth-token",
            credentialScope: "member",
            subscriptionOptions: {
              efforts: ["low", "high"],
              serviceTier: null,
            },
          },
        ]
      : [auto],
  );

  await setupPage({
    context,
    path: NEW_CHAT_PATH,
  });
  await screen.findByRole("textbox", { name: "Message" });
}

function autoPolicy(): AvailableRunModel {
  return {
    model: "okou-1.0",
    modelLabel: mockCatalogDisplayName("okou-1.0"),
    defaultProviderType: "built-in",
    runtimeProviderType: mockCatalogBuiltInProvider("okou-1.0"),
    credentialScope: "org",
    modelProviderId: null,
    routeStatus: "valid",
  };
}

test("Auto hides the model picker until a subscription adds models", async () => {
  await setupAutoComposer();
  await findButton("Attach");
  expect(hasAutoModelTrigger()).toBeFalsy();
});

test("Auto shows the model picker once a subscription adds models", async () => {
  await setupAutoComposer("gpt-6-sol");
  await waitFor(() => {
    expect(hasAutoModelTrigger()).toBeTruthy();
  });
});

test("Choose a connected subscription model and return to Auto", async () => {
  await setupAutoComposer("gpt-6-sol");
  await waitFor(() => {
    expect(hasAutoModelTrigger()).toBeTruthy();
  });
  const panel = await openModelPanel("Auto");
  const user = userEvent.setup({ delay: null });
  await user.click(modelOption(/^GPT 6 Sol/u, panel));
  await waitFor(() => {
    expect(modelOption(/^GPT 6 Sol/u, panel)).toBeChecked();
  });
  await user.click(modelOption(/^Auto/u, panel));
  await waitFor(() => {
    expect(modelOption(/^Auto/u, panel)).toBeChecked();
  });
});

test("Pick only chat models, with effort and Fast in the same panel", async () => {
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const models = within(panel).getByRole("radiogroup", {
    name: "Chat models",
  });
  expect(modelOption(/^GPT 5\.6 Sol/u, models)).toBeChecked();
  expect(modelOption(/^Claude Sonnet 5/u, models)).not.toBeChecked();
  expect(
    within(panel).getByRole("slider", { name: "Effort" }),
  ).toBeInTheDocument();
  // The trigger already names the level, so the panel does not repeat it above
  // the bar.
  expect(within(panel).queryByText("Max")).toBeNull();
  expect(within(panel).getByText("Lower usage")).toBeVisible();
  expect(within(panel).getByText("Higher usage")).toBeVisible();
  expect(
    within(panel).getByText("2.5× subscription usage"),
  ).toBeInTheDocument();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toHaveAccessibleDescription("2.5× subscription usage");
  // Only the model list scrolls; effort and Fast stay pinned below it.
  const viewport = models.closest('[data-slot="scroll-area-viewport"]');
  expect(viewport).not.toBeNull();
  expect(viewport).not.toContainElement(
    within(panel).getByRole("slider", { name: "Effort" }),
  );
});

test("Keep the panel open while changing effort, Fast and model", async () => {
  const user = userEvent.setup({ delay: null });
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);
  const panel = await openModelPanel("GPT 5.6 Sol, Max");

  const slider = within(panel).getByRole("slider", { name: "Effort" });
  slider.focus();
  await user.keyboard("{Home}");
  await expect(findButton("GPT 5.6 Sol, Low")).resolves.toBeInTheDocument();
  expect(panel).toBeVisible();

  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await expect(
    findButton("GPT 5.6 Sol, Low, Fast"),
  ).resolves.toBeInTheDocument();
  expect(panel).toBeVisible();

  click(modelOption(/^Claude Sonnet 5/u, panel));
  await waitFor(() => {
    expect(modelOption(/^Claude Sonnet 5/u, panel)).toBeChecked();
  });
  expect(panel).toBeVisible();
  // Effort follows the checked model; Fast is not offered for it.
  expect(within(panel).getByRole("slider", { name: "Effort" })).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  expect(within(panel).queryByRole("switch", { name: "Fast mode" })).toBeNull();
});

test("Send with the model and effort chosen in the panel", async () => {
  const user = userEvent.setup({ delay: null });
  const creates: {
    model?: string;
    reasoningEffort?: string;
  }[] = [];
  const composer = await setupPanel(
    ["gpt-5.6-sol", "claude-sonnet-5"],
    (body) => {
      creates.push(body);
    },
  );
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  click(modelOption(/^Claude Sonnet 5/u, panel));
  await expect(
    findButton("Claude Sonnet 5, High"),
  ).resolves.toBeInTheDocument();
  within(panel).getByRole("slider", { name: "Effort" }).focus();
  await user.keyboard("{Home}");
  await expect(findButton("Claude Sonnet 5, Low")).resolves.toBeInTheDocument();
  await closeModelPanel();
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

test("Name the model and its effort on the trigger, with a bolt for Fast", async () => {
  await setupPanel(["gpt-5.6-sol"]);
  const trigger = await findButton("GPT 5.6 Sol, Max");
  expect(trigger).toHaveTextContent(/^GPT 5\.6 Sol\s*· Max$/u);
  // The bolt is the Fast state rather than decoration.
  expect(trigger.querySelector("svg.lucide-zap")).toBeNull();
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  const fastTrigger = await findButton("GPT 5.6 Sol, Max, Fast");
  expect(fastTrigger).toHaveTextContent(/^GPT 5\.6 Sol\s*· Max$/u);
  expect(fastTrigger.querySelector("svg.lucide-zap")).toBeInTheDocument();
});

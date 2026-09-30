import {
  mockCatalogBuiltInProvider,
  mockCatalogDisplayName,
} from "../../../mocks/handlers/api-model-catalog.ts";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
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

function configurePolicies(
  models: readonly string[],
  directAstra = false,
): void {
  context.mocks.data.orgModelPolicies(
    models.map((model, index): OrgModelPolicy => {
      return {
        id: `e1000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
        model,
        modelLabel: mockCatalogDisplayName(model),
        defaultProviderType:
          directAstra && model === "gpt-6-astra"
            ? "openai-api-key"
            : "built-in",
        runtimeProviderType:
          directAstra && model === "gpt-6-astra"
            ? "openai-api-key"
            : mockCatalogBuiltInProvider(model),
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

/** A model row, matched by the model name its label starts with. */
function modelRadio(container: HTMLElement, model: string): HTMLElement {
  const radio = queryAllByRoleFast("radio", container).find((candidate) => {
    return candidate.textContent?.trim().startsWith(model);
  });
  if (!radio) {
    throw new Error(`Model ${model} was not listed`);
  }
  return radio;
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
  const auto = autoPolicy();
  context.mocks.data.orgModelPolicies(
    subscriptionModel
      ? [
          auto,
          {
            ...auto,
            id: "e1000000-0000-4000-a000-000000000099",
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
  context.mocks.data.orgModelMode("auto");
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.ComposerModelPanel]: true,
    },
  });
  await screen.findByRole("textbox", { name: "Message" });
}

function autoPolicy(): OrgModelPolicy {
  return {
    id: "e1000000-0000-4000-a000-000000000001",
    model: "okou-1.0",
    modelLabel: mockCatalogDisplayName("okou-1.0"),
    defaultProviderType: "built-in",
    runtimeProviderType: mockCatalogBuiltInProvider("okou-1.0"),
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: POLICY_DATE,
    updatedAt: POLICY_DATE,
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

test("Ultrafast is absent for built-in Astra", async () => {
  await setupPanel(["gpt-6-astra"]);
  const panel = await openPanel("GPT 6 Astra, Max");
  expect(
    within(panel).queryByRole("switch", { name: "Ultrafast mode" }),
  ).toBeNull();
});

test("Direct OpenAI Astra hides Ultrafast and sends Standard", async () => {
  const creates: { serviceTier?: string | null }[] = [];
  installRunChat({
    selectedModel: "gpt-6-astra",
    onThreadCreate: (body) => {
      creates.push(body);
    },
  });
  configurePolicies(["gpt-6-astra"], true);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: {
      [FeatureSwitchKey.ChatPreference]: true,
      [FeatureSwitchKey.ComposerModelPanel]: true,
    },
  });
  await screen.findByRole("textbox", { name: "Message" });
  const panel = await openPanel("GPT 6 Astra, Max");
  expect(
    within(panel).queryByRole("switch", { name: "Ultrafast mode" }),
  ).toBeNull();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).not.toBeChecked();
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Run this on Astra Standard");
  click(await findButton("Send"));
  await waitFor(() => {
    expect(creates).toContainEqual(
      expect.objectContaining({
        model: "gpt-6-astra",
        serviceTier: null,
      }),
    );
  });
});

test("Pick only chat models, with effort and Fast in the same panel", async () => {
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);
  const panel = await openPanel("GPT 5.6 Sol, Max");
  const models = within(panel).getByRole("radiogroup", {
    name: "Chat models",
  });
  expect(modelRadio(models, "GPT 5.6 Sol")).toBeChecked();
  expect(modelRadio(models, "Claude Sonnet 5")).not.toBeChecked();
  // Effort lives inside the panel, not as a separate control beside it.
  expect(
    queryAllByRoleFast("button").some((button) => {
      return button.getAttribute("aria-label")?.startsWith("Effort, ");
    }),
  ).toBeFalsy();
  expect(
    within(panel).getByRole("slider", { name: "Effort" }),
  ).toBeInTheDocument();
  // The trigger already names the level, so the panel does not repeat it above
  // the bar.
  expect(within(panel).queryByText("Max")).toBeNull();
  expect(within(panel).getByText("Fewer credits")).toBeVisible();
  expect(within(panel).getByText("More credits")).toBeVisible();
  expect(within(panel).getByText("2× credit cost")).toBeInTheDocument();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toHaveAccessibleDescription("2× credit cost");
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
  const panel = await openPanel("GPT 5.6 Sol, Max");

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

  click(modelRadio(panel, "Claude Sonnet 5"));
  await waitFor(() => {
    expect(modelRadio(panel, "Claude Sonnet 5")).toBeChecked();
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
  const panel = await openPanel("GPT 5.6 Sol, Max");
  click(modelRadio(panel, "Claude Sonnet 5"));
  await expect(
    findButton("Claude Sonnet 5, High"),
  ).resolves.toBeInTheDocument();
  within(panel).getByRole("slider", { name: "Effort" }).focus();
  await user.keyboard("{Home}");
  await expect(findButton("Claude Sonnet 5, Low")).resolves.toBeInTheDocument();
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

test("Name the model and its effort on the trigger, with a bolt for Fast", async () => {
  await setupPanel(["gpt-5.6-sol"]);
  const trigger = await findButton("GPT 5.6 Sol, Max");
  expect(trigger).toHaveTextContent(/^GPT 5\.6 Sol\s*· Max$/u);
  // The bolt is the Fast state rather than decoration.
  expect(trigger.querySelector("svg.lucide-zap")).toBeNull();
  const panel = await openPanel("GPT 5.6 Sol, Max");
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  const fastTrigger = await findButton("GPT 5.6 Sol, Max, Fast");
  expect(fastTrigger).toHaveTextContent(/^GPT 5\.6 Sol\s*· Max$/u);
  expect(fastTrigger.querySelector("svg.lucide-zap")).toBeInTheDocument();
});

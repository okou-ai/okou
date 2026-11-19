import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { buildProvider, buildRunModel } from "./chat-model-builders.ts";
import {
  closeModelPanel,
  modelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import {
  NEW_CHAT_PATH,
  createChatRunFixtures,
  findButton,
} from "./chat-run-test-fixtures.ts";
import { installConnectedPersonalSubscriptions } from "./personal-subscription-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

async function setupPanel(models: readonly string[]): Promise<void> {
  installRunChat({ selectedModel: models[0] });
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels(
    models.map((model) => {
      return buildRunModel({ model });
    }),
  );
  await setupPage({ context, path: NEW_CHAT_PATH });
  await screen.findByRole("textbox", { name: "Message" });
}

test("Show the final model groups before subscription usage resolves", async () => {
  const usage = context.mocks.deferred<void>();
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond, withSignal }) => {
      await withSignal(usage.promise);
      return respond(200, {
        subscriptions: [
          buildProvider({
            id: "e8000000-0000-4000-a000-000000000001",
            type: "codex-oauth-token",
            framework: "codex",
            isActive: true,
            subscriptionUsage: {
              fiveHour: null,
              weekly: {
                usedPercent: 12,
                remainingPercent: 88,
                resetAt: "2026-10-26T00:00:00Z",
                windowSeconds: 604_800,
              },
            },
          }),
        ],
      });
    },
  );
  installRunChat({ selectedModel: null });
  context.mocks.data.availableRunModels([
    buildRunModel({ model: "gpt-6-astra", providerType: "codex-oauth-token" }),
  ]);
  await setupPage({
    context,
    path: NEW_CHAT_PATH,
    featureSwitches: { [FeatureSwitchKey.SubscriptionLinkingEntry]: true },
  });
  await screen.findByRole("textbox", { name: "Message" });

  const panel = await openModelPanel("Auto");
  expect(modelOption(/^GPT 6 Astra/u, panel)).toBeInTheDocument();
  const chatGptPlan = within(panel).getByText("Your ChatGPT plan");
  expect(chatGptPlan).toBeVisible();
  expect(within(panel).getByText("Your Claude plan")).toBeVisible();
  expect(within(panel).getByText("Connect")).toBeVisible();
  expect(within(panel).getByText("Manage plans")).toBeVisible();
  expect(within(panel).getByLabelText("Loading")).toBeVisible();
  const options = within(panel).getAllByRole("radio");

  usage.resolve();

  await expect(within(panel).findByText("88% left")).resolves.toBeVisible();
  expect(within(panel).getByText("Your ChatGPT plan")).toBe(chatGptPlan);
  expect(within(panel).getAllByRole("radio")).toStrictEqual(options);
  expect(within(panel).queryByLabelText("Loading")).not.toBeInTheDocument();
});

test("Pick only chat models, with effort and Fast in the same panel", async () => {
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);

  const panel = await openModelPanel("GPT 5.6 Sol, Max");

  const models = within(panel).getByRole("radiogroup", {
    name: "Chat models",
  });
  expect(modelOption(/^GPT 5\.6 Sol/u, models)).toBeEnabled();
  expect(modelOption(/^Claude Sonnet 5/u, models)).toBeEnabled();
  const effort = within(panel).getByRole("slider", { name: "Effort" });
  expect(within(panel).getByText("Lower usage")).toBeVisible();
  expect(within(panel).getByText("Higher usage")).toBeVisible();
  expect(within(panel).getByText("2.5× subscription usage")).toBeVisible();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toHaveAccessibleDescription("2.5× subscription usage");
  const viewport = models.closest('[data-slot="scroll-area-viewport"]');
  expect(viewport).not.toBeNull();
  expect(viewport).not.toContainElement(effort);
});

test("Keep the panel open while changing effort, Fast and model", async () => {
  const user = userEvent.setup({ delay: null });
  await setupPanel(["gpt-5.6-sol", "claude-sonnet-5"]);
  const panel = await openModelPanel("GPT 5.6 Sol, Max");

  within(panel).getByRole("slider", { name: "Effort" }).focus();
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
  expect(within(panel).getByRole("slider", { name: "Effort" })).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  expect(within(panel).queryByRole("switch", { name: "Fast mode" })).toBeNull();
});

test("Keep the model panel usable as the temporary model notice appears and clears", async () => {
  const user = userEvent.setup({ delay: null });
  await setupPanel(["gpt-6-astra", "gpt-6.1-sol"]);
  const panel = await openModelPanel("GPT 6 Astra, Max");
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();

  await user.click(modelOption(/^GPT 6\.1 Sol/u, panel));
  await expect(findButton("GPT 6.1 Sol, Max")).resolves.toBeInTheDocument();
  const notice = await screen.findByRole("group", {
    name: "Model for this chat",
  });
  expect(notice).toHaveTextContent("Temporarily switch to GPT 6.1 Sol");
  expect(panel).toBeVisible();
  expect(within(panel).getByRole("slider", { name: "Effort" })).toBeEnabled();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeEnabled();

  await user.click(modelOption(/^GPT 6 Astra/u, panel));
  await expect(findButton("GPT 6 Astra, Max")).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Model for this chat" }),
  ).not.toBeInTheDocument();
  expect(modelOption(/^GPT 6 Astra/u, panel)).toBeChecked();
  expect(panel).toBeVisible();

  await closeModelPanel();
  await expect(findButton("GPT 6 Astra, Max")).resolves.toHaveFocus();
});

test("Select Ultrafast in the composer for a Codex model that offers it", async () => {
  installRunChat({ selectedModel: "gpt-6.1-sol" });
  installConnectedPersonalSubscriptions(context);
  context.mocks.data.availableRunModels([
    {
      ...buildRunModel({ model: "gpt-6.1-sol" }),
      subscriptionOptions: {
        efforts: ["low", "high"],
        serviceTier: "priority",
        ultrafastAvailable: true,
      },
    },
  ]);
  await setupPage({ context, path: NEW_CHAT_PATH });
  const panel = await openModelPanel("GPT 6.1 Sol");
  const speeds = within(panel).getByRole("radiogroup", { name: "Speed" });
  expect(
    within(speeds).getByRole("radio", { name: "Standard" }),
  ).toBeInTheDocument();
  expect(
    within(speeds).getByRole("radio", { name: "Fast" }),
  ).toBeInTheDocument();

  click(within(speeds).getByRole("radio", { name: "Ultrafast" }));

  await waitFor(() => {
    expect(
      within(speeds).getByRole("radio", { name: "Ultrafast" }),
    ).toBeChecked();
  });
  expect(
    within(panel).getByText("Uses more of your Codex allowance."),
  ).toBeVisible();
});

import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  closeModelPanel,
  findModelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";

const context = testContext();

const sol = "gpt-5.6-sol",
  sonnet = "claude-sonnet-5";
test("chat-composer-model-panel-005 the scrolling model list leaves the effort and usage controls outside it", async () => {
  accountModels(context, [sol, sonnet], sol);
  await setupPage({ context, path: "/" });
  const panel = await openModelPanel("GPT 5.6 Sol");
  const list = within(panel).getByRole("radiogroup", { name: "Chat models" });
  for (const label of ["GPT 5.6 Sol", "Claude Sonnet 5"]) {
    await expect(findModelOption(label, list)).resolves.toBeEnabled();
  }
  const viewport = list.closest('[data-slot="scroll-area-viewport"]');
  expect(viewport).toContainElement(list);
  expect(viewport).not.toContainElement(
    within(panel).getByRole("slider", { name: "Effort" }),
  );
  for (const label of [
    "Lower usage",
    "Higher usage",
    "2.5× subscription usage",
  ]) {
    expect(within(panel).getByText(label)).toBeInTheDocument();
  }
});
test("chat-composer-model-panel-006 lowering effort, enabling Fast and choosing Claude keeps the model panel open", async () => {
  accountModels(context, [sol, sonnet], sol, { [sol]: { effort: "max" } });
  await setupPage({ context, path: "/" });
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const controls = within(panel);
  const effort = controls.getByRole("slider");
  effort.focus();
  await userEvent.keyboard("{Home}");
  await composerModelTrigger("GPT 5.6 Sol, Low");
  click(controls.getByRole("switch", { name: "Fast mode" }));
  await composerModelTrigger("GPT 5.6 Sol, Low, Fast");
  click(await findModelOption("Claude Sonnet 5", panel));
  await composerModelTrigger("Claude Sonnet 5, High");
  expect(controls.getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "High",
  );
  expect(controls.queryByRole("switch", { name: "Fast mode" })).toBeNull();
  expect(panel).toBeInTheDocument();
});
test("chat-composer-model-panel-007 returning to the default model removes its temporary notice", async () => {
  accountModels(context, ["gpt-6-astra", "gpt-6.1-sol"], "gpt-6-astra");
  await setupPage({ context, path: "/" });
  const panel = await openModelPanel("GPT 6 Astra");
  const future = () => {
    return screen.queryByText("Use this for future chats");
  };
  expect(future()).toBeNull();
  click(await findModelOption("GPT 6.1 Sol", panel));
  await screen.findByText("Use this for future chats");
  expect(within(panel).getByRole("slider")).toBeEnabled();
  expect(
    within(panel).getByRole("switch", { name: "Fast mode" }),
  ).toBeEnabled();
  const original = await findModelOption("GPT 6 Astra", panel);
  click(original);
  await waitFor(() => {
    expect(original).toBeChecked();
    expect(future()).toBeNull();
  });
  await closeModelPanel();
  await expect(composerModelTrigger("GPT 6 Astra")).resolves.toHaveFocus();
});
test("chat-composer-model-panel-010 selecting Ultrafast shows its Codex allowance impact", async () => {
  const { rows } = accountModels(context, ["gpt-6.1-sol"], "gpt-6.1-sol");
  context.mocks.data.availableRunModels(
    rows.map((row) => {
      return {
        ...row,
        subscriptionOptions: {
          ...row.subscriptionOptions!,
          ultrafastAvailable: true,
        },
      };
    }),
  );
  await setupPage({
    context,
    path: "/",
    featureSwitches: {
      [FeatureSwitchKey.CodexSubscriptionUltrafast]: true,
      [FeatureSwitchKey.CodexExecution]: true,
    },
  });
  const panel = await openModelPanel("GPT 6.1 Sol");
  const ui = within(panel);
  for (const name of ["Standard", "Fast", "Ultrafast"]) {
    expect(ui.getByText(name)).toBeInTheDocument();
  }
  click(ui.getByText("Ultrafast"));
  await ui.findByText("Uses more of your Codex allowance.");
  await expect(
    findFastControl("radio", "Ultrafast", panel),
  ).resolves.toBeChecked();
});

test("chat-composer-model-panel-003 the plan groups and available models remain present while the quota arrives", async () => {
  const { codex } = accountModels(context, ["gpt-6-astra"], null);
  const gate = context.mocks.deferred<void>();
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      await gate.promise;
      return respond(200, {
        subscriptions: [
          {
            ...codex,
            subscriptionUsage: {
              weekly: null,
              fiveHour: {
                remainingPercent: 88,
                usedPercent: 12,
                resetAt: null,
                windowSeconds: 18_000,
              },
            },
          },
        ],
      });
    },
  );
  await setupPage({
    context,
    path: "/",
    featureSwitches: { [FeatureSwitchKey.SubscriptionLinkingEntry]: true },
  });
  const panel = await openModelPanel("Auto");
  const ui = within(panel);
  const quota = ui.getAllByLabelText("Loading");
  const plan = ui.getByText(/ChatGPT plan/i);
  await findModelOption("GPT 6 Astra", panel);
  expect(ui.getByText(/Claude plan/i)).toBeInTheDocument();
  expect(ui.getByText("Connect")).toBeInTheDocument();
  expect(ui.getByText("Manage plans")).toBeInTheDocument();
  gate.resolve();
  await ui.findByText("88% left");
  expect(plan).toBeInTheDocument();
  await findModelOption("GPT 6 Astra", panel);
  expect(
    quota.every((el) => {
      return !el.isConnected;
    }),
  ).toBeTruthy();
});

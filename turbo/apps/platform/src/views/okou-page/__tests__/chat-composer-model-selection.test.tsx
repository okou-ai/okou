import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import {
  composerModelTrigger,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  closeModelPanel,
  findModelOption,
  openModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const sol = "gpt-5.6-sol",
  luna = "gpt-5.6-luna",
  sonnet = "claude-sonnet-5";
test("chat-composer-model-selection-002 remote preference changes can include a new preference kind", async () => {
  const fable = "claude-fable-5-1",
    opus = "claude-opus-5-5";
  accountModels(context, [fable, opus], fable);
  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Fable 5.1");
  context.mocks.data.userModelPreference({
    selectedModel: opus,
    modelSettings: {},
    selectedImageModel: null,
    serviceTier: null,
    updatedAt: null,
  });
  context.mocks.ably.trigger("userPreferenceChanged", {
    kinds: ["defaultModel", "futurePreference"],
  });
  await expect(
    composerModelTrigger("Claude Opus 5.5"),
  ).resolves.toBeInTheDocument();
});
test("chat-composer-model-selection-003 reselecting Luna preserves Fast and xHigh effort", async () => {
  accountModels(context, [sol, luna], sol);
  await setupPage({ context, path: "/" });
  const panel = await openModelPanel("GPT 5.6 Sol");
  const option = await findModelOption("GPT 5.6 Luna", panel);
  click(option);
  await composerModelTrigger("GPT 5.6 Luna");
  const fast = within(panel).getByRole("switch", { name: "Fast mode" });
  expect(
    within(panel).getByText("2.5× subscription usage"),
  ).toBeInTheDocument();
  click(fast);
  await composerModelTrigger("GPT 5.6 Luna, xHigh, Fast");
  click(option);
  expect(fast).toBeChecked();
  expect(within(panel).getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "xHigh",
  );
});
test("chat-composer-model-selection-004 every effort step can be selected before creating a priority Max chat", async () => {
  const created = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    onThreadCreate: (b) => {
      return created.resolve(b);
    },
  });
  accountModels(context, [sol], sol, { [sol]: { effort: "max" } });
  await setupPage({ context, path: "/" });
  await fill(await findComposerEditor(), "Prepare a release note");
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  const slider = within(panel).getByRole("slider");
  slider.focus();
  for (const [key, value] of [
    ["Home", "Low"],
    ["ArrowRight", "Medium"],
    ["ArrowRight", "High"],
    ["ArrowRight", "xHigh"],
    ["ArrowRight", "Max"],
  ]) {
    await userEvent.keyboard("{" + key + "}");
    expect(slider).toHaveAttribute("aria-valuetext", value);
  }
  click(within(panel).getByRole("switch", { name: "Fast mode" }));
  await composerModelTrigger("GPT 5.6 Sol, Max, Fast");
  await closeModelPanel();
  click(await findFastControl("button", "Send"));
  await expect(created.promise).resolves.toMatchObject({
    reasoningEffort: "max",
    serviceTier: "priority",
  });
});
test("chat-composer-model-selection-007 switching models restores each model's own effort", async () => {
  accountModels(context, [sol, luna, sonnet], sonnet);
  await setupPage({ context, path: "/" });
  const panel = await openModelPanel("Claude Sonnet 5, High");
  const slider = within(panel).getByRole("slider");
  slider.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(slider).toHaveAttribute("aria-valuetext", "Extra");
  for (const [model, effort] of [
    ["GPT 5.6 Sol", "Max"],
    ["GPT 5.6 Luna", "xHigh"],
    ["Claude Sonnet 5", "Extra"],
  ]) {
    click(await findModelOption(model, panel));
    await composerModelTrigger(model + ", " + effort);
    expect(within(panel).getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      effort,
    );
  }
});
test("chat-composer-model-selection-010 opening the Max fallback leaves the native Ultra preference intact", async () => {
  const updated = context.mocks.deferred<unknown>();
  accountModels(context, [sol], null);
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    selectedModel: sol,
    reasoningEffort: "ultra",
    onModelSelectionUpdate: (b) => {
      return updated.resolve(b);
    },
  });
  const preferenceWrite = context.mocks.deferred<void>();
  context.mocks.api(userModelPreferenceContract.update, ({ respond }) => {
    preferenceWrite.resolve();
    return respond(200, {
      selectedModel: sol,
      modelSettings: { [sol]: { effort: "ultra" } },
      serviceTier: null,
      selectedImageModel: null,
      updatedAt: null,
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.CodexExecution]: false },
  });
  const panel = await openModelPanel("GPT 5.6 Sol, Max");
  expect(within(panel).getByRole("slider")).toHaveAttribute(
    "aria-valuetext",
    "Max",
  );
  expect(updated.settled()).toBeFalsy();
  expect(preferenceWrite.settled()).toBeFalsy();
});
test.each([
  ["001", sonnet, "Claude Sonnet 5", "High", "high"],
  ["011", sol, "GPT 5.6 Sol", "Max", "ultra"],
])(
  "chat-composer-model-selection-%s making the temporary model the default saves its native effort",
  async (_id, model, label, shown, native) => {
    const fable = _id === "011" ? sonnet : "claude-fable-5-1";
    const oldLabel = _id === "011" ? "Claude Sonnet 5" : "Claude Fable 5.1";
    accountModels(context, [fable, model], fable, {
      [sol]: { effort: "ultra" },
    });
    const write = context.mocks.deferred<unknown>();
    context.mocks.api(
      userModelPreferenceContract.update,
      ({ body, respond }) => {
        write.resolve(body);
        const pref = {
          selectedModel: body.selectedModel,
          serviceTier: body.serviceTier,
          modelSettings: { [model]: { effort: native as "high" | "ultra" } },
          selectedImageModel: null,
          updatedAt: null,
        };
        context.mocks.data.userModelPreference(pref);
        return respond(200, pref);
      },
    );
    await setupPage({ context, path: "/" });
    const panel = await openModelPanel(oldLabel);
    click(await findModelOption(label, panel));
    const future = await screen.findByText("Use this for future chats");
    expect(within(panel).getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      shown,
    );
    expect(write.settled()).toBeFalsy();
    click(future);
    await expect(write.promise).resolves.toMatchObject({
      selectedModel: model,
      modelSettingsPatch: { model, effort: native },
    });
    context.mocks.ably.trigger("userPreferenceChanged", {
      kinds: ["defaultModel"],
    });
    await waitFor(() => {
      return expect(screen.queryByText("Use this for future chats")).toBeNull();
    });
    await composerModelTrigger(label);
  },
);

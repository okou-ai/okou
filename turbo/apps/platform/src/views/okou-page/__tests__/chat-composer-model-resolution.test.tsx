import { screen, within } from "@testing-library/react";
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
  queryModelOption,
} from "./chat-model-panel-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const opus = "claude-opus-5",
  sonnet = "claude-sonnet-5";
test("chat-composer-model-resolution-001 choosing Sonnet updates the existing chat picker", async () => {
  accountModels(context, [opus, sonnet], null);
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID, selectedModel: opus });
  await setupPage({ context, path: RUN_PATH });
  const panel = await openModelPanel("Claude Opus 5");
  click(await findModelOption("Claude Sonnet 5", panel));
  await composerModelTrigger("Claude Sonnet 5");
  expect(
    within(panel).queryByRole("group", { name: /model for this chat/i }),
  ).toBeNull();
  await expect(
    findModelOption("Claude Sonnet 5", panel),
  ).resolves.toBeChecked();
});
test("chat-composer-model-resolution-003 an unavailable saved model is repaired to Auto before sending", async () => {
  const repair = context.mocks.deferred<unknown>(),
    sent = context.mocks.deferred<unknown>();
  accountModels(context, ["gpt-6-sol"], null);
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    selectedModel: "deepseek-v4.1-flash",
    onModelSelectionUpdate: (b) => {
      return repair.resolve(b);
    },
    onSendRequest: (b) => {
      return sent.resolve(b);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  const panel = await openModelPanel("Auto");
  await findModelOption("GPT 6 Sol", panel);
  expect(queryModelOption(/DeepSeek/i, panel)).toBeNull();
  await closeModelPanel();
  await fill(await findComposerEditor(), "Review the route");
  click(await findFastControl("button", "Send"));
  await expect(repair.promise).resolves.toMatchObject({ modelSelection: null });
  const send = await sent.promise;
  expect(send).not.toHaveProperty("model", expect.any(String));
  expect(send).not.toHaveProperty("modelSelection.selectedModel");
});
test.each([
  ["004", null],
  ["005", "auto"],
] as const)(
  "chat-composer-model-resolution-%s sending with Auto selected leaves the saved choice alone",
  async (_id, value) => {
    const repair = context.mocks.deferred<unknown>();
    accountModels(context, ["gpt-6-sol"], null);
    mockChatLifecycle(context, {
      threadId: RUN_THREAD_ID,
      selectedModel: value,
      onModelSelectionUpdate: (b) => {
        return repair.resolve(b);
      },
    });
    await setupPage({ context, path: RUN_PATH });
    await composerModelTrigger("Auto");
    await fill(await findComposerEditor(), "Sort these notes");
    click(await findFastControl("button", "Send"));
    await expect(
      screen.findByText("Sort these notes", {
        selector: '[data-role="user"] *',
      }),
    ).resolves.toBeInTheDocument();
    expect(repair.settled()).toBeFalsy();
  },
);
test("chat-composer-model-resolution-007 sending in the existing Opus conversation uses its stored model", async () => {
  const sent = context.mocks.deferred<unknown>();
  accountModels(context, [opus], null);
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    selectedModel: opus,
    onSendRequest: (b) => {
      return sent.resolve(b);
    },
  });
  await setupPage({ context, path: RUN_PATH });
  await composerModelTrigger("Claude Opus 5");
  await fill(await findComposerEditor(), "Summarize the notes");
  click(await findFastControl("button", "Send"));
  const body = await sent.promise;
  expect(body).toHaveProperty("threadId", RUN_THREAD_ID);
  expect(body).not.toHaveProperty("model", expect.any(String));
  expect(body).not.toHaveProperty("modelSelection.selectedModel");
});

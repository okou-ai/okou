import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  FIRST_CAPABILITY_RUN_ID,
  RUN_PATH,
  RUN_THREAD_ID,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const PASSAGE = "launch plan has three careful stages";

test("F opens a Fork composer carrying the captured selection", async () => {
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
  });
  await screen.findByRole("textbox", { name: "Message" });
  await selectPassage(PASSAGE);

  fireEvent.keyDown(document, { key: "f" });

  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  const editor = await within(dialog).findByRole("textbox", {
    name: "Message",
  });
  expect(within(dialog).getByText(PASSAGE)).toBeInTheDocument();
  await fill(editor, "Focus on the launch risks");
  expect(editor).toHaveTextContent("Focus on the launch risks");
});

test("F keeps the Forward target picker when single-agent mode is disabled", async () => {
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: false },
  });
  await screen.findByRole("textbox", { name: "Message" });
  await selectPassage(PASSAGE);
  await findEnabledButton("Forward");

  fireEvent.keyDown(document, { key: "f" });

  const dialog = await screen.findByRole("dialog", { name: "Forward to" });
  click(await within(dialog).findByRole("option", { name: "Okou" }));
  await within(dialog).findByRole("textbox", { name: "Add a message" });
  expect(within(dialog).getByText(PASSAGE)).toBeInTheDocument();
});

test("Fork sends the selected passage and its source to a new personal chat", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`, "An unrelated answer."),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
  });
  const originalComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  await fill(originalComposer, "Keep my unfinished notes");
  await selectPassage(PASSAGE);
  click(await findEnabledButton("Fork"));
  const dialog = await screen.findByRole("dialog", { name: "Okou" });
  const note = await within(dialog).findByRole("textbox", {
    name: "Add a message",
  });
  const user = userEvent.setup({ delay: null });
  await user.type(note, "Explore the risks in a separate conversation");

  click(await findEnabledButton("Send", dialog));

  await screen.findByText("New chat created");
  const send = await waitForSend(sends, 1);
  expect(send.threadId).toStrictEqual(expect.any(String));
  expect(send.threadId).not.toBe(RUN_THREAD_ID);
  expect(send.sourceRunId).toBe(FIRST_CAPABILITY_RUN_ID);
  expect(send.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "feedback", quote: PASSAGE }),
    ]),
  );
  expect(send.prompt).toContain("Explore the risks in a separate conversation");
  expect(send.prompt).not.toContain("An unrelated answer.");
  expect(originalComposer).toHaveTextContent("Keep my unfinished notes");
});

test("Forward sends the passage with its source thread to the chosen agent", async () => {
  const sends: CapturedChatSend[] = [];
  installCapabilityChat({
    events: completedConversation(`The ${PASSAGE}.`),
    onSend(send) {
      sends.push(send);
    },
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: false },
  });
  await screen.findByRole("textbox", { name: "Message" });
  await selectPassage(PASSAGE);
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog", { name: "Forward to" });
  click(await within(dialog).findByRole("option", { name: "Okou" }));
  const note = await within(dialog).findByRole("textbox", {
    name: "Add a message",
  });
  const user = userEvent.setup({ delay: null });
  await user.type(note, "Share this with the launch team");

  click(await findEnabledButton("Send", dialog));

  const send = await waitForSend(sends, 1);
  expect(send.threadId).not.toBe(RUN_THREAD_ID);
  expect(send.sourceRunId).toBe(FIRST_CAPABILITY_RUN_ID);
  expect(send.userMessage?.parts).toStrictEqual([
    expect.objectContaining({ type: "feedback", quote: PASSAGE }),
  ]);
  expect(send.prompt).toContain("Share this with the launch team");
});

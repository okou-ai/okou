import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedConversation,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import {
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();

test("chat-capability-feedback-002 sending a quoted comment preserves the existing text and attachment", async () => {
  const file = "review-notes.txt",
    passage = "Inspect the staged delivery.",
    note = "Mention the alternate route.",
    message = "Here is my review.";
  const sent = context.mocks.deferred<UserMessageDocument | undefined>();
  createChatRunFixtures(context).installRunChat({
    chatEvents: completedConversation(passage),
    onSendRequest(body) {
      sent.resolve(body.userMessage);
    },
  });
  context.mocks.upload.success({
    id: "review-file",
    filename: file,
    contentType: "text/plain",
    size: 6,
    url: "https://cdn.vm7.io/review-notes.txt",
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await screen.findByText(passage);
  const user = userEvent.setup({ delay: null });
  await user.type(await screen.findByLabelText("Message"), message);
  await user.upload(
    await screen.findByLabelText("Attach", { selector: "input" }),
    new File(["review"], file, { type: "text/plain" }),
  );
  await screen.findByText(file);
  await selectPassage(passage);
  click(await findButton("Quote"));
  await user.type(
    await screen.findByRole("textbox", {
      name: "Ask or comment on this quote",
    }),
    note,
  );
  click(await findEnabledButton("Send"));
  const submission = await sent.promise;
  expect(
    submission?.parts
      .filter((part) => {
        return part.type === "text";
      })
      .map((part) => {
        return part.text.trim();
      }),
  ).toContain(message);
  expect(submission?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "file",
        fileId: "review-file",
        filenameSnapshot: file,
      }),
      expect.objectContaining({
        type: "feedback",
        quote: passage,
        note: [{ type: "text", text: note }],
      }),
    ]),
  );
  await screen.findByText(note);
});

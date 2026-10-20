import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
  mockTemplateChat,
  openTemplatePicker,
  THREAD_ID,
} from "./chat-composer-template-gallery-test-helpers.ts";

test("Do not send a presentation that failed to upload", async () => {
  const capture = mockTemplateChat();
  context.mocks.api(uploadsContract.prepare, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Upload failed" },
    });
  });
  const user = userEvent.setup({ delay: null });

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });

  await openTemplatePicker(user);
  await user.upload(
    screen.getByLabelText("Import your own deck"),
    new File(["broken"], "broken-deck.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }),
  );
  await expect(screen.findByText("Upload failed")).resolves.toBeInTheDocument();
  expect(capture.sentMessages).toHaveLength(0);
  expect(capture.runPrompts).toHaveLength(0);
});

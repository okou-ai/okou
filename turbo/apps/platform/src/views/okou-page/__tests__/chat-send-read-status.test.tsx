import { chatThreadMarkReadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { startPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { RUN_THREAD_ID, RUN_PATH } from "./chat-run-test-fixtures.ts";

const context = testContext();
function timeline() {
  const delivered: string[] = [];
  const lifecycle = mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    threadTitle: "Release room",
    chatEvents: [
      {
        role: "assistant",
        content: "The last review ended",
        runId: "99100000-0000-4000-a000-000000000001",
        createdAt: "2026-08-11T18:00:00Z",
      },
    ],
    onRunCreate(body) {
      if (body.prompt) {
        delivered.push(body.prompt);
      }
    },
  });
  return { lifecycle, delivered };
}
async function send(text: string) {
  const editor = await findComposerEditor();
  await fill(editor, text);
  click(await findFastControl("button", "Send"));
  return editor;
}
test("chat-send-read-status-005 an unauthorized mark on a completed review leaves its composer available for the next request", async () => {
  const { delivered } = timeline(),
    answered = context.mocks.deferred<string>();
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    ({ params, respond }) => {
      if (!answered.settled()) {
        answered.resolve(params.id);
      }
      return respond(401, {
        error: { code: "UNAUTHORIZED", message: "Read status denied" },
      });
    },
  );
  const page = await startPage({ context, path: RUN_PATH });
  await expect(page.ready).rejects.toMatchObject({ status: 401 });
  await screen.findByText("The last review ended");
  await expect(answered.promise).resolves.toBe(RUN_THREAD_ID);
  const text = "Review the deployment risks",
    editor = await send(text);
  await waitFor(() => {
    expect(delivered).toContain(text);
    expect(editor.textContent).toBe("");
  });
});

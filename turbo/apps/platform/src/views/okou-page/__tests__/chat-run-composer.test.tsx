import { pushSubscriptionsContract } from "@okouai/api-contracts/contracts/push-subscriptions";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { mockAutoRunModel } from "../../../mocks/handlers/api-run-models.ts";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  RUN_PATH,
  promptEvent,
  assistantEvent,
  sendText,
  expectTextOrder,
} from "./chat-run-test-fixtures.ts";
import { createChatLifecycleHelpers } from "./chat-lifecycle-test-helpers.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);
test("chat-run-composer-002 starts the sent review and registers the browser push destination", async () => {
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY_PREVIEW", "AQID");
  createChatLifecycleHelpers(context).mockPushBrowserSupport();
  const subscription = context.mocks.deferred<string>();
  context.mocks.api(pushSubscriptionsContract.register, ({ body, respond }) => {
    subscription.resolve(body.endpoint);
    return respond(201, { success: true });
  });
  installRunChat();
  await setupPage({ context, path: "/" });
  const prompt = "Notify me when the launch review is complete.";
  await fill(await screen.findByRole("textbox", { name: "Message" }), prompt);
  click(await findEnabledButton("Send"));
  await screen.findByText(prompt, { selector: '[data-role="user"] *' });
  await screen.findByText("Thinking...");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    /^$/,
  );
  await expect(subscription.promise).resolves.toBe(
    "https://push.example.test/subscriptions/chat-send",
  );
});

test("chat-run-composer-004 submits the full launch board with the Auto message", async () => {
  const creationModel = context.mocks.deferred<string | null | undefined>();
  const submitted = context.mocks.deferred<UserMessageDocument | undefined>();
  installRunChat({
    selectedModel: null,
    onThreadCreate: (body) => {
      creationModel.resolve(body.model);
    },
    onRunCreate: (body) => {
      submitted.resolve(body.userMessage);
    },
  });
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, {
      models: [{ ...mockAutoRunModel(), model: AUTO_SELECTED_MODEL }],
    });
  });
  const file = new File([new Uint8Array(12_000_000)], "launch-board.png", {
    type: "image/png",
  });
  const id = "bc4927e2-aee5-4ade-b740-774594fbcc69";
  context.mocks.upload.success({
    id,
    filename: file.name,
    size: file.size,
    contentType: file.type,
    url: "https://cdn.vm7.io/artifacts/tests/launch-board.png",
  });
  await setupPage({ context, path: "/" });

  await userEvent.upload(
    await screen.findByLabelText("Attach", { selector: 'input[type="file"]' }),
    file,
  );
  await screen.findByLabelText("Remove launch-board.png");
  const message = "Review this launch board";
  await fill(screen.getByRole("textbox", { name: "Message" }), message);
  click(await findEnabledButton("Send"));
  await screen.findByText(message, { selector: '[data-role="user"] *' });
  const received = await submitted.promise;
  await expect(creationModel.promise).resolves.toBeNull();
  expect(received?.parts).toContainEqual(
    expect.objectContaining({
      type: "file",
      fileId: id,
      filenameSnapshot: file.name,
      contentType: file.type,
    }),
  );
});

test("chat-run-composer-005 keeps the pending automation beside an accepted follow-up in the live conversation", async () => {
  const runId = "3210dce2-b225-4c1e-b7cc-a38a9e1ff853";
  const update = "The launch outline is ready";
  const steer = "Clarify the delivery schedule";
  const instruction = "Send the launch recap tomorrow";
  const next = "Keep the owner names in the plan.";
  mockNow(new Date(2026, 7, 1, 23, 59, 59), context.signal);
  const persist = context.mocks.deferred<void>();
  installRunChat({
    activeRunIds: [runId],
    appendGate: persist.promise,
    chatEvents: [
      promptEvent({ id: runId, runId, seqId: 1, text: "Plan the launch" }),
      assistantEvent({ id: "outline", runId, seqId: 2, text: update }),
      promptEvent({ id: "timing", runId, seqId: 3, text: steer }),
      {
        id: "schedule-recap",
        eventType: "input.automation",
        content: null,
        runId: undefined,
        seqId: 4,
        createdAt: "2026-08-01T10:00:04Z",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "automation",
              workflowName: "Recap",
              automationBrief: instruction,
            },
          ],
        },
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const pending = await screen.findByRole("listitem", {
    name: "Pending automation event",
  });
  expect(pending).toHaveTextContent(instruction);
  await sendText(next);
  await screen.findByText(next, { selector: '[data-role="user"] *' });
  // The acknowledgement crosses midnight. Only the persisted input can
  // acquire the new day and introduce its divider before this message.
  mockNow(new Date(2026, 7, 2, 0, 0, 1), context.signal);
  persist.resolve();
  await screen.findByText("Today");
  expectTextOrder(update, steer, "Today", next);
  expect(
    screen.getByRole("listitem", { name: "Pending automation event" }),
  ).toHaveTextContent(instruction);
  await expect(findEnabledButton("Stop")).resolves.toBeInTheDocument();
});

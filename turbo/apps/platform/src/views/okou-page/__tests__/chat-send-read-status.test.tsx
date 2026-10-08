import {
  chatThreadDraftContract,
  chatThreadMarkReadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import {
  context,
  findButton,
  findEnabledButton,
  installRunChat,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

test.each(["pending", "unauthorized"] as const)(
  "Send in an existing conversation while unread indicators are %s",
  async (status) => {
    const indicatorsRequested = context.mocks.deferred<void>();
    const indicatorsResponse = context.mocks.deferred<void>();
    const runStarted = context.mocks.deferred<void>();
    let refreshing = false;
    const lifecycle = installRunChat({
      onRunCreate: () => {
        runStarted.resolve();
      },
    });
    context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
      if (refreshing) {
        if (!indicatorsRequested.settled()) {
          indicatorsRequested.resolve();
        }
        await indicatorsResponse.promise;
        if (status === "unauthorized") {
          return respond(401, {
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
          });
        }
      }
      return respond(200, { agents: {}, threads: {}, unreadAt: {} });
    });
    await setupPage({
      context,
      path: RUN_PATH,
      sharedWorkerTestTransport: "message-port",
    });
    const composer = await screen.findByRole("textbox", { name: "Message" });

    refreshing = true;
    context.mocks.ably.trigger("threadListChanged");
    await indicatorsRequested.promise;
    await fill(composer, "Continue the release review");
    click(await findEnabledButton("Send"));
    await expect(
      screen.findByText("Continue the release review"),
    ).resolves.toBeInTheDocument();
    if (status === "unauthorized") {
      indicatorsResponse.resolve();
    }

    await runStarted.promise;
    lifecycle.setRunOutput("The agent received the release review.");
    await expect(
      screen.findByText("The agent received the release review."),
    ).resolves.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "",
    );
    expect(indicatorsResponse.settled()).toBe(status === "unauthorized");
    await findEnabledButton("Stop");
    await fill(
      screen.getByRole("textbox", { name: "Message" }),
      "Check the rollback plan next",
    );
    const sendButton = await findButton("Send");
    await waitFor(() => {
      expect(sendButton).toHaveProperty("disabled", status === "pending");
    });
    if (status === "pending") {
      indicatorsResponse.resolve();
    }
    await findEnabledButton("Send");
  },
);

test("Unread refresh failure ends submission without cancelling the pending POST", async () => {
  const indicatorsRequested = context.mocks.deferred<void>();
  const indicatorsResponse = context.mocks.deferred<void>();
  const sendRequested = context.mocks.deferred<void>();
  const sendResponse = context.mocks.deferred<void>();
  const runStarted = context.mocks.deferred<void>();
  let refreshing = false;
  const lifecycle = installRunChat({
    sendGate: sendResponse.promise,
    onSendRequest: () => {
      sendRequested.resolve();
    },
    onRunCreate: () => {
      runStarted.resolve();
    },
  });
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    if (refreshing) {
      if (!indicatorsRequested.settled()) {
        indicatorsRequested.resolve();
      }
      await indicatorsResponse.promise;
      return respond(401, {
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }
    return respond(200, { agents: {}, threads: {}, unreadAt: {} });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    sharedWorkerTestTransport: "message-port",
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  refreshing = true;
  context.mocks.ably.trigger("threadListChanged");
  await indicatorsRequested.promise;
  await fill(composer, "Review the release while read status refreshes");
  click(await findEnabledButton("Send"));
  await expect(
    screen.findByText("Review the release while read status refreshes"),
  ).resolves.toBeInTheDocument();
  await sendRequested.promise;
  await fill(composer, "Keep the follow-up ready");
  await expect(findButton("Send")).resolves.toBeDisabled();

  indicatorsResponse.resolve();
  await findEnabledButton("Send");
  expect(sendResponse.settled()).toBeFalsy();
  expect(composer).toHaveTextContent("Keep the follow-up ready");

  sendResponse.resolve();
  await runStarted.promise;
  lifecycle.setRunOutput("The submitted review still reached the agent.");
  await expect(
    screen.findByText("The submitted review still reached the agent."),
  ).resolves.toBeInTheDocument();
  expect(composer).toHaveTextContent("Keep the follow-up ready");
});

test("Forwarding waits for prompt acceptance without waiting for unread refresh", async () => {
  const indicatorsRequested = context.mocks.deferred<void>();
  const indicatorsResponse = context.mocks.deferred<void>();
  const sendRequested = context.mocks.deferred<void>();
  const sendResponse = context.mocks.deferred<void>();
  const runStarted = context.mocks.deferred<void>();
  let refreshing = false;
  const lifecycle = installRunChat({
    threadTitle: "Forwarding conversation",
    chatEvents: completedConversation(
      "The launch plan has three careful stages.",
    ),
    sendGate: sendResponse.promise,
    onSendRequest: () => {
      sendRequested.resolve();
    },
    onRunCreate: () => {
      runStarted.resolve();
    },
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, textContinuityDraft("Keep the existing notes."));
  });
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    if (refreshing) {
      if (!indicatorsRequested.settled()) {
        indicatorsRequested.resolve();
      }
      await indicatorsResponse.promise;
    }
    return respond(200, { agents: {}, threads: {}, unreadAt: {} });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    sharedWorkerTestTransport: "message-port",
  });
  const originalComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  expect(originalComposer).toHaveTextContent("Keep the existing notes.");
  await selectPassage("launch plan has three careful stages");
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByRole("option", {
      name: "Forwarding conversation",
    }),
  );
  const forwardComposer = await within(dialog).findByRole("textbox", {
    name: "Add a message",
  });
  await fill(forwardComposer, "Review these stages with the team");

  refreshing = true;
  context.mocks.ably.trigger("threadListChanged");
  await indicatorsRequested.promise;
  click(await findEnabledButton("Send", dialog));

  await sendRequested.promise;
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText("Forwarded successfully")).not.toBeInTheDocument();
  expect(originalComposer).toHaveTextContent("Keep the existing notes.");
  expect(sendResponse.settled()).toBeFalsy();
  expect(indicatorsResponse.settled()).toBeFalsy();

  sendResponse.resolve();
  await runStarted.promise;
  await expect(
    screen.findByText("Forwarded successfully"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(indicatorsResponse.settled()).toBeFalsy();
  lifecycle.setRunOutput("The agent received the forwarded stages.");
  await expect(
    screen.findByText("The agent received the forwarded stages."),
  ).resolves.toBeInTheDocument();
  expect(originalComposer).toHaveTextContent("Keep the existing notes.");
  indicatorsResponse.resolve();
});

test("A failed read mark does not prevent sending to the agent", async () => {
  const runStarted = context.mocks.deferred<void>();
  const readMarkRequested = context.mocks.deferred<void>();
  const previousRunId = "d0000000-0000-4000-a000-000000000802";
  const lifecycle = installRunChat({
    activeRunIds: [previousRunId],
    chatEvents: [
      promptEvent({
        id: "previous-review-prompt",
        runId: previousRunId,
        seqId: 1,
        text: "Prepare the release review",
      }),
    ],
    onRunCreate: () => {
      runStarted.resolve();
    },
  });
  context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
    if (!readMarkRequested.settled()) {
      readMarkRequested.resolve();
    }
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
  });
  await setupPage({
    context,
    path: RUN_PATH,
    sharedWorkerTestTransport: "message-port",
  });
  await expect(
    screen.findByText("Prepare the release review"),
  ).resolves.toBeInTheDocument();

  lifecycle.completeRun("The previous review is complete.");
  await expect(
    screen.findByText("The previous review is complete."),
  ).resolves.toBeInTheDocument();
  await readMarkRequested.promise;
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Review the deployment risks");
  click(await findEnabledButton("Send"));

  await runStarted.promise;
  lifecycle.setRunOutput("The agent received the deployment review.");
  await expect(
    screen.findByText("The agent received the deployment review."),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Review the deployment risks")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "",
  );
});

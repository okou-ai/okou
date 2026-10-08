import {
  chatThreadMarkReadContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  context,
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
    if (status === "pending") {
      indicatorsResponse.resolve();
    }
  },
);

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

import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListEvent,
  installChatListStream,
  installChatListRunModels,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
} from "./chat-run-test-fixtures.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();

test("chat-list-optimistic-007 reconciles the temporary sidebar destination with the confirmed title", async () => {
  const submitted = context.mocks.deferred<{ id: string; event: string }>();
  const confirm = context.mocks.deferred<void>();
  const createAccepted = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
    onSendRequest: () => {
      return createAccepted.resolve();
    },
  });
  installChatListRunModels(context);
  const stream = installChatListStream(context, { caseId: 292, snapshot: [] });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    if (!body.clientThreadId || !body.eventId) {
      throw new Error("Missing client identity on create");
    }
    submitted.resolve({ id: body.clientThreadId, event: body.eventId });
    await confirm.promise;
    return respond(201, {
      id: body.clientThreadId,
      title: null,
      createdAt: "2026-09-19T10:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-5",
      serviceTier: null,
    });
  });

  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Review the release",
  );
  click(await findEnabledButton("Send"));
  const identity = await submitted.promise;
  const list = within(await screen.findByTestId("chat-list-column"));
  try {
    await waitFor(() => {
      return expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
    });
    expect(sidebarThreadLinks()[0]).toHaveAttribute(
      "href",
      `/chats/${identity.id}`,
    );
  } finally {
    confirm.resolve();
  }
  await createAccepted.promise;
  stream.setEvents([
    chatListEvent(292, 2, "created", identity.id, {
      id: identity.event,
      title: "Confirmed conversation",
    }),
  ]);
  context.mocks.ably.trigger("threadListChanged");
  await list.findByText("Confirmed conversation");
  expect(sidebarThreadTitles()).toStrictEqual(["Confirmed conversation"]);
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "href",
    `/chats/${identity.id}`,
  );
});

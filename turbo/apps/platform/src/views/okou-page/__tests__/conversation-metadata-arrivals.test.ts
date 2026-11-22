import {
  chatThreadByIdContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { chatListThread, chatListEvent } from "./chat-list-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
async function details() {
  const first = chatListThread(19, "Original record"),
    newChat = chatListThread(20, "Recovered conversation");
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 596,
    threads: [first],
  });
  let discovered = false;
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    const event = chatListEvent(596, 2, "created", newChat.id, {
      title: newChat.title,
    });
    return respond(200, {
      events: discovered && (query.sinceSeqId ?? 0) < 2 ? [event] : [],
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    const old = params.id === first.id;
    const title = old ? first.title : newChat.title;
    const response = respond(200, {
      id: params.id,
      title,
      selectedModel: "claude-sonnet-5",
      serviceTier: null,
      modelSettings: {},
      pinnedAt: null,
      archived: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
    return response;
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  const app = await startPage({
    context,
    ...pageOptions,
    path: "/chats/" + first.id,
  });
  function announce() {
    discovered = true;
    const identity = pageOptions.auth!;
    context.mocks.ably.triggerOnChannel(
      "user-org:" +
        identity.user.id +
        ":" +
        identity.organization!.activeOrg!.id,
      "threadListChanged",
    );
  }
  return { first, newChat, app, announce };
}
test("chat-metadata-002 A newly announced conversation can be opened by its synchronized title without renaming the original", async () => {
  const live = await details();
  await live.app.ready;
  const original = await findFastControl("link", live.first.title!);
  expect(queryFastControl("link", live.newChat.title!)).toBeNull();
  live.announce();
  const target = await findFastControl("link", live.newChat.title!);
  click(target);
  await waitFor(() => {
    expect(document.title).toContain(live.newChat.title);
    expect(location.pathname).toBe("/chats/" + live.newChat.id);
  });
  expect(target).toHaveAttribute("aria-current", "page");
  expect(original).toHaveTextContent(live.first.title!);
  await expect(findComposerEditor()).resolves.toBeVisible();
});

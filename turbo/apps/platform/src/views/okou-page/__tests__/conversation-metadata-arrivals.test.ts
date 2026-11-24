import {
  chatThreadByIdContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { holdResponseField } from "./browser-response-fixture.ts";
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
async function details(originalTitle?: string, tailGate?: Promise<void>) {
  const first = chatListThread(19, "Original record"),
    newChat = chatListThread(20, "Recovered conversation");
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 596,
    threads: originalTitle ? [] : [first],
  });
  let discovered = false;
  context.mocks.api(chatThreadsContract.events, async ({ query, respond }) => {
    await tailGate;
    const event = chatListEvent(596, 2, "created", newChat.id, {
      title: newChat.title,
    });
    return respond(200, {
      events: discovered && (query.sinceSeqId ?? 0) < 2 ? [event] : [],
      hasMore: false,
    });
  });
  let missingResponse: Promise<void> | undefined;
  const missingRead = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadMetadataContract.get,
    async ({ params, respond }) => {
      const old = params.id === first.id;
      if (old && missingResponse) {
        if (!missingRead.settled()) {
          missingRead.resolve();
        }
        await missingResponse;
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: "This conversation is no longer available",
          },
        });
      }
      const title = old ? (originalTitle ?? first.title) : newChat.title;
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
    },
  );
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
  return {
    first,
    newChat,
    app,
    announce,
    missingRead,
    markMissing: (delivery: Promise<void>) => {
      missingResponse = delivery;
    },
  };
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

function holdTitle(late: string) {
  return holdResponseField(
    context,
    (url, value) => {
      return url.pathname.endsWith("/metadata") && value === late;
    },
    "title",
  );
}
test.each([
  [
    "chat-metadata-001 A conversation selected during an outstanding metadata read keeps its own heading",
    true,
  ],
  [
    "A selected conversation keeps its heading while its predecessor is withheld",
    false,
  ],
] as const)("%s", async (_name, deliver) => {
  const late = "Archived expedition";
  const { received, release, consumed } = holdTitle(late);
  const live = await details(late);
  await received.promise;
  live.announce();
  click(await findFastControl("link", live.newChat.title!));
  await waitFor(() => {
    expect(location.pathname).toBe("/chats/" + live.newChat.id);
    expect(document.title).toContain(live.newChat.title);
  });
  if (deliver) {
    await act(async () => {
      release.resolve();
      await consumed.promise;
    });
  }
  expect(document.title).not.toContain(late);
  expect(document.title).toContain(live.newChat.title);
  const editor = await findComposerEditor();
  expect(editor).toBeVisible();
  expect(editor).toHaveAttribute("contenteditable", "true");
});

test.each(["deliver", "withhold"] as const)(
  "Returning from Workflows keeps the abandoned conversation out of the pending and confirmed missing states (%s)",
  async (delivery) => {
    const stale = "Superseded field notes";
    const held = holdTitle(stale);
    const live = await details(stale);
    await held.received.promise;
    click(await findFastControl("link", "Workflows"));
    await waitFor(() => {
      expect(document.title).toBe("Workflows | Okou");
    });
    if (delivery === "deliver") {
      await act(async () => {
        held.release.resolve();
        await held.consumed.promise;
      });
    }
    expect(document.title).toBe("Workflows | Okou");
    const notFound = context.mocks.deferred<void>();
    live.markMissing(notFound.promise);
    act(() => {
      history.back();
    });
    await live.missingRead.promise;
    try {
      await waitFor(() => {
        expect(location.pathname).toBe("/chats/" + live.first.id);
        expect(screen.queryByRole("heading", { name: "Workflows" })).toBeNull();
      });
      expect(screen.queryByRole("region", { name: "Chat thread" })).toBeNull();
      expect(screen.queryByText(stale)).toBeNull();
    } finally {
      notFound.resolve();
    }
    await screen.findByText(
      /thread not found|chat not found|conversation not found/i,
    );
    await waitFor(() => {
      expect(location.pathname).toBe("/chats/" + live.first.id);
    });
    expect(
      screen.getByRole("region", { name: "Chat thread" }),
    ).toHaveTextContent("Chat thread not found");
    expect(document.title).not.toContain(stale);
    click(await findFastControl("link", "Workflows"));
    await expect(
      screen.findByRole("heading", { name: "Workflows" }),
    ).resolves.toBeVisible();
    expect(document.title).toBe("Workflows | Okou");
  },
);

test("An outstanding metadata body supplies the original conversation title while the route is still selected", async () => {
  const late = "Coastal navigation archive";
  const held = holdTitle(late);
  const tail = context.mocks.deferred<void>();
  try {
    await details(late, tail.promise);
    await held.received.promise;
    expect(document.title).not.toContain(late);
    held.release.resolve();
    await held.consumed.promise;
    await waitFor(() => {
      expect(document.title).toContain(late);
    });
    await expect(findComposerEditor()).resolves.toBeVisible();
  } finally {
    tail.resolve();
  }
});

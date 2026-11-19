import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { artifactSummary } from "./chat-navigation-artifact-test-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  composer,
  openResources,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();

test("The next chat starts closed and shows only its own resources once its messages load", async () => {
  context.mocks.browser.matchMedia(true);
  const first = continuityThread(92, 1, "First resources");
  const second = continuityThread(92, 2, "Second resources");
  const messagesRequested = context.mocks.deferred<void>();
  const messagesResponse = context.mocks.deferred<void>();
  const rows = [first, second].map((thread, index) => {
    return continuityEventRow(92, index + 1, thread.id, "input.prompt", {
      payload: {
        userMessage: {
          version: 1,
          parts: [
            {
              type: "text",
              text: `[${thread.title} guide](https://example.test/${index})`,
            },
          ],
        },
      },
    });
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 92,
    threads: [first, second],
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  });
  context.mocks.api(chatRelationsContract.communications, ({ respond }) => {
    return respond(200, { items: [] });
  });
  const holdSecondMessages = async () => {
    if (!messagesRequested.settled()) {
      messagesRequested.resolve();
    }
    await messagesResponse.promise;
  };
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      if (params.threadId === second.id) {
        await holdSecondMessages();
      }
      return respond(
        200,
        chatEventRowsResponse(
          rows.filter((row) => {
            return row.chatThreadId === params.threadId;
          }),
          query,
        ),
      );
    },
  );
  context.mocks.api(
    chatThreadEventsContract.catchUp,
    async ({ body, respond }) => {
      if (
        body.some(([threadId]) => {
          return threadId === second.id;
        })
      ) {
        await holdSecondMessages();
      }
      return respond(200, {
        events: Object.fromEntries(
          body.map(([threadId, sinceSeqId]) => {
            return [
              threadId,
              rows.filter((row) => {
                return row.chatThreadId === threadId && row.seqId > sinceSeqId;
              }),
            ];
          }),
        ),
        notFoundThreads: [],
      });
    },
  );
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    const filename =
      query.chatThreadId === first.id ? "first.pdf" : "second.pdf";
    return respond(200, {
      artifacts: [
        artifactSummary(query.chatThreadId ?? first.id, "file", filename),
      ],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${first.id}`,
  });
  await screen.findByTestId("chat-thread-header-title");
  const firstPanel = await openResources();
  await within(firstPanel).findByText("first.pdf");

  const next = queryAllByRoleFast("link").find((link) => {
    return link.getAttribute("href") === `/chats/${second.id}`;
  });
  if (!next) {
    throw new Error("Second chat is missing");
  }
  click(next);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Second resources",
    );
  });
  expect(resourceState()).toStrictEqual({ open: false, visible: false });

  const loading = await openResources();
  await messagesRequested.promise;
  expect(
    within(loading).getByRole("status", { name: "Loading artifacts" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();

  messagesResponse.resolve();
  await waitFor(() => {
    expect(
      within(resourcePanel()!).getByText("second.pdf"),
    ).toBeInTheDocument();
  });
  expect(
    within(resourcePanel()!).queryByText("first.pdf"),
  ).not.toBeInTheDocument();
});

test("The rename dialog keeps chat shortcuts from leaving the chat", async () => {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const current = continuityThread(95, 1, "Current resources chat");
  const newer = continuityThread(95, 2, "Newer resources chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 95,
    threads: [current, newer],
    chatEventRows: [current, newer].map((thread, index) => {
      return continuityEventRow(95, index + 1, thread.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [
              {
                type: "text",
                text: `[Reference](https://example.test/${index})`,
              },
            ],
          },
        },
      });
    }),
  });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: [
        artifactSummary(query.chatThreadId ?? current.id, "file", "report.pdf"),
      ],
      nextCursor: null,
    });
  });
  await setupPage({
    context,
    path: `/chats/${current.id}`,
    ...workspace.pageOptions,
  });
  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(
      queryAllByRoleFast("link").some((link) => {
        return link.getAttribute("href") === `/chats/${newer.id}`;
      }),
    ).toBeTruthy();
  });
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard("{F2}");
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const title = within(dialog).getByPlaceholderText("Chat title");
  await waitFor(() => {
    expect(title).toHaveFocus();
  });

  await user.keyboard("{Meta>}{Shift>}{ArrowUp}o{/Shift}1{/Meta}");
  // Typing afterwards proves the field still handled the earlier keys.
  await user.keyboard("z");
  await waitFor(() => {
    expect((title as HTMLInputElement).value).toContain("z");
  });

  expect(window.location.pathname).toBe(`/chats/${current.id}`);
  expect(title).toHaveFocus();
});

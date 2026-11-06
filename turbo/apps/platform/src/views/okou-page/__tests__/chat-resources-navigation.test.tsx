import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
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
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { artifactSummary } from "./chat-navigation-artifact-test-helpers.ts";

import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

import {
  composer,
  openResources,
  resourceButton,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

const context = testContext();

test.each(["messages", "artifacts"])(
  "Start the next chat closed and show only its own resources once its %s load",
  async (pendingSource) => {
    context.mocks.browser.matchMedia(true);
    const first = continuityThread(92, 1, "First resources");
    const second = continuityThread(92, 2, "Second resources");
    const resourcesRequested = createDeferredPromise<void>(context.signal);
    const resourcesResponse = createDeferredPromise<void>(context.signal);
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
    context.mocks.api(
      chatThreadEventsContract.rows,
      async ({ params, query, respond }) => {
        if (params.threadId === second.id && pendingSource === "messages") {
          if (!resourcesRequested.settled()) {
            resourcesRequested.resolve();
          }
          await resourcesResponse.promise;
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
          pendingSource === "messages" &&
          body.some(([threadId]) => {
            return threadId === second.id;
          })
        ) {
          if (!resourcesRequested.settled()) {
            resourcesRequested.resolve();
          }
          await resourcesResponse.promise;
        }
        return respond(200, {
          events: Object.fromEntries(
            body.map(([threadId, sinceSeqId]) => {
              return [
                threadId,
                rows.filter((row) => {
                  return (
                    row.chatThreadId === threadId && row.seqId > sinceSeqId
                  );
                }),
              ];
            }),
          ),
          notFoundThreads: [],
        });
      },
    );
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, respond }) => {
        if (query.chatThreadId === second.id && pendingSource === "artifacts") {
          if (!resourcesRequested.settled()) {
            resourcesRequested.resolve();
          }
          await resourcesResponse.promise;
        }
        const filename =
          query.chatThreadId === first.id ? "first.pdf" : "second.pdf";
        return respond(200, {
          artifacts: [
            artifactSummary(query.chatThreadId ?? first.id, "file", filename),
          ],
          nextCursor: null,
        });
      },
    );
    await setupPage({
      context,
      ...workspace.pageOptions,
      path: `/chats/${first.id}`,
    });
    await screen.findByTestId("chat-thread-header-title");
    const previousPanel = await openResources();
    await within(previousPanel).findByText("first.pdf");
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
    expect(resourceButton()).toBeEnabled();
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
    // The next chat's panel loads its own resources, never the previous chat's.
    const loading = await openResources();
    await resourcesRequested.promise;
    expect(
      within(loading).getByRole("status", { name: "Loading artifacts" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
    resourcesResponse.resolve();
    await waitFor(() => {
      expect(
        within(resourcePanel()!).getByText("second.pdf"),
      ).toBeInTheDocument();
    });
    const nextPanel = resourcePanel()!;
    expect(within(nextPanel).queryByText("first.pdf")).not.toBeInTheDocument();
  },
);

async function setupShortcutNavigation() {
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
  return { current, newer, user: userEvent.setup() };
}

test("Keep chat shortcuts blocked by the rename dialog", async () => {
  const { current, user } = await setupShortcutNavigation();
  await user.click(composer());
  await user.keyboard("{F2}");
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const title = within(dialog).getByPlaceholderText("Chat title");
  await waitFor(() => {
    expect(title).toHaveFocus();
  });
  await user.keyboard("{Meta>}{Shift>}{ArrowUp}o{/Shift}1{/Meta}");
  expect(pathname()).toBe(`/chats/${current.id}`);
  expect(title).toHaveFocus();
});

test("Pause chat shortcuts while the artifacts panel is open, like other header panels", async () => {
  const { current, newer, user } = await setupShortcutNavigation();
  const panel = await openResources();
  await within(panel).findByText("report.pdf");
  await user.keyboard("{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}");
  expect(pathname()).toBe(`/chats/${current.id}`);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(panel).not.toBeInTheDocument();
  });
  // With the panel closed, the same shortcut moves to the adjacent chat.
  await user.keyboard("{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}");
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${newer.id}`);
  });
});

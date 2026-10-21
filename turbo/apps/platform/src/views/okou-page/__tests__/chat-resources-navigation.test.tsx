import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { chatEventRowsResponse } from "../../../signals/__tests__/test-helpers.ts";
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
  context,
  installResourceGeometry,
  resourceButton,
  recordPreferenceUpdates,
  resourcePanel,
  resourceState,
} from "./chat-resources-test-helpers.ts";

async function setupResourceNavigation() {
  installResourceGeometry(480);
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
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
    ...workspace.pageOptions,
  });
  await screen.findByRole("region", { name: "Resources" });
  await screen.findByRole("textbox", { name: "Message" });
  return { current, newer, user: userEvent.setup() };
}

test.each(["messages", "artifacts"])(
  "Show no previous resources and no placeholder while the next chat's %s load",
  async (pendingSource) => {
    installResourceGeometry(480);
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
      featureSwitches: {
        [FeatureSwitchKey.ChatResourcePanel]: true,
      },
    });
    const previousPanel = await screen.findByRole("region", {
      name: "Resources",
    });
    await within(previousPanel).findByText("first.pdf");
    const next = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("href") === `/chats/${second.id}`;
    });
    if (!next) {
      throw new Error("Second chat is missing");
    }
    click(next);
    await resourcesRequested.promise;
    await waitFor(() => {
      expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
        "Second resources",
      );
    });
    expect(resourceButton()).toBeEnabled();
    // The next chat's panel waits for its own resources instead of showing a
    // placeholder or the previous chat's.
    expect(resourcePanel()).not.toBeInTheDocument();
    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
    resourcesResponse.resolve();
    await waitFor(() => {
      expect(
        within(resourcePanel()!).getByText("second.pdf"),
      ).toBeInTheDocument();
    });
    const nextPanel = resourcePanel()!;
    expect(within(nextPanel).getByText("second.pdf")).toBeInTheDocument();
    expect(within(nextPanel).queryByText("first.pdf")).not.toBeInTheDocument();
  },
);

function twoResourceChats(caseId: number) {
  const first = continuityThread(caseId, 1, "First resources");
  const second = continuityThread(caseId, 2, "Second resources");
  const workspace = installContinuityWorkspace(context, {
    caseId,
    threads: [first, second],
    chatEventRows: [first, second].map((thread, index) => {
      return continuityEventRow(caseId, index + 1, thread.id, "input.prompt", {
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: `${thread.title ?? "Resources"}` }],
          },
        },
      });
    }),
  });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: [
        artifactSummary(query.chatThreadId ?? first.id, "file", "report.pdf"),
      ],
      nextCursor: null,
    });
  });
  return { first, second, workspace };
}

async function openChat(id: string, title: string) {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === `/chats/${id}`;
  });
  if (!link) {
    throw new Error(`${title} is missing`);
  }
  click(link);
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      title,
    );
  });
}

test("Carry a press with room beside the transcript to every chat", async () => {
  installResourceGeometry(480);
  context.mocks.browser.matchMedia(true);
  const updates = recordPreferenceUpdates(false);
  const { first, second, workspace } = twoResourceChats(91);
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${first.id}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await screen.findByTestId("chat-thread-header-title");
  click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  await openChat(second.id, "Second resources");
  // The press was the preference, so the next chat opens on its own.
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
    expect(updates.at(-1)).toStrictEqual({
      chatResourcesEnabledByDefault: false,
    });
  });
  await openChat(first.id, "First resources");
  expect(resourceState()).toStrictEqual({ open: false, visible: false });
});

test("Peek without changing the preference when the gutter is too narrow", async () => {
  const resize = installResourceGeometry(200);
  context.mocks.browser.matchMedia(true);
  recordPreferenceUpdates(true);
  const { second, workspace, first } = twoResourceChats(93);
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${first.id}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  await screen.findByTestId("chat-thread-header-title");
  click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
  click(resourceButton());
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: false, visible: false });
  });
  resize(480);
  await openChat(second.id, "Second resources");
  // The narrow close only applied to the first chat; the preference is still on.
  await waitFor(() => {
    expect(resourceState()).toStrictEqual({ open: true, visible: true });
  });
});

test.each([
  {
    name: "adjacent",
    previous: "{Meta>}{Shift>}{ArrowUp}{/Shift}{/Meta}",
    next: "{Meta>}{Shift>}{ArrowDown}{/Shift}{/Meta}",
  },
  {
    name: "numbered",
    previous: "{Meta>}1{/Meta}",
    next: "{Meta>}2{/Meta}",
  },
])(
  "Navigate $name chats while resources stay open",
  async ({ previous, next }) => {
    const { current, newer, user } = await setupResourceNavigation();
    await user.click(composer());
    expect(resourcePanel()).toBeInTheDocument();
    await user.keyboard(previous);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${newer.id}`);
      expect(document.title).toBe("Newer resources chat | Okou");
    });
    await screen.findByRole("region", { name: "Resources" });
    await user.click(composer());
    await user.keyboard(next);
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${current.id}`);
      expect(document.title).toBe("Current resources chat | Okou");
    });
  },
);

test("Search and start a chat with resources open", async () => {
  const { current, user } = await setupResourceNavigation();
  const editor = composer();
  await user.click(editor);
  await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  expect(
    within(dialog).getByPlaceholderText("Search workspace..."),
  ).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(editor).toHaveFocus();
  });
  expect(resourcePanel()).toBeInTheDocument();
  await user.keyboard("{Meta>}{Shift>}o{/Shift}{/Meta}");
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${current.agentId}/chat`);
  });
});

test("Keep chat shortcuts blocked by the rename dialog while resources are open", async () => {
  const { current, user } = await setupResourceNavigation();
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
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(resourcePanel()).toBeInTheDocument();
});

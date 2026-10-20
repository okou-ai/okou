import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import {
  chatThreadRenameContract,
  chatThreadsContract,
  type ChatThreadEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import {
  continuityEventRow,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";

const context = testContext();
const ORIGINAL_TITLE = "Original parent title";
const RENAMED_TITLE = "Renamed parent title";
const SOURCE_RUN = "d0000000-0000-4000-a000-000000000911";

async function setupRelationships({
  title = ORIGINAL_TITLE,
  unavailable = false,
}: {
  readonly title?: string;
  readonly unavailable?: boolean;
} = {}) {
  const child = continuityThread(97, 1, "Relationship viewer");
  const parent = continuityThread(97, 2, title);
  const launch = continuityEventRow(97, 1, child.id, "input.prompt", {
    payload: {
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Inspect related conversations" },
          {
            type: "source",
            kind: "agent",
            threadId: parent.id,
            runId: SOURCE_RUN,
            agentId: parent.agentId,
            titleSnapshot: ORIGINAL_TITLE,
            href: `/chats/${parent.id}#run-${SOURCE_RUN}`,
          },
        ],
      },
    },
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 97,
    threads: [child, parent],
    chatEventRows: [{ ...launch, runId: launch.id }],
  });
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "scrollContainer")) {
        return new DOMRect(0, 80, 1800, 700);
      }
      if (Object.hasOwn(this.dataset, "messageContainer")) {
        return new DOMRect(420, 80, 900, 700);
      }
      return original.call(this);
    },
  );
  context.mocks.browser.matchMedia(true);
  const saveResponse = context.mocks.deferred<void>();
  const relationshipResponse = context.mocks.deferred<void>();
  let serverTitle = title;
  let delayRelationships = false;
  const events: ChatThreadEvent[] = [];
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > (query.sinceSeqId ?? 0);
      }),
      hasMore: false,
    });
  });
  context.mocks.api(chatRelationsContract.children, ({ respond }) => {
    return respond(200, { items: [] });
  });
  context.mocks.api(
    chatRelationsContract.communications,
    async ({ params, respond }) => {
      const responseTitle = serverTitle;
      if (delayRelationships) {
        await relationshipResponse.promise;
      }
      return respond(200, {
        items:
          params.id === child.id
            ? [
                {
                  threadId: parent.id,
                  // A relationship request may have read before the rename committed.
                  title: unavailable ? null : responseTitle,
                  status: unavailable ? "unavailable" : "idle",
                  sentCount: 1,
                  receivedCount: 0,
                  lastMessageAt: "2026-09-01T10:00:00.000Z",
                },
              ]
            : [],
      });
    },
  );
  context.mocks.api(
    chatThreadRenameContract.rename,
    async ({ body, params, respond }) => {
      await saveResponse.promise;
      serverTitle = body.title;
      events.push(
        chatListEvent(97, 2, "renamed", params.id, {
          id: body.eventId,
          title: body.title,
          agentId: parent.agentId,
        }),
      );
      return respond(204);
    },
  );
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${parent.id}?sidebar=${child.id}`,
    featureSwitches: { [FeatureSwitchKey.ChatResourcePanel]: true },
  });
  // Both panes open their resources; the child's lists the parent with From.
  const panel = await waitFor(() => {
    const found = screen
      .getAllByRole("region", { name: "Resources" })
      .find((candidate) => {
        return within(candidate).queryByText("From", { exact: true }) !== null;
      });
    if (!found) {
      throw new Error("Expected the resource panel listing the parent chat");
    }
    return found;
  });
  const chats = within(panel).getByRole("region", { name: "Chats" });
  const parentPane = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${parent.id}"]`,
  );
  if (!parentPane) {
    throw new Error("Expected the parent chat pane");
  }
  return {
    parent,
    panel,
    chats,
    parentPane,
    saveResponse,
    relationshipResponse,
    delayRelationshipResponses() {
      delayRelationships = true;
    },
    renameFromAnotherTab() {
      serverTitle = RENAMED_TITLE;
      events.push(
        chatListEvent(97, 2, "renamed", parent.id, {
          title: RENAMED_TITLE,
          agentId: parent.agentId,
        }),
      );
      changeChatThreadList();
    },
  };
}

// The parent is both the origin and a related chat, so it is listed once and
// carries the From tag. Its message history makes the row a disclosure.
function expectRelationshipTitle(chats: HTMLElement, title: string) {
  const titles = within(chats).getAllByText(title);
  expect(titles).toHaveLength(1);
  const row = titles[0]!.closest("button");
  expect(row).toHaveTextContent(title);
  expect(row).toHaveTextContent("From");
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(row).not.toHaveAttribute("title");
  expect(titles[0]).toBeVisible();
}

test("Show the current parent title when loading historical sources", async () => {
  const { panel, chats } = await setupRelationships({
    title: RENAMED_TITLE,
  });
  expectRelationshipTitle(chats, RENAMED_TITLE);
  expect(queryAllByRoleFast("link", chats)).toHaveLength(0);
  expect(
    within(panel).queryByRole("region", { name: "From" }),
  ).not.toBeInTheDocument();
});

test("Update relationship titles immediately and synchronize the saved browser title without a realtime notification", async () => {
  const {
    chats,
    parentPane,
    saveResponse,
    relationshipResponse,
    delayRelationshipResponses,
  } = await setupRelationships();
  const user = userEvent.setup({ delay: null });
  await user.dblClick(
    within(parentPane).getByTestId("chat-thread-header-title"),
  );
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  await fill(within(dialog).getByPlaceholderText("Chat title"), RENAMED_TITLE);
  delayRelationshipResponses();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expectRelationshipTitle(chats, RENAMED_TITLE);
  });
  saveResponse.resolve();
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(document.title).toContain(RENAMED_TITLE);
  });
  expectRelationshipTitle(chats, RENAMED_TITLE);
  relationshipResponse.resolve();
});

test("Update the parent chat row when another tab renames the parent", async () => {
  const {
    chats,
    renameFromAnotherTab,
    relationshipResponse,
    delayRelationshipResponses,
  } = await setupRelationships();
  expectRelationshipTitle(chats, ORIGINAL_TITLE);
  delayRelationshipResponses();
  act(renameFromAnotherTab);
  await expect(
    within(chats).findByText(RENAMED_TITLE),
  ).resolves.toBeInTheDocument();
  expectRelationshipTitle(chats, RENAMED_TITLE);
  relationshipResponse.resolve();
});

test("Keep unavailable relationships unlinked even when parent metadata is cached", async () => {
  const { chats } = await setupRelationships({ unavailable: true });
  const row = within(chats).getByText("Unavailable").closest("li");
  expect(row).toHaveTextContent("From");
  expect(queryAllByRoleFast("link", chats)).toHaveLength(0);
});

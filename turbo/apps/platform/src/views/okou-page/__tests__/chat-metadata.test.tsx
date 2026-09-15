import {
  chatThreadMetadataContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
  startPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const FIRST_THREAD_ID = "b0000000-0000-4000-a000-000000000101";
const SECOND_THREAD_ID = "b0000000-0000-4000-a000-000000000102";
const SNAPSHOT_EVENT_ID = "d0000000-0000-4000-a000-000000000101";
const UPDATE_EVENT_ID = "d0000000-0000-4000-a000-000000000102";
const CREATED_AT = "2026-08-01T10:00:00.000Z";
const UPDATED_AT = "2026-08-01T10:05:00.000Z";

const context = testContext();

function isolatedAuth(): Exclude<SetupPageAuth, null> {
  const resourceId = context.resourceId;
  const organizationId = `org_${resourceId}`;
  return {
    user: {
      id: `user_${resourceId}`,
      fullName: "Test User",
    },
    organization: {
      activeOrg: { id: organizationId, name: "Metadata Workspace" },
      memberships: [{ id: organizationId }],
    },
  };
}

function configureChatPrerequisites(): void {
  context.mocks.data.agents([{ agentId: AGENT_ID }]);
  context.mocks.data.userModelPreference({
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    modelSettings: {},
    selectedVideoModel: null,
    selectedImageModel: null,
    updatedAt: null,
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Browser session not found",
      },
    });
  });
}

function snapshotThread(
  id: string,
  title: string | null,
): ChatThreadSnapshotProjection {
  return {
    id,
    agentId: AGENT_ID,
    title,
    sortAt: CREATED_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    modelSettings: {},
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function threadMetadata(id: string, title: string): ChatThreadMetadata {
  return {
    id,
    agentId: AGENT_ID,
    title,
    selectedModel: "claude-sonnet-4-6",
    modelSettings: {},
    serviceTier: null,
    pinnedAt: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
  };
}

function threadEvent(args: {
  readonly id?: string;
  readonly kind: "created" | "renamed";
  readonly seqId: number;
  readonly threadId: string;
  readonly title: string;
}): ChatThreadEvent {
  return {
    id: args.id ?? UPDATE_EVENT_ID,
    seqId: args.seqId,
    kind: args.kind,
    chatThreadId: args.threadId,
    agentId: AGENT_ID,
    title: args.title,
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
    createdAt: UPDATED_AT,
  };
}

function actionName(element: HTMLElement): string {
  return (
    element.getAttribute("aria-label") ?? element.textContent?.trim() ?? ""
  );
}

function getLink(name: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return (
      actionName(candidate) === name ||
      candidate.textContent?.trim().includes(name) === true
    );
  });
  if (!link) {
    throw new Error(`Could not find link named ${name}`);
  }
  return link;
}

function findLink(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    return getLink(name);
  });
}

function getHeaderTitle(region: HTMLElement, title: string): HTMLElement {
  const titleElement = within(region)
    .queryAllByText(title)
    .find((candidate) => {
      return candidate.closest("header") !== null;
    });
  if (!titleElement) {
    throw new Error(`Could not find chat header title ${title}`);
  }
  return titleElement;
}

function findChatRegion(title: string): Promise<HTMLElement> {
  return waitFor(() => {
    const region = screen
      .queryAllByRole("region", { name: "Chat thread" })
      .find((candidate) => {
        return within(candidate)
          .queryAllByText(title)
          .some((titleElement) => {
            return titleElement.closest("header") !== null;
          });
      });
    if (!region) {
      throw new Error(`Could not find chat region titled ${title}`);
    }
    return region;
  });
}

async function expectReadyChat(title: string): Promise<HTMLElement> {
  const region = await findChatRegion(title);
  expect(getHeaderTitle(region, title)).toBeVisible();
  const composer = await within(region).findByRole("textbox", {
    name: "Message",
  });
  expect(composer).toBeVisible();
  return region;
}

test("Late thread details do not replace the conversation the user chose", async () => {
  const availableThreadList = context.mocks.deferred<void>();
  const abandonedDetailsRequested = context.mocks.deferred<void>();
  const abandonedDetails = context.mocks.deferred<void>();
  const user = userEvent.setup({ delay: null });

  configureChatPrerequisites();
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await availableThreadList.promise;
    return respond(200, {
      chatThreads: [snapshotThread(SECOND_THREAD_ID, "Chosen conversation")],
      latestEventId: SNAPSHOT_EVENT_ID,
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(
    chatThreadMetadataContract.get,
    async ({ params, respond }) => {
      if (params.id === FIRST_THREAD_ID) {
        abandonedDetailsRequested.resolve();
        await abandonedDetails.promise;
        return respond(
          200,
          threadMetadata(FIRST_THREAD_ID, "Stale route title"),
        );
      }
      return respond(
        200,
        threadMetadata(SECOND_THREAD_ID, "Chosen conversation"),
      );
    },
  );

  const page = await startPage({
    context,
    path: `/chats/${FIRST_THREAD_ID}`,
    auth: isolatedAuth(),
  });

  // Keep the old details in flight before making another conversation available.
  await abandonedDetailsRequested.promise;
  availableThreadList.resolve(undefined);
  await page.ready;
  const chosenLink = await findLink("Chosen conversation");
  await user.click(chosenLink);
  const chosenRegion = await expectReadyChat("Chosen conversation");

  abandonedDetails.resolve(undefined);

  await waitFor(() => {
    expect(getHeaderTitle(chosenRegion, "Chosen conversation")).toBeVisible();
  });
  expect(screen.queryByText("Stale route title")).not.toBeInTheDocument();
});

test("A newly available thread appears after a thread-list event", async () => {
  const recoveredThread = threadEvent({
    kind: "created",
    seqId: 2,
    threadId: SECOND_THREAD_ID,
    title: "Recovered synchronized title",
  });
  let recoveryAvailable = false;
  const user = userEvent.setup({ delay: null });

  configureChatPrerequisites();
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [snapshotThread(FIRST_THREAD_ID, "Original online chat")],
      latestEventId: SNAPSHOT_EVENT_ID,
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    return respond(200, {
      events:
        recoveryAvailable && (query.sinceSeqId ?? 0) < 2
          ? [recoveredThread]
          : [],
      hasMore: false,
    });
  });

  await setupPage({
    context,
    path: `/chats/${FIRST_THREAD_ID}`,
    auth: isolatedAuth(),
  });

  const originalRegion = await expectReadyChat("Original online chat");
  recoveryAvailable = true;

  context.mocks.ably.trigger("threadListChanged");

  const recoveredLink = await findLink("Recovered synchronized title");
  expect(getHeaderTitle(originalRegion, "Original online chat")).toBeVisible();
  await user.click(recoveredLink);

  await expectReadyChat("Recovered synchronized title");
  expect(document.title).toBe("Recovered synchronized title | Okou");
});

test("Returning to an interrupted chat does not reuse abandoned details", async () => {
  const unavailableThreadList = context.mocks.deferred<void>();
  const abandonedDetails = context.mocks.deferred<void>();
  const returningDetails = context.mocks.deferred<void>();
  let metadataRequestNumber = 0;
  const user = userEvent.setup({ delay: null });

  configureChatPrerequisites();
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await unavailableThreadList.promise;
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadMetadataContract.get, async ({ respond }) => {
    metadataRequestNumber += 1;
    if (metadataRequestNumber === 1) {
      await abandonedDetails.promise;
      return respond(
        200,
        threadMetadata(FIRST_THREAD_ID, "Abandoned visit title"),
      );
    }
    await returningDetails.promise;
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });

  await startPage({
    context,
    path: `/chats/${FIRST_THREAD_ID}`,
    auth: isolatedAuth(),
  });

  const agentsLink = await findLink("Agents");
  await user.click(agentsLink);
  const agentsHeading = await screen.findByRole("heading", { name: "Agents" });
  expect(agentsHeading).toBeVisible();

  abandonedDetails.resolve(undefined);

  expect(screen.queryByText("Abandoned visit title")).not.toBeInTheDocument();
  expect(document.title).toBe("Agents | Okou");

  window.history.back();

  await waitFor(() => {
    expect(
      screen.queryByRole("heading", { name: "Agents" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Abandoned visit title")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Chat thread" }),
    ).not.toBeInTheDocument();
  });
});

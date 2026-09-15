import type { IDBPDatabase } from "idb";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  computerUseHostsContract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";

import {
  queryAllByRoleFast,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import type { ChatThreadEventQueryResult } from "../../../shared-database/data-key.ts";
import { createChatIdbOpener } from "../../../signals/external/chat-idb-opener.ts";
import { createStrictIdbChatThreadEventStores } from "../../../signals/external/idb-chat-thread-event-store.ts";

export const CHAT_LIST_AGENT_ID = "c7000000-0000-4000-a000-000000000001";

export function chatListThreadId(index: number): string {
  return `b7000000-0000-4000-a000-${index.toString().padStart(12, "0")}`;
}

function chatListEventId(caseId: number, sequence: number): string {
  const suffix = caseId * 1000 + sequence;
  return `d7000000-0000-4000-a000-${suffix.toString().padStart(12, "0")}`;
}

export function chatListAuth(caseId: number): Exclude<SetupPageAuth, null> {
  const userId = `chat-list-user-${caseId}`;
  const orgId = `chat-list-org-${caseId}`;
  return {
    user: { id: userId, fullName: "Chat list user" },
    organization: {
      activeOrg: { id: orgId, name: "Chat list org" },
      memberships: [{ id: orgId }],
    },
  };
}

export function chatListThread(
  index: number,
  title: string,
  overrides: Partial<ChatThreadSnapshotProjection> = {},
): ChatThreadSnapshotProjection {
  const minute = index.toString().padStart(2, "0");
  const timestamp = `2026-08-01T00:${minute}:00.000Z`;
  return {
    id: chatListThreadId(index),
    agentId: CHAT_LIST_AGENT_ID,
    title,
    sortAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: "claude-sonnet-4-6",
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
    ...overrides,
  };
}

export function chatListEvent(
  caseId: number,
  sequence: number,
  kind: ChatThreadEvent["kind"],
  threadId: string,
  overrides: Partial<ChatThreadEvent> = {},
): ChatThreadEvent {
  const seconds = sequence.toString().padStart(2, "0");
  return {
    id: chatListEventId(caseId, sequence),
    seqId: sequence,
    kind,
    chatThreadId: threadId,
    agentId: CHAT_LIST_AGENT_ID,
    title: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    selectedVideoModel: null,
    selectedImageModel: null,
    createdAt: `2026-08-01T01:00:${seconds}.000Z`,
    ...overrides,
  };
}

function authIdentity(auth: Exclude<SetupPageAuth, null>): {
  readonly userId: string;
  readonly orgId: string;
} {
  const orgId = auth.organization?.activeOrg?.id;
  if (!orgId) {
    throw new Error("Chat list cache fixture requires an active organization");
  }
  return { userId: auth.user.id, orgId };
}

export function cachedChatListEvents(
  caseId: number,
  chatThreads: readonly ChatThreadSnapshotProjection[],
  events: readonly ChatThreadEvent[] = [],
): ChatThreadEventQueryResult {
  return {
    snapshot: {
      chatThreads: [...chatThreads],
      latestEventId: chatListEventId(caseId, 1),
      latestSeqId: 1,
    },
    events: [...events],
  };
}

/** Seed IndexedDB only when the page story exercises persistence across reloads. */
export async function seedPersistentChatListCache(
  caseId: number,
  auth: Exclude<SetupPageAuth, null>,
  chatThreads: readonly ChatThreadSnapshotProjection[],
  events: readonly ChatThreadEvent[] = [],
): Promise<void> {
  const identity = authIdentity(auth);
  const opener = createChatIdbOpener({ onVersionChange: () => {} });
  const database: IDBPDatabase = await opener.openChatIdb(
    identity.userId,
    identity.orgId,
  );
  const stores = createStrictIdbChatThreadEventStores(() => {
    return Promise.resolve(database);
  });
  await stores.writeStore.replaceFromSnapshot(
    {
      chatThreads,
      latestEventId: chatListEventId(caseId, 1),
      latestSeqId: 1,
    },
    events,
  );
  database.close();
}

interface ChatListStreamOptions {
  readonly caseId: number;
  readonly snapshot: readonly ChatThreadSnapshotProjection[];
  readonly events?: readonly ChatThreadEvent[];
  readonly remoteGate?: Promise<void>;
}

export function installChatListStream(
  context: TestContext,
  options: ChatListStreamOptions,
): {
  readonly setEvents: (events: readonly ChatThreadEvent[]) => void;
} {
  let currentEvents = [...(options.events ?? [])];
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await options.remoteGate;
    return respond(200, {
      chatThreads: [...options.snapshot],
      latestEventId: chatListEventId(options.caseId, 1),
      latestSeqId: 1,
    });
  });
  context.mocks.api(chatThreadsContract.events, async ({ query, respond }) => {
    await options.remoteGate;
    const sinceSeqId = query.sinceSeqId ?? 0;
    const events = currentEvents.filter((event) => {
      return event.seqId > sinceSeqId;
    });
    return respond(200, {
      events,
      hasMore: false,
    });
  });
  context.mocks.api(chatThreadsContract.drafts, ({ respond }) => {
    return respond(200, { draftThreadIds: [] });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });
  return {
    setEvents(events) {
      currentEvents = [...events];
    },
  };
}

export function installChatListAgent(
  context: TestContext,
  gate?: Promise<void>,
): void {
  context.mocks.api(agentsMainContract.list, async ({ respond }) => {
    await gate;
    return respond(200, [
      {
        isDefaultAgent: false,
        agentId: CHAT_LIST_AGENT_ID,
        ownerId: "chat-list-owner",
        displayName: "List agent",
        description: null,
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
        visibility: "private",
      },
    ]);
  });
}

export function installChatListModelPolicies(
  context: TestContext,
  defaultModel: OrgModelPolicy["model"] = "deepseek-v4-flash",
): void {
  const models = [
    ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
    ["deepseek-v4-flash", "DeepSeek V4 Flash"],
    ["gpt-5.6-sol", "GPT 5.6 Sol"],
    ["gpt-5.6-luna", "GPT 5.6 Luna"],
  ] as const;
  const timestamp = "2026-08-01T00:00:00.000Z";
  const policies: OrgModelPolicy[] = models.map(
    ([model, modelLabel], index) => {
      return {
        id: `e7000000-0000-4000-a000-${(index + 1)
          .toString()
          .padStart(12, "0")}`,
        model,
        modelLabel,
        isDefault: model === defaultModel,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
        modelProviderSurfaceId: null,
        routeStatus: "valid",
        routeStatusReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    },
  );
  context.mocks.data.orgModelPolicies(policies);
}

interface ActiveChatBoundaryOptions {
  readonly metadata?: ChatThreadSnapshotProjection;
  readonly hosts?: readonly ComputerUseHost[];
}

export function installActiveChatBoundaries(
  context: TestContext,
  options: ActiveChatBoundaryOptions = {},
): void {
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    const thread = options.metadata;
    if (!thread) {
      return respond(404, {
        error: {
          code: "CHAT_THREAD_NOT_FOUND",
          message: "Chat thread not found",
        },
      });
    }
    return respond(200, {
      id: thread.id,
      agentId: thread.agentId,
      title: thread.title,
      selectedModel: thread.selectedModel ?? null,
      modelSettings: thread.modelSettings ?? {},
      serviceTier: thread.serviceTier ?? null,
      pinnedAt: thread.pinnedAt,
      computerUseHostId: thread.computerUseHostId ?? null,
      cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
      selectedVideoModel: thread.selectedVideoModel ?? null,
      selectedImageModel: thread.selectedImageModel ?? null,
    });
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Browser session not found" },
    });
  });
  context.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [...(options.hosts ?? [])] });
  });
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return respond(404, {
      error: {
        code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
        message: "Chat event snapshot not found",
      },
    });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(200, {
      rows: [],
      cursor:
        query.sinceEventId === undefined
          ? { lastEventId: null, lastSeqId: 0 }
          : {
              lastEventId: query.sinceEventId,
              lastSeqId: query.sinceSeqId,
            },
      hasMore: false,
    });
  });
}

export function onlineComputerUseHost(
  id: string,
  displayName = "Studio Mac",
): ComputerUseHost {
  return {
    id,
    hostName: "studio-mac.local",
    displayName,
    appVersion: "1.0.0",
    osVersion: "15.0",
    supportedCapabilities: [],
    permissions: {
      accessibility: true,
      screenRecording: true,
      automation: {
        chrome: { status: "granted", updatedAt: null, reason: null },
        safari: { status: "granted", updatedAt: null, reason: null },
      },
    },
    status: "online",
    lastSeenAt: "2026-08-01T01:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

export function sidebarThreadLinks(): HTMLAnchorElement[] {
  const chatListColumn = document.querySelector<HTMLElement>(
    '[data-testid="chat-list-column"]',
  );
  if (!chatListColumn) {
    return [];
  }
  return queryAllByRoleFast("link", chatListColumn).filter(
    (candidate): candidate is HTMLAnchorElement => {
      return Object.hasOwn(candidate.dataset, "sidebarChatThreadId");
    },
  );
}

export function sidebarThreadTitles(): string[] {
  return sidebarThreadLinks().map((link) => {
    return (
      link
        .querySelector('[data-slot="sidebar-thread-title"]')
        ?.textContent?.replace(/\s+/gu, " ")
        .trim() ?? ""
    );
  });
}

export function fastButton(
  name: string,
  container: ParentNode = document,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button ${name}`);
  }
  return button;
}

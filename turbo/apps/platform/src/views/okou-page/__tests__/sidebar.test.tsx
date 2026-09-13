import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { compile } from "tailwindcss";
import { expect, test, vi } from "vitest";

import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadEventsContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { computerUseHostsContract } from "@okouai/api-contracts/contracts/computer-use";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  avatarComposerUrl,
  DEFAULT_AGENT_AVATAR_URL,
} from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  click,
  setupPage,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import type { ChatThreadEventQueryResult } from "../../../shared-database/data-key.ts";
import { emptySearchImg } from "../platform-assets.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { CHAT_THREAD_VIRTUAL_ROW_HEIGHT } from "../../../signals/okou-page/sidebar-state.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { mockChatEventRows } from "./chat-event-test-helpers.ts";
import {
  changeChatThreadList,
  changeChatThreadReadCursor,
} from "../../../mocks/mock-helpers.ts";

// The composer editor is mounted on first paint and mounted again once page
// bootstrap settles, so an element captured too early is detached before a test
// can drive it. Keyboard events on a detached editor are silently dropped.
function mountedComposer(): HTMLElement {
  const composer = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Composer editor is not mounted");
  }
  return composer;
}

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";
const RESEARCH_THREAD_ID = "b0000000-0000-4000-a000-000000000005";
const LAYERED_AVATAR_URL = avatarComposerUrl({
  face: "round",
  hair: "curly-cap",
  expression: "calm",
  skin: "light",
  hairColor: "blue",
  sweater: "lime",
});

interface SidebarThread {
  readonly id: string;
  readonly title: string | null;
  readonly agent: { readonly id: string; readonly avatarUrl: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly renamedAt?: string | null;
  /** Overrides the ordering-derived `sortAt` when a test asserts on its age. */
  readonly sortAt?: string;
}

function prepareDefaultAgent(
  targetContext = context,
  avatarUrl: string | null = null,
): void {
  targetContext.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl,
      visibility: "public",
    },
  ]);
}

function prepareAgents(targetContext = context): AgentResponse[] {
  const agents: AgentResponse[] = [
    {
      isDefaultAgent: false,
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
    {
      isDefaultAgent: false,
      agentId: RESEARCH_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Research Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
    {
      isDefaultAgent: false,
      agentId: SUPPORT_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Support Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
  ];
  targetContext.mocks.data.agents(agents);
  targetContext.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const displayNameById: Record<string, string> = {
      [AGENT_ID]: "Nova",
      [RESEARCH_AGENT_ID]: "Research Agent",
      [SUPPORT_AGENT_ID]: "Support Agent",
    };
    return respond(200, {
      isDefaultAgent: false,
      agentId: params.id,
      ownerId: "test-user-123",
      description: null,
      displayName: displayNameById[params.id] ?? null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
  return agents;
}

const OVERFLOW_PINNED_AGENTS = [
  {
    agentId: "c0000000-0000-4000-a000-000000000004",
    displayName: "Operations Agent",
  },
  {
    agentId: "c0000000-0000-4000-a000-000000000005",
    displayName: "Analytics Agent",
  },
  {
    agentId: "c0000000-0000-4000-a000-000000000006",
    displayName: "Billing Agent",
  },
] as const;

/**
 * Pins five agents so the grid holds six cards plus Pin, which overflows the
 * five-column row and puts cards on both sides of the Pin button.
 */
function prepareOverflowingPinnedAgents(
  targetContext = context,
  supportAvatarUrl: string | null = null,
): string[] {
  const agents = prepareAgents(targetContext);
  const agentsWithAvatar = agents.map((agent) => {
    return agent.agentId === SUPPORT_AGENT_ID
      ? { ...agent, avatarUrl: supportAvatarUrl }
      : agent;
  });
  const templateAgent = agents[1];
  if (!templateAgent) {
    throw new Error("Pinned-agent template is unavailable");
  }
  targetContext.mocks.data.agents([
    ...agentsWithAvatar,
    ...OVERFLOW_PINNED_AGENTS.map((agent) => {
      return {
        ...templateAgent,
        agentId: agent.agentId,
        displayName: agent.displayName,
      };
    }),
  ]);
  return [
    RESEARCH_AGENT_ID,
    SUPPORT_AGENT_ID,
    ...OVERFLOW_PINNED_AGENTS.map((agent) => {
      return agent.agentId;
    }),
  ];
}

function createThread(
  id: string,
  title: string,
  overrides: Partial<SidebarThread> = {},
): SidebarThread {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    pinnedAt: null,
    ...overrides,
  };
}

function sidebarThreadSnapshot(
  threads: readonly SidebarThread[],
): NonNullable<ChatThreadEventQueryResult["snapshot"]> {
  return {
    chatThreads: threads.map((thread, index) => {
      return {
        id: thread.id,
        agentId: thread.agent.id,
        title: thread.title,
        sortAt:
          thread.sortAt ??
          new Date(
            Date.parse("2026-03-10T00:00:00Z") +
              (threads.length - index) * 1000,
          ).toISOString(),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        pinnedAt: thread.pinnedAt ?? null,
        renamedAt: thread.renamedAt ?? null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
        selectedVideoModel: null,
      };
    }),
    latestEventId: null,
    latestSeqId: null,
  };
}

function mockChatThreadSnapshot(
  threads: () => readonly SidebarThread[],
  activeThreadIds: () => readonly string[] = () => {
    return [];
  },
  targetContext = context,
  remoteGate?: Promise<void>,
): void {
  targetContext.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await remoteGate;
    return respond(200, sidebarThreadSnapshot(threads()));
  });
  targetContext.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  targetContext.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: Object.fromEntries(
        activeThreadIds().map((threadId) => {
          return [threadId, "active" as const];
        }),
      ),
    });
  });
  targetContext.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  targetContext.mocks.api(computerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });
}

function mockUnreadAgents(
  unreadAgentIds: () => readonly string[],
  onRequest: () => void = () => {},
): void {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    onRequest();
    return respond(200, {
      agents: Object.fromEntries(
        unreadAgentIds().map((agentId) => {
          return [agentId, "unread" as const];
        }),
      ),
      threads: {},
    });
  });
}

function menuItemByText(text: string): HTMLElement {
  const item = queryMenuItemByText(text);
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function queryMenuItemByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitem").find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === text ||
        candidate.textContent?.replace(/\s+/g, " ").trim() === text
      );
    }) ?? null
  );
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function buttonByLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function sidebar(): HTMLElement {
  return screen.getByTestId("chat-list-column");
}

function queryMobileSidebar(): HTMLElement | null {
  return screen.queryByRole("complementary", { name: "Sidebar" });
}

function mobileSidebar(): HTMLElement {
  const drawer = queryMobileSidebar();
  if (!drawer) {
    throw new Error("Mobile sidebar not found");
  }
  return drawer;
}

function mockMobileLayout() {
  return context.mocks.browser.matchMedia(false);
}

function pinnedAgentLink(
  container: HTMLElement,
  name: string,
): HTMLAnchorElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`${name} pinned agent link not found`);
  }
  return link;
}

function setupSidebarPage(
  options: Parameters<typeof setupPage>[0],
): Promise<void> {
  return setupPage(options);
}

function pinnedAgentNames(container: HTMLElement): string[] {
  return within(container)
    .getAllByTestId("pinned-agent-card")
    .map((card) => {
      return card.textContent?.trim() ?? "";
    });
}

/** Names of the given agents as the dialog lists them, in rendered order. */
function dialogAgentOrder(
  dialog: HTMLElement,
  names: readonly string[],
): string[] {
  return within(dialog)
    .getAllByRole("option")
    .map((option) => {
      return names.find((name) => {
        return option.textContent?.replace(/\s+/g, " ").trim().startsWith(name);
      });
    })
    .filter((name): name is string => {
      return name !== undefined;
    });
}

function commandItemByText(container: HTMLElement, text: string): HTMLElement {
  const item = within(container)
    .getAllByRole("option")
    .find((candidate) => {
      return candidate.textContent
        ?.replace(/\s+/g, " ")
        .trim()
        .startsWith(text);
    });
  if (!item) {
    throw new Error(`${text} command item not found`);
  }
  return item;
}

/**
 * jsdom does not implement DataTransfer, so drag events need a stub that keeps
 * the payload the pinned grid writes on drag start.
 */
interface DragImageSnapshot {
  readonly width: string;
  readonly height: string;
  readonly renderedImageLayerCount: number;
}

interface DataTransferStub extends DataTransfer {
  readonly dragImage: DragImageSnapshot | null;
}

function createDataTransferStub(
  initialValues: Readonly<Record<string, string>> = {},
): DataTransferStub {
  let values = new Map<string, string>(Object.entries(initialValues));
  let dragImage: DragImageSnapshot | null = null;
  return {
    get dragImage() {
      return dragImage;
    },
    effectAllowed: "none",
    dropEffect: "none",
    clearData: (format?: string) => {
      if (format === undefined) {
        values = new Map<string, string>();
        return;
      }
      values.delete(format);
    },
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    getData: (format: string) => {
      return values.get(format) ?? "";
    },
    setDragImage: (image: Element) => {
      if (!(image instanceof HTMLElement)) {
        throw new Error("Drag image must be an HTML element");
      }
      const style = getComputedStyle(image);
      const renderedImageLayerCount = Array.from(
        image.querySelectorAll("img"),
      ).filter((layer) => {
        const layerStyle = getComputedStyle(layer);
        return (
          layerStyle.display !== "none" &&
          layerStyle.visibility !== "hidden" &&
          layerStyle.opacity !== "0"
        );
      }).length;
      dragImage = {
        width: style.width,
        height: style.height,
        renderedImageLayerCount,
      };
    },
  } as unknown as DataTransferStub;
}

async function renderTailwindUtilities(
  signal: AbortSignal,
  ...elements: readonly HTMLElement[]
): Promise<void> {
  const compiler = await compile(`
    @theme {
      --spacing: 0.25rem;
    }
    @tailwind utilities;
  `);
  const classNames = new Set<string>();
  for (const element of elements) {
    for (const candidate of [
      element,
      ...element.querySelectorAll<HTMLElement>("[class]"),
    ]) {
      for (const className of candidate.classList) {
        classNames.add(className);
      }
    }
  }
  const styleElement = document.createElement("style");
  styleElement.textContent = compiler
    .build([...classNames])
    .replaceAll("calc(var(--spacing) * 9)", "36px")
    .replaceAll("calc(infinity * 1px)", "9999px");
  document.head.append(styleElement);
  signal.addEventListener(
    "abort",
    () => {
      styleElement.remove();
    },
    { once: true },
  );
}

const SIDEBAR_TITLE_BOX_WIDTH = 160;
const SIDEBAR_TITLE_CHARACTER_WIDTH = 9;

function restoreElementProperty(
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
    return;
  }
  Reflect.deleteProperty(HTMLElement.prototype, name);
}

/** The clipping box a sidebar thread title is faded and scrolled inside. */
function isSidebarTitleBox(element: HTMLElement): boolean {
  return element.dataset.slot === "sidebar-thread-title";
}

/**
 * Gives the title box a fixed width and its text a width per character, so one
 * title overflows the box and the other fits inside it.
 */
function stubSidebarTitleLayout(): void {
  const clientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );
  const scrollWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollWidth",
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement): number {
      return isSidebarTitleBox(this) ? SIDEBAR_TITLE_BOX_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement): number {
      if (!isSidebarTitleBox(this)) {
        return 0;
      }
      return Math.max(
        SIDEBAR_TITLE_BOX_WIDTH,
        (this.textContent?.length ?? 0) * SIDEBAR_TITLE_CHARACTER_WIDTH,
      );
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      restoreElementProperty("clientWidth", clientWidth);
      restoreElementProperty("scrollWidth", scrollWidth);
    },
    { once: true },
  );
}

/** The clipping box a title is faded and scrolled inside. */
function titleFadeBox(title: string): HTMLElement {
  const box = within(sidebar()).getByText(title).parentElement;
  if (!box) {
    throw new Error(`${title} title fade box not found`);
  }
  return box;
}

function threadRowByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = threadLinkByTitle(title, container);
  const row = link.parentElement;
  if (!row) {
    throw new Error(`${title} thread row not found`);
  }
  return row;
}

function threadLinkByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === title;
  });
  if (!link) {
    throw new Error(`${title} thread link not found`);
  }
  return link;
}

function visibleThreadTitles(expectedTitles: readonly string[]): string[] {
  const expected = new Set(expectedTitles);
  return queryAllByRoleFast("link", sidebar()).flatMap((candidate) => {
    const title = candidate.textContent?.replace(/\s+/g, " ").trim();
    return title && expected.has(title) ? [title] : [];
  });
}

function agentRowByName(container: HTMLElement, name: string): HTMLElement {
  const text = within(container).getByText(name);
  const row = text.closest(".group");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${name} agent row not found`);
  }
  return row;
}

function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

function openChatListMenu(): void {
  click(within(sidebar()).getByLabelText("Open chat list menu"));
}

function chatListNewChatButton(): HTMLElement {
  const menuButton = within(sidebar()).getByLabelText("Open chat list menu");
  const actions = menuButton.parentElement;
  if (!actions) {
    throw new Error("Chat list actions not found");
  }
  return within(actions).getByLabelText("New chat");
}

function mockSidebarViewport(height: number, scrollHeight: number): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement): number {
      return this.dataset.testid === "sidebar-scroll-area" ? height : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement): number {
      return this.dataset.testid === "sidebar-scroll-area" ? scrollHeight : 0;
    },
  );
}

function mockSidebarThreadStory(
  firstPageThreads: SidebarThread[],
  extraThreads: SidebarThread[] = [],
  activeThreadIds: readonly string[] = [],
  targetContext = context,
  remoteGate?: Promise<void>,
): ChatThreadEventQueryResult {
  let threads = [...firstPageThreads];

  mockChatThreadSnapshot(
    () => {
      return [...threads, ...extraThreads];
    },
    () => {
      return activeThreadIds;
    },
    targetContext,
    remoteGate,
  );

  targetContext.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  targetContext.mocks.api(chatThreadPinContract.pin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id
        ? { ...thread, pinnedAt: "2026-03-10T12:00:00Z" }
        : thread;
    });
    return respond(204);
  });
  targetContext.mocks.api(
    chatThreadUnpinContract.unpin,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id ? { ...thread, pinnedAt: null } : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadRenameContract.rename,
    ({ params, body, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id
          ? {
              ...thread,
              title: body.title,
              renamedAt: "2026-03-10T12:01:00Z",
            }
          : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
    chatThreadByIdContract.delete,
    ({ params, respond }) => {
      threads = threads.filter((thread) => {
        return thread.id !== params.id;
      });
      return respond(204);
    },
  );

  return {
    snapshot: sidebarThreadSnapshot([...threads, ...extraThreads]),
    events: [],
  };
}

function mockLongSidebarHistory(
  remoteGate?: Promise<void>,
): ChatThreadEventQueryResult {
  prepareDefaultAgent();
  const overflowThreads = Array.from({ length: 23 }, (_, index) => {
    return createThread(
      `b3000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Refresh overflow ${index + 1}`,
    );
  });
  return mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ...overflowThreads,
      createThread(ARCHIVED_THREAD_ID, "Archived context"),
    ],
    [],
    [],
    context,
    remoteGate,
  );
}

async function scrollToArchivedContext(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(threadLinkByTitle("Release plan")).toBeInTheDocument();
  });

  const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
  scrollArea.scrollTop = 780;
  fireEvent.scroll(scrollArea);

  await waitFor(() => {
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });
  expect(within(sidebar()).queryByText("Release plan")).toBeNull();
  expect(within(sidebar()).queryByText("Load more")).not.toBeInTheDocument();
  return scrollArea;
}

test("Browse a long sidebar chat history", async () => {
  const cachedChatThreadEvents = mockLongSidebarHistory();
  mockSidebarViewport(200, 1000);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    cachedChatThreadEvents,
  });

  const scrollArea = await scrollToArchivedContext();
  expect(scrollArea).toBeInTheDocument();
});

test("Refresh a long sidebar after deleting an offscreen chat", async () => {
  const remote = context.mocks.deferred<void>();
  const cachedChatThreadEvents = mockLongSidebarHistory(remote.promise);
  mockSidebarViewport(200, 1000);

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedChatThreadEvents,
  });

  // The existing-list scene must be usable before remote synchronization.
  const scrollArea = await scrollToArchivedContext();
  remote.resolve();
  openThreadMenu("Archived context");
  click(menuItemByText("Delete chat"));
  const dialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  click(buttonByText("Delete", dialog));

  // Model a browser-clamped live offset without another scroll event.
  scrollArea.scrollTop = 0;

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Archived context"),
    ).not.toBeInTheDocument();
  });
});

test("Align the current virtualized chat row with the sidebar scroll area top", async () => {
  prepareDefaultAgent();
  const leadingThreads = Array.from({ length: 24 }, (_, index) => {
    return createThread(
      `b3100000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Leading precise chat ${index + 1}`,
    );
  });
  mockSidebarThreadStory([
    ...leadingThreads,
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });

  const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
  const currentRow = threadLinkByTitle("Release plan").closest(
    '[data-testid="sidebar-chat-thread-virtual-row"]',
  );
  if (!(currentRow instanceof HTMLElement)) {
    throw new Error("Release plan virtual row not found");
  }
  const currentIndex = Number(currentRow.dataset.index);

  expect(scrollArea.scrollTop).toBe(
    currentIndex * CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  );
});

test("Delete a chat after reviewing the impact", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Delete chat"));

  const dialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  expect(
    within(dialog).getByText(
      "This will permanently delete this chat. Any task currently running in this chat will be stopped immediately. Any linked automations will be paused. This action cannot be undone.",
    ),
  ).toBeInTheDocument();

  click(buttonByText("Cancel", dialog));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Delete chat"));

  const confirmDialog = await screen.findByRole("dialog", {
    name: "Delete chat?",
  });
  click(buttonByText("Delete", confirmDialog));

  await waitFor(() => {
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });
});

/**
 * Deliberate exception to `docs/testing/testing-external-behavior.md`. The fade
 * and the hover travel are a mask and a transform derived from measured text
 * width, and happy-dom has no layout engine: it reports every box as
 * zero-width and paints nothing, so neither the state nor the result exists on
 * the page surface here. The measured distance is the only place the behavior
 * is observable, and it is worth pinning because both the fade and the travel
 * are derived from it — a wrong distance fades a title that fits, or stops the
 * scroll before the end.
 */
test("Fade a clipped chat title and pace its scroll by the hidden distance", async () => {
  stubSidebarTitleLayout();
  prepareDefaultAgent();
  mockSidebarThreadStory([
    // 26 characters, so 234px of text in a 160px box.
    createThread(EXISTING_THREAD_ID, "Quarterly launch narrative"),
    createThread(AUTOMATION_THREAD_ID, "Release plan"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await expect(
    within(sidebar()).findByText("Release plan"),
  ).resolves.toBeInTheDocument();

  const clipped = titleFadeBox("Quarterly launch narrative");
  expect(clipped.style.getPropertyValue("--okou-nav-title-overflow")).toBe(
    "74px",
  );
  expect(clipped.style.getPropertyValue("--okou-nav-title-duration")).toBe(
    "2000ms",
  );

  const fitting = titleFadeBox("Release plan");
  expect(fitting.style.getPropertyValue("--okou-nav-title-overflow")).toBe(
    "0px",
  );
  expect(fitting.style.getPropertyValue("--okou-nav-title-duration")).toBe(
    "780ms",
  );
});

test("Filter the chat list to unread conversations", async () => {
  prepareDefaultAgent();
  const pinnedUnreadThread = createThread(
    AUTOMATION_THREAD_ID,
    "Pinned incident",
    {
      pinnedAt: "2026-03-10T12:00:00Z",
    },
  );
  const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
  const unreadThread = createThread(INCIDENT_THREAD_ID, "Incident notes");
  const archivedThread = createThread(ARCHIVED_THREAD_ID, "Archived context");
  const allThreads = [
    pinnedUnreadThread,
    currentThread,
    unreadThread,
    archivedThread,
  ];
  mockChatThreadSnapshot(() => {
    return allThreads;
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        {
          threadId: AUTOMATION_THREAD_ID,
          unreadAt: "2026-03-10T00:04:00Z",
        },
        { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
      ],
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });

  openChatListMenu();
  click(menuItemByText("Unread only"));

  await waitFor(() => {
    expect(
      visibleThreadTitles(["Pinned incident", "Incident notes"]),
    ).toStrictEqual(["Pinned incident", "Incident notes"]);
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Archived context"),
    ).not.toBeInTheDocument();
  });
});

test("Find conversations by title in workspace search", async () => {
  prepareAgents();
  const defaultThread = createThread(EXISTING_THREAD_ID, "Incident notes");
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });
  const supportThread = createThread(INCIDENT_THREAD_ID, "Support escalation", {
    agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
  });
  mockSidebarThreadStory(
    [defaultThread, researchThread, supportThread],
    [],
    [INCIDENT_THREAD_ID],
  );
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        {
          threadId: EXISTING_THREAD_ID,
          unreadAt: "2026-03-10T00:05:00Z",
        },
      ],
    });
  });

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  const search = within(dialog).getByPlaceholderText("Search workspace...");

  await fill(search, "research");

  await waitFor(() => {
    expect(within(dialog).getByText("Research kickoff")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Support escalation"),
    ).not.toBeInTheDocument();
  });

  await fill(search, "support");
  await waitFor(() => {
    expect(
      within(agentRowByName(dialog, "Support escalation")).getByLabelText(
        "Running",
      ),
    ).toBeInTheDocument();
  });
  click(within(dialog).getByText("Support escalation"));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Support escalation | Okou");
  });
});

test("Hide and show the chat list without losing workspace search", async () => {
  prepareDefaultAgent();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByPlaceholderText(PLACEHOLDER);
  const rail = await screen.findByTestId("labeled-nav-rail");
  const list = screen.getByTestId("chat-list-column");
  const hideButton = within(list).getByLabelText("Hide chat list");
  expect(hideButton).toHaveAttribute("aria-keyshortcuts", "Meta+B Control+B");

  click(hideButton);

  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  });
  expect(rail).toBeInTheDocument();
  const showButton = within(rail).getByLabelText("Show chat list");
  expect(showButton).toHaveAttribute("aria-keyshortcuts", "Meta+B Control+B");

  const composer = mountedComposer();
  composer.focus();
  const searchEvent = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(searchEvent);

  expect(searchEvent.defaultPrevented).toBeTruthy();
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
  });

  const restoredComposer = mountedComposer();
  restoredComposer.focus();
  fireEvent.keyDown(restoredComposer, {
    key: "b",
    code: "KeyB",
    keyCode: 66,
    ctrlKey: true,
  });

  await waitFor(() => {
    expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
    expect(
      within(rail).queryByLabelText("Show chat list"),
    ).not.toBeInTheDocument();
  });
});

test("Keep chat navigation usable while secondary data is unavailable", async () => {
  prepareDefaultAgent();
  const indicatorResponse = context.mocks.deferred<void>();
  const draftResponse = context.mocks.deferred<void>();
  const draftRequestStarted = context.mocks.deferred<void>();
  const draftResponseReturned = context.mocks.deferred<void>();
  const cachedChatThreadEvents = mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    await indicatorResponse.promise;
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadsContract.drafts, async ({ respond }) => {
    draftRequestStarted.resolve();
    await draftResponse.promise;
    const response = respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Draft membership unavailable",
      },
    });
    draftResponseReturned.resolve();
    return response;
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    cachedChatThreadEvents,
  });

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Existing conversation"),
    ).toBeInTheDocument();
    expect(
      sidebar().querySelectorAll('[data-testid="sidebar-skeleton"]'),
    ).toHaveLength(0);
  });
  expect(
    within(threadRowByTitle("Existing conversation")).queryByLabelText(
      "Running",
    ),
  ).not.toBeInTheDocument();

  indicatorResponse.resolve();
  await draftRequestStarted.promise;
  draftResponse.resolve();
  await draftResponseReturned.promise;
  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Existing conversation"),
    ).toBeInTheDocument();
  });
  expect(chatListNewChatButton()).toBeInTheDocument();
  openChatListMenu();
  expect(queryMenuItemByText("New chat")).not.toBeInTheDocument();
  expect(menuItemByText("All chats")).toBeInTheDocument();
  expect(menuItemByText("Unread only")).toBeInTheDocument();
});

test("Mount only the sidebar for the current viewport", async () => {
  prepareDefaultAgent();
  const mediaQuery = mockMobileLayout();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);

  act(() => {
    mediaQuery.setMatches(true);
  });

  await waitFor(() => {
    expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();
    expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
  });
  expect(queryMobileSidebar()).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Open menu")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);

  act(() => {
    mediaQuery.setMatches(false);
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);
});

test("Keep pin management usable with many pinned agents", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents();
  const preferencesGate = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, async ({ respond }) => {
    await preferencesGate.promise;
    return respond(200, {
      timezone: null,
      locale: null,
      translationLanguage: null,
      supportedLocales: [
        "en-US",
        "pt-BR",
        "ja-JP",
        "ko-KR",
        "id-ID",
        "de-DE",
        "es-ES",
        "it-IT",
        "fr-FR",
        "hi-IN",
      ],
      pinnedAgentIds,
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: "system",
      colorTheme: "blue-horizon",
      captureNetworkBodiesRemaining: 0,
      voiceInputModel: null,
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const pinnedSection = await screen.findByTestId("pinned-agents-horizontal");
  const grid = within(pinnedSection).getByTestId("pinned-agents-grid");
  expect(within(pinnedSection).getByText("Pinned agents")).toBeVisible();
  expect(within(grid).getByTestId("pinned-agent-skeleton")).toBeVisible();
  expect(within(grid).queryByTestId("pinned-agent-card")).toBeNull();
  expect(within(grid).queryByLabelText("Pin an agent")).toBeNull();

  preferencesGate.resolve();

  await waitFor(() => {
    expect(within(grid).queryByTestId("pinned-agent-skeleton")).toBeNull();
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    expect(buttonByLabel("Pin an agent", grid)).toBeVisible();
  });
  expect(
    queryAllByRoleFast("link", grid).map((link) => {
      return link.textContent?.trim();
    }),
  ).toStrictEqual([
    "Nova",
    "Research Agent",
    "Support Agent",
    "Operations Agent",
    "Analytics Agent",
    "Billing Agent",
  ]);

  const pinAgent = queryAllByRoleFast("button", grid).find((candidate) => {
    return candidate.getAttribute("aria-label") === "Pin an agent";
  });
  if (!pinAgent) {
    throw new Error("Pin agent button not found");
  }
  // Cards render as Nova, Research, Support, Operations, Pin, Analytics,
  // Billing, so Pin closes the first row and the rest wrap after it.
  const fourthAgent = pinnedAgentLink(grid, "Operations Agent");
  const fifthAgent = pinnedAgentLink(grid, "Analytics Agent");

  expect(
    fourthAgent.compareDocumentPosition(pinAgent) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    pinAgent.compareDocumentPosition(fifthAgent) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("Keep pinned agents and the chat heading visible while conversations scroll", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const overflowThreads = Array.from({ length: 23 }, (_, index) => {
    return createThread(
      `b2500000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Switched overflow ${index + 1}`,
    );
  });
  mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ],
    [...overflowThreads, createThread(ARCHIVED_THREAD_ID, "Archived context")],
  );

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Research Agent")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
    ).toBeInTheDocument();
  });

  const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
  const pinnedHeader = within(sidebar()).getByTestId(
    "pinned-agents-horizontal",
  );
  const pinnedAgent = within(pinnedHeader).getByText("Research Agent");
  const chatTitle = within(sidebar()).getByText("Chats with Nova");
  expect(scrollArea).not.toContainElement(pinnedHeader);
  expect(scrollArea).not.toContainElement(pinnedAgent);
  expect(scrollArea).not.toContainElement(chatTitle);
  expect(scrollArea).toContainElement(threadLinkByTitle("Release plan"));

  Object.defineProperty(scrollArea, "clientHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(scrollArea, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(scrollArea, "scrollTop", {
    configurable: true,
    value: 780,
  });
  fireEvent.scroll(scrollArea);

  await waitFor(() => {
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });
});

test("Route New chat to the current agent and Chat to the default agent", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Research conversation", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  await screen.findByPlaceholderText(PLACEHOLDER);
  expect(
    within(screen.getByTestId("chat-list-column")).getByText(
      "Research conversation",
    ),
  ).toBeInTheDocument();
  await screen.findByText("Chats with Research Agent");

  const list = screen.getByTestId("chat-list-column");
  const searchButton = within(list).getByLabelText("Search workspace");
  if (!searchButton.parentElement) {
    throw new Error("Chat header not found");
  }
  click(within(searchButton.parentElement).getByLabelText("New chat"));

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(chatLink).toHaveAttribute("href", `/agents/${AGENT_ID}/chat`);
  click(chatLink);

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
});

test("Locate the current chat in a long sidebar history", async () => {
  prepareDefaultAgent();
  const leadingThreads = Array.from({ length: 24 }, (_, index) => {
    return createThread(
      `b3050000-0000-4000-a000-${String(index).padStart(12, "0")}`,
      `Three-column leading chat ${index + 1}`,
    );
  });
  mockSidebarThreadStory([
    ...leadingThreads,
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  const desktopList = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(within(desktopList).getByText("Release plan")).toBeInTheDocument();
    expect(
      within(desktopList).getByTestId("sidebar-scroll-area").scrollTop,
    ).toBeGreaterThan(0);
  });
});

test("Mark all current-agent chats read from the chat-list menu", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
    createThread(INCIDENT_THREAD_ID, "Unread conversation"),
  ]);

  let hasUnread = true;
  const markedAgentIds: string[] = [];
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: hasUnread ? { [AGENT_ID]: "unread" } : {},
      threads: hasUnread ? { [INCIDENT_THREAD_ID]: "unread" } : {},
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: hasUnread
        ? [
            {
              threadId: INCIDENT_THREAD_ID,
              unreadAt: "2026-03-10T00:05:00Z",
            },
          ]
        : [],
    });
  });
  context.mocks.api(
    chatThreadMarkAgentReadContract.markAgentRead,
    ({ body, respond }) => {
      markedAgentIds.push(body.agentId);
      hasUnread = false;
      changeChatThreadReadCursor();
      return respond(204);
    },
  );

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(within(list).getByText("Unread conversation")).toBeInTheDocument();
    expect(within(list).getAllByLabelText("Unread").length).toBeGreaterThan(0);
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual(["Mark all read", "All chats", "Unread only"]);
  });
  const menuWithMarkAllRead =
    document.querySelector<HTMLElement>('[role="menu"]');
  if (!menuWithMarkAllRead) {
    throw new Error("Open chat list menu not found");
  }
  expect(
    menuWithMarkAllRead.querySelectorAll('[role="separator"]'),
  ).toHaveLength(1);
  click(menuItemByText("Mark all read"));

  await waitFor(() => {
    expect(markedAgentIds).toStrictEqual([AGENT_ID]);
    expect(within(list).queryByLabelText("Unread")).not.toBeInTheDocument();
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual(["All chats", "Unread only"]);
    const menuWithoutMarkAllRead =
      document.querySelector<HTMLElement>('[role="menu"]');
    if (!menuWithoutMarkAllRead) {
      throw new Error("Open chat list menu not found");
    }
    expect(
      menuWithoutMarkAllRead.querySelectorAll('[role="separator"]'),
    ).toHaveLength(0);
  });
});

test("Show mark all read in the mobile chat-list menu before conversations load", async () => {
  mockMobileLayout();
  prepareDefaultAgent();
  const remote = context.mocks.deferred<void>();
  mockSidebarThreadStory(
    [createThread(INCIDENT_THREAD_ID, "Unread conversation")],
    [],
    [],
    context,
    remote.promise,
  );
  mockUnreadAgents(() => {
    return [AGENT_ID];
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByRole("complementary", {
    name: "Sidebar",
  });
  expect(
    within(list).queryByText("Unread conversation"),
  ).not.toBeInTheDocument();
  click(within(list).getByLabelText("Open chat list menu"));

  await waitFor(() => {
    expect(menuItemByText("Mark all read")).toBeInTheDocument();
  });
  expect(
    within(list).queryByText("Unread conversation"),
  ).not.toBeInTheDocument();
  remote.resolve();
});

test("Mark all of an agent’s chats read", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });

  let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
  const markedAgentIds: string[] = [];
  mockUnreadAgents(() => {
    return unreadAgentIds;
  });
  context.mocks.api(
    chatThreadMarkAgentReadContract.markAgentRead,
    ({ body, respond }) => {
      markedAgentIds.push(body.agentId);
      unreadAgentIds = unreadAgentIds.filter((id) => {
        return id !== body.agentId;
      });
      changeChatThreadReadCursor();
      return respond(204);
    },
  );

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const nav = await waitFor(() => {
    const current = mobileSidebar();
    expect(within(current).getByText("Research Agent")).toBeInTheDocument();
    return current;
  });
  const researchSidebarRow = agentRowByName(nav, "Research Agent");
  // Unpinned agents appear after the Worker finishes loading unread indicators,
  // independently of the pinned-agent list above.
  const supportSidebarRow = await waitFor(() => {
    return agentRowByName(nav, "Support Agent");
  });
  await waitFor(() => {
    expect(
      within(researchSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  click(menuItemByText("Mark all read"));

  await waitFor(() => {
    expect(markedAgentIds).toStrictEqual([RESEARCH_AGENT_ID]);
    expect(
      within(researchSidebarRow).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
  expect(menuItemByText("Unpin")).toBeInTheDocument();
});

test("Mark conversations read and unread from the sidebar", async () => {
  prepareDefaultAgent();
  const unreadSnapshotRefreshed = context.mocks.deferred<void>();
  const markReadDeferred = context.mocks.deferred<void>();
  const markReadStarted = context.mocks.deferred<void>();
  const markReadCompleted = context.mocks.deferred<void>();
  const unreadThreadIds = new Set<string>();
  let unreadAt = "2026-03-10T00:05:00Z";
  let holdReleaseRead = false;
  const serverUnreads = () => {
    return [...unreadThreadIds].map((threadId) => {
      return { threadId, unreadAt };
    });
  };
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    const unreads = serverUnreads();
    if (
      unreadThreadIds.has(EXISTING_THREAD_ID) &&
      !unreadSnapshotRefreshed.settled()
    ) {
      unreadSnapshotRefreshed.resolve();
    }
    return respond(200, { unreads });
  });
  context.mocks.api(
    chatThreadMarkUnreadContract.markUnread,
    ({ params, respond }) => {
      unreadThreadIds.add(params.id);
      changeChatThreadReadCursor({
        threadId: params.id,
        agentId: AGENT_ID,
        lastReadAt: null,
      });
      return respond(200, {
        lastReadAt: null,
        unreads: serverUnreads(),
      });
    },
  );
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    async ({ params, respond }) => {
      unreadThreadIds.delete(params.id);
      if (params.id === EXISTING_THREAD_ID && holdReleaseRead) {
        markReadStarted.resolve();
        await markReadDeferred.promise;
        markReadCompleted.resolve();
      }
      return respond(200, {
        lastReadAt: "2026-03-10T00:05:00Z",
        unreads: serverUnreads(),
      });
    },
  );
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      return respond(
        200,
        chatEventRowsResponse(
          mockChatEventRows(
            params.threadId === EXISTING_THREAD_ID
              ? [
                  {
                    id: "release-message-1",
                    threadId: EXISTING_THREAD_ID,
                    eventType: "run.completed" as const,
                    runId: "mock-run",
                    content: null,
                    runLifecycleEvent: "completed" as const,
                    seqId: 1,
                    createdAt: "2026-03-10T00:05:00Z",
                  },
                ]
              : [],
          ).filter((row) => {
            return row.seqId > query.sinceSeqId;
          }),
          query,
        ),
      );
    },
  );
  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Mark unread"));
  await unreadSnapshotRefreshed.promise;
  expect(
    within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();

  click(threadLinkByTitle("Incident notes"));

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  holdReleaseRead = true;
  click(threadLinkByTitle("Release plan"));
  await markReadStarted.promise;
  click(threadLinkByTitle("Incident notes"));

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });

  markReadDeferred.resolve();
  await markReadCompleted.promise;

  unreadAt = "2026-03-10T00:06:00Z";
  unreadThreadIds.add(EXISTING_THREAD_ID);
  context.mocks.ably.trigger("chatThreadReadCursorUpdated", {
    threadId: EXISTING_THREAD_ID,
    agentId: AGENT_ID,
    lastReadAt: null,
  });

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
});

test("Move to the next relevant agent with a shortcut", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support escalation", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  mockUnreadAgents(() => {
    return [SUPPORT_AGENT_ID];
  });

  await setupSidebarPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}/chat`,
  });

  const nav = await waitFor(() => {
    const current = sidebar();
    expect(within(current).getByText("Support Agent")).toBeInTheDocument();
    return current;
  });
  expect(
    within(agentRowByName(nav, "Support Agent")).getByLabelText("Unread"),
  ).toBeInTheDocument();

  fireEvent.keyDown(document.body, {
    key: "}",
    ctrlKey: true,
    shiftKey: true,
  });

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    expect(
      within(sidebar()).getByText("Support escalation"),
    ).toBeInTheDocument();
  });
});

test("Navigate pinned agents from the mobile sidebar", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const openedTargets = context.mocks.browser.open();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(
      pinnedAgentLink(mobileSidebar(), "Research Agent"),
    ).toBeInTheDocument();
  });

  click(screen.getByLabelText("Open menu"));
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });

  fireEvent.click(pinnedAgentLink(mobileSidebar(), "Research Agent"), {
    metaKey: true,
  });
  await waitFor(() => {
    expect(openedTargets.calls).toStrictEqual([
      expect.objectContaining({
        target: "_blank",
        url: expect.stringContaining(`/agents/${RESEARCH_AGENT_ID}/chat`),
      }),
    ]);
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });

  click(pinnedAgentLink(mobileSidebar(), "Nova"));
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
  });

  click(screen.getByLabelText("Open menu"));
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  });

  click(pinnedAgentLink(mobileSidebar(), "Research Agent"));
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
  });
});

test("Open and use workspace search with the keyboard", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support escalation", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  const search = within(dialog).getByPlaceholderText("Search workspace...");

  await fill(search, "support");

  await waitFor(() => {
    expect(within(dialog).getByText("Support escalation")).toBeInTheDocument();
  });

  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Support escalation | Okou");
  });
});

test("Show current shortcuts without stacking help over workspace search", async () => {
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.VoiceInputV2]: true,
    },
  });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

  const shortcutDialog = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(
    within(shortcutDialog).getByText("Show shortcuts"),
  ).toBeInTheDocument();
  expect(within(shortcutDialog).getByText("Search workspace")).toBeVisible();
  expect(within(shortcutDialog).getByText("Voice input")).toBeVisible();
  click(within(shortcutDialog).getByLabelText("Close keyboard shortcuts"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Keyboard Shortcuts" }),
    ).not.toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

  expect(
    screen.queryByRole("dialog", { name: "Keyboard Shortcuts" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toStrictEqual([dialog]);
});

test("Open workspace search once from a focused composer shortcut", async () => {
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByPlaceholderText(PLACEHOLDER);
  const composer = mountedComposer();
  composer.focus();
  const repeatedEvent = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    repeat: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(repeatedEvent);

  expect(repeatedEvent.defaultPrevented).toBeFalsy();
  expect(
    screen.queryByRole("dialog", {
      name: "Search workspace...",
    }),
  ).not.toBeInTheDocument();

  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(event);

  expect(event.defaultPrevented).toBeTruthy();
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  expect(dialog).toBeInTheDocument();
});

test("Open workspace search from a mobile viewport", async () => {
  mockMobileLayout();
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  expect(dialog).toBeInTheDocument();
});

test("Pin and unpin agents without closing the pin manager", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds: [RESEARCH_AGENT_ID] });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(2);
  });

  click(screen.getByLabelText("Pin an agent"));

  const dialogList = await screen.findByTestId("pin-agent-dialog-list");
  const supportRow = commandItemByText(dialogList, "Support Agent");
  click(buttonByText("Pin", supportRow));

  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Research Agent",
      "Support Agent",
    ]);
  });
  expect(dialogList).toBeInTheDocument();
  expect(
    buttonByText("Unpin", commandItemByText(dialogList, "Support Agent")),
  ).toBeInTheDocument();
  await expect(
    screen.findByText("Support Agent pinned"),
  ).resolves.toBeInTheDocument();

  click(buttonByText("Unpin", commandItemByText(dialogList, "Support Agent")));

  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Research Agent"]);
  });
  expect(dialogList).toBeInTheDocument();
  expect(
    buttonByText("Pin", commandItemByText(dialogList, "Support Agent")),
  ).toBeInTheDocument();
  await expect(
    screen.findByText("Support Agent unpinned"),
  ).resolves.toBeInTheDocument();
});

test("Show pinned agents before unread indicators finish loading", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const indicatorRequestStarted = context.mocks.deferred<void>();
  const releaseIndicators = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    if (!indicatorRequestStarted.settled()) {
      indicatorRequestStarted.resolve(undefined);
    }
    await releaseIndicators.promise;
    return respond(200, {
      agents: { [SUPPORT_AGENT_ID]: "unread" },
      threads: {},
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await indicatorRequestStarted.promise;

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Research Agent"]);
  });

  releaseIndicators.resolve(undefined);
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Research Agent",
      "Support Agent",
    ]);
  });
});

test("Preserve the user’s pinned-agent order", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SUPPORT_AGENT_ID, RESEARCH_AGENT_ID],
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Support Agent",
      "Research Agent",
    ]);
  });

  click(screen.getByLabelText("Pin an agent"));

  const dialogList = await screen.findByTestId("pin-agent-dialog-list");
  expect(
    dialogAgentOrder(dialogList, ["Research Agent", "Support Agent"]),
  ).toStrictEqual(["Support Agent", "Research Agent"]);
});

test("Highlight the current thread’s agent in the pinned grid", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Research kickoff", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentLink(grid, "Research Agent")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(pinnedAgentLink(grid, "Nova")).not.toHaveAttribute("aria-current");
});

test("Recognize and pin sidebar conversation states", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory(
    [
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
      createThread(AUTOMATION_THREAD_ID, "Running analysis"),
      createThread(ARCHIVED_THREAD_ID, "Draft brief"),
    ],
    [],
    [AUTOMATION_THREAD_ID],
  );
  context.mocks.api(chatThreadsContract.drafts, ({ respond }) => {
    return respond(200, { draftThreadIds: [ARCHIVED_THREAD_ID] });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [
        { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
      ],
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    expect(
      within(threadRowByTitle("Incident notes")).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(threadRowByTitle("Running analysis")).getByLabelText("Running"),
    ).toBeInTheDocument();
    expect(
      within(threadRowByTitle("Draft brief")).getByLabelText("Draft"),
    ).toBeInTheDocument();
  });
  expect(
    within(threadRowByTitle("Incident notes")).getByLabelText("Unread"),
  ).toHaveAttribute("role", "img");
  expect(
    within(threadRowByTitle("Draft brief")).getByLabelText("Draft"),
  ).toHaveAttribute("role", "img");

  // Touch rows never hover, so the state indicator has to be the menu trigger
  // itself; otherwise running, unread, and draft chats lose every row action.
  for (const [title, label] of [
    ["Incident notes", "Unread"],
    ["Running analysis", "Running"],
    ["Draft brief", "Draft"],
  ] as const) {
    const row = threadRowByTitle(title);
    expect(
      within(row).getByTestId("chat-thread-menu-trigger"),
    ).toContainElement(within(row).getByLabelText(label));
  }

  openThreadMenu("Release plan");
  const pinItem = menuItemByText("Pin chat");
  expect(pinItem).toHaveTextContent("Ctrl+Shift+D");
  expect(pinItem).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+D Control+Shift+D",
  );
  click(pinItem);

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByTestId(
        "chat-thread-pinned-indicator",
      ),
    ).toBeInTheDocument();
  });

  click(
    within(threadRowByTitle("Release plan")).getByTestId(
      "chat-thread-pinned-indicator",
    ),
  );
  const unpinItem = menuItemByText("Unpin chat");
  expect(unpinItem).toHaveTextContent("Ctrl+Shift+D");
  click(unpinItem);

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).queryByTestId(
        "chat-thread-pinned-indicator",
      ),
    ).not.toBeInTheDocument();
  });

  openThreadMenu("Running analysis");
  const renameItem = menuItemByText("Rename chat");
  expect(renameItem).toHaveTextContent("F2");
  expect(renameItem).toHaveAttribute("aria-keyshortcuts", "F2");
  expect(menuItemByText("Delete chat")).toBeInTheDocument();
});

test.each(["agent", "thread"] as const)(
  "Refresh the %s unread indicator",
  async (indicator) => {
    mockMobileLayout();
    // Both consumers observe Nova and its thread; unrelated agents add no coverage.
    context.mocks.data.agents(
      prepareAgents().filter((agent) => {
        return agent.agentId === AGENT_ID;
      }),
    );
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Remote unread conversation"),
    ]);
    let hasUnread = false;
    let unreadIndicatorsLoaded = false;
    const unreadCatchUpReturned = context.mocks.deferred<void>();
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      unreadIndicatorsLoaded = hasUnread;
      return respond(200, {
        agents: hasUnread ? { [AGENT_ID]: "unread" } : {},
        threads: hasUnread ? { [EXISTING_THREAD_ID]: "unread" } : {},
      });
    });
    context.mocks.api(chatThreadEventsContract.catchUp, ({ body, respond }) => {
      const response = respond(200, {
        events: Object.fromEntries(
          body.map(([threadId]) => {
            return [threadId, []];
          }),
        ),
        notFoundThreads: [],
      });
      if (unreadIndicatorsLoaded && !unreadCatchUpReturned.settled()) {
        unreadCatchUpReturned.resolve(undefined);
      }
      return response;
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: hasUnread
          ? [
              {
                threadId: EXISTING_THREAD_ID,
                unreadAt: "2026-03-10T00:05:00Z",
              },
            ]
          : [],
      });
    });

    await setupSidebarPage({
      context,
      path: "/agents",
      sharedWorkerTestTransport: "message-port",
    });

    await waitFor(() => {
      const current = mobileSidebar();
      expect(within(current).getByText("Nova")).toBeInTheDocument();
    });
    // Both indicator consumers must finish loading before the external refresh.
    await waitFor(() => {
      expect(
        threadRowByTitle("Remote unread conversation", mobileSidebar()),
      ).toBeInTheDocument();
    });
    const indicatorRow = () => {
      return indicator === "agent"
        ? agentRowByName(mobileSidebar(), "Nova")
        : threadRowByTitle("Remote unread conversation", mobileSidebar());
    };
    await waitFor(() => {
      expect(within(indicatorRow()).queryByLabelText("Unread")).toBeNull();
    });

    hasUnread = true;
    changeChatThreadList();

    // Indicator delivery follows the throttled batch, which may start after a
    // trailing bootstrap request. Observe that response before checking the UI.
    await unreadCatchUpReturned.promise;
    await waitFor(() => {
      expect(
        within(indicatorRow()).getByLabelText("Unread"),
      ).toBeInTheDocument();
    });
  },
);

test("Rename a conversation from the sidebar", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Rename chat"));

  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const titleInput = within(dialog).getByPlaceholderText("Chat title");
  expect(titleInput).toHaveValue("Release plan");
  await fill(titleInput, "Launch plan");
  click(buttonByText("Rename", dialog));

  await waitFor(() => {
    expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
    expect(
      within(sidebar()).queryByText("Release plan"),
    ).not.toBeInTheDocument();
  });

  openThreadMenu("Incident notes");
  click(menuItemByText("Rename chat"));

  const draftDialog = await screen.findByRole("dialog", {
    name: "Rename chat",
  });
  const draftInput = within(draftDialog).getByPlaceholderText("Chat title");
  expect(draftInput).toHaveValue("Incident notes");
  await fill(draftInput, "Unsaved title");
  const finishCloseAnimation = holdElementAnimations(draftDialog);
  click(buttonByText("Cancel", draftDialog));

  expect(draftInput).toBeInTheDocument();
  expect(draftInput).toBeVisible();
  expect(draftInput).toHaveValue("Unsaved title");

  finishCloseAnimation();

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Rename chat" }),
    ).not.toBeInTheDocument();
  });

  openThreadMenu("Incident notes");
  click(menuItemByText("Rename chat"));

  const reopenedDialog = await screen.findByRole("dialog", {
    name: "Rename chat",
  });
  expect(within(reopenedDialog).getByPlaceholderText("Chat title")).toHaveValue(
    "Incident notes",
  );
});

test("Reorder pinned agents while keeping Nova first", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
  });
  expect(pinnedAgentNames(grid)).toStrictEqual([
    "Nova",
    "Research Agent",
    "Support Agent",
    "Operations Agent",
    "Analytics Agent",
    "Billing Agent",
  ]);

  const dragged = pinnedAgentLink(grid, "Support Agent");
  const target = pinnedAgentLink(grid, "Billing Agent");
  const dataTransfer = createDataTransferStub({
    "text/uri-list": dragged.href,
    "text/plain": dragged.href,
  });
  fireEvent.dragStart(dragged, { dataTransfer });
  expect(dataTransfer.getData("text/uri-list")).toBe("");
  expect(dataTransfer.getData("text/plain")).toBe("");
  expect(dataTransfer.getData("application/x-okou-pinned-agent")).toBe(
    SUPPORT_AGENT_ID,
  );
  fireEvent.dragOver(target, { dataTransfer });
  await waitFor(() => {
    expect(
      within(target).getByTestId("pinned-agent-drop-caret"),
    ).toBeInTheDocument();
  });
  expect(
    within(target).getByTestId("pinned-agent-drop-caret").className,
  ).toContain("-right-");
  fireEvent.drop(target, { dataTransfer });

  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Nova",
      "Research Agent",
      "Operations Agent",
      "Analytics Agent",
      "Billing Agent",
      "Support Agent",
    ]);
  });

  const orderAfterReorder = pinnedAgentNames(grid);
  const lead = pinnedAgentLink(grid, "Nova");
  const leadDropTransfer = createDataTransferStub();
  fireEvent.dragStart(pinnedAgentLink(grid, "Research Agent"), {
    dataTransfer: leadDropTransfer,
  });
  expect(
    fireEvent.dragOver(lead, { dataTransfer: leadDropTransfer }),
  ).toBeFalsy();
  expect(fireEvent.drop(lead, { dataTransfer: leadDropTransfer })).toBeFalsy();
  fireEvent.dragEnd(pinnedAgentLink(grid, "Research Agent"), {
    dataTransfer: leadDropTransfer,
  });
  expect(pinnedAgentNames(grid)).toStrictEqual(orderAfterReorder);
  expect(pinnedAgentLink(grid, "Nova")).toBeInTheDocument();
});

test("Keep the default Okou sweater outside a circular mask", async () => {
  prepareDefaultAgent(context, DEFAULT_AGENT_AVATAR_URL);

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  const avatar = grid.querySelector(`img[src="${DEFAULT_AGENT_AVATAR_URL}"]`);
  if (!(avatar instanceof HTMLImageElement)) {
    throw new Error("Default Okou avatar not found");
  }
  await renderTailwindUtilities(context.signal, avatar);
  expect(getComputedStyle(avatar).borderRadius).toBe("");
});

test("Render the complete layered drag image with grab feedback", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents(
    context,
    LAYERED_AVATAR_URL,
  );
  context.mocks.data.userPreferences({ pinnedAgentIds });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.AvatarNeckSweater]: true,
    },
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
  });

  const dragged = pinnedAgentLink(grid, "Support Agent");
  const avatar = dragged.querySelector('[data-slot="pinned-agent-avatar"]');
  if (!(avatar instanceof HTMLElement)) {
    throw new Error("Pinned-agent avatar not found");
  }
  const avatarLayers = avatar.querySelectorAll("img");
  const topAvatarLayer = avatarLayers.item(avatarLayers.length - 1);
  if (!(topAvatarLayer instanceof HTMLImageElement)) {
    throw new Error("Layered pinned-agent avatar not found");
  }
  await renderTailwindUtilities(context.signal, dragged, avatar);
  const dataTransfer = createDataTransferStub();

  expect(getComputedStyle(dragged).cursor).toBe("grab");

  fireEvent.dragStart(topAvatarLayer, { dataTransfer });

  expect(dataTransfer.dragImage).toStrictEqual({
    width: "36px",
    height: "36px",
    renderedImageLayerCount: avatarLayers.length,
  });
  expect(dataTransfer.dragImage?.renderedImageLayerCount).toBeGreaterThan(1);
});

test("Search, pin, and open an agent from the pin manager", async () => {
  prepareAgents();
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });

  mockChatThreadSnapshot(() => {
    return [researchThread];
  });

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const grid = await screen.findByTestId("pinned-agents-grid");
  click(screen.getByLabelText("Pin an agent"));

  const dialog = await screen.findByRole("dialog", { name: "Pin an agent" });
  expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();

  await fill(
    within(dialog).getByPlaceholderText("Search agents..."),
    "support",
  );

  await waitFor(() => {
    expect(
      within(dialog).queryByText("Research Agent"),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  });

  await fill(within(dialog).getByPlaceholderText("Search agents..."), "ops");

  await waitFor(() => {
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
    expect(within(dialog).queryByText("Support Agent")).not.toBeInTheDocument();
  });

  click(within(dialog).getByLabelText("Clear search"));

  await waitFor(() => {
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  });

  const researchRow = commandItemByText(dialog, "Research Agent");
  click(buttonByText("Pin", researchRow));

  await waitFor(() => {
    expect(
      buttonByText("Unpin", commandItemByText(dialog, "Research Agent")),
    ).toBeInTheDocument();
    expect(pinnedAgentNames(grid)).toContain("Research Agent");
  });

  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Pin an agent" }),
    ).not.toBeInTheDocument();
  });
  click(pinnedAgentLink(grid, "Research Agent"));

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Chats with Research Agent"),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
});

test("Search workspace chats and messages", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Deployment notes", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
    createThread(INCIDENT_THREAD_ID, "Incident response", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results:
        query.keyword === "deploy"
          ? [
              {
                chatThreadId: INCIDENT_THREAD_ID,
                agentName: "Support Agent",
                matchedMessage: {
                  chatThreadId: INCIDENT_THREAD_ID,
                  role: "user" as const,
                  content: "Production deploy completed successfully",
                  createdAt: "2026-03-10T00:10:00Z",
                  seqId: 1,
                  runId: null,
                },
                matchedRanges: [{ start: 11, end: 17 }],
              },
            ]
          : [],
    });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  click(within(list).getByLabelText("Search workspace"));

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "deploy",
  );

  await waitFor(() => {
    expect(within(dialog).getByText("2 results")).toBeInTheDocument();
    expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
    expect(within(dialog).getByText("Incident response")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Research Agent"),
    ).not.toBeInTheDocument();
  });

  click(buttonByText("Messages", dialog));
  expect(
    within(dialog).queryByText("Deployment notes"),
  ).not.toBeInTheDocument();
  expect(within(dialog).getByText("Incident response")).toBeInTheDocument();

  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "missing",
  );
  await waitFor(() => {
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
    expect(within(dialog).getByText("0 results")).toBeInTheDocument();
  });

  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "deploy",
  );
  click(buttonByText("Chats", dialog));
  await waitFor(() => {
    expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Incident response"),
    ).not.toBeInTheDocument();
  });

  click(within(dialog).getByText("Deployment notes"));
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${RESEARCH_THREAD_ID}`);
    expect(
      screen.queryByRole("dialog", {
        name: "Search workspace...",
      }),
    ).not.toBeInTheDocument();
  });
});

test("Show unread agents and contextual actions in the pinned section", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });

  let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
  mockUnreadAgents(() => {
    return unreadAgentIds;
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
  });

  const nav = await waitFor(() => {
    const current = mobileSidebar();
    expect(within(current).getByText("Research Agent")).toBeInTheDocument();
    return current;
  });
  const researchSidebarRow = agentRowByName(nav, "Research Agent");
  const supportSidebarRow = await waitFor(() => {
    return agentRowByName(nav, "Support Agent");
  });
  await waitFor(() => {
    expect(
      within(researchSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(researchSidebarRow).getByLabelText("Open agent menu"),
    ).toBeInTheDocument();
    expect(
      within(researchSidebarRow).queryByLabelText("Unpin"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(supportSidebarRow).getByLabelText("Open agent menu"));
  expect(menuItemByText("Mark all read")).toBeInTheDocument();
  expect(menuItemByText("Pin to sidebar")).toBeInTheDocument();
  expect(queryMenuItemByText("Unpin")).not.toBeInTheDocument();
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  expect(menuItemByText("Unpin")).toBeInTheDocument();
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

  unreadAgentIds = [SUPPORT_AGENT_ID];
  changeChatThreadReadCursor({
    agentId: RESEARCH_AGENT_ID,
  });

  await waitFor(() => {
    expect(
      within(researchSidebarRow).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
});

test("Show useful search-result ages and an illustrated empty state", async () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  mockNow(now, context.signal);
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Minutes old", {
      sortAt: new Date(now - 5 * 60 * 1000).toISOString(),
    }),
    createThread(INCIDENT_THREAD_ID, "Hours old", {
      sortAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    }),
    createThread(AUTOMATION_THREAD_ID, "Days old", {
      sortAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    createThread(ARCHIVED_THREAD_ID, "Older than a month", {
      sortAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  ]);
  context.mocks.api(chatSearchContract.search, ({ respond }) => {
    return respond(200, { results: [] });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  click(within(list).getByLabelText("Search workspace"));

  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });

  const rowFor = async (title: string): Promise<HTMLElement> => {
    const row = (await within(dialog).findByText(title)).closest(
      '[role="option"]',
    );
    if (!(row instanceof HTMLElement)) {
      throw new Error(`no spotlight row for ${title}`);
    }
    return row;
  };

  const minutesRow = await rowFor("Minutes old");
  expect(minutesRow).toHaveTextContent("5 minutes ago");
  const hoursRow = await rowFor("Hours old");
  expect(hoursRow).toHaveTextContent("3 hours ago");
  const daysRow = await rowFor("Days old");
  expect(daysRow).toHaveTextContent("2 days ago");

  // Past a month a relative phrase stops helping, so the row shows the
  // absolute date instead. Assert the shape rather than an exact string so
  // the expectation does not depend on the runner's timezone.
  const archived = await rowFor("Older than a month");
  expect(archived).not.toHaveTextContent("ago");
  expect(archived).toHaveTextContent(/[A-Z][a-z]{2} \d{1,2},/u);

  await fill(
    within(dialog).getByPlaceholderText("Search workspace..."),
    "nothing matches this",
  );

  await waitFor(() => {
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
  });
  expect(within(dialog).queryByText("Minutes old")).not.toBeInTheDocument();
  const emptyState = within(dialog)
    .getByText("No results found")
    .closest("div");
  expect(emptyState?.querySelector("img")).toHaveAttribute(
    "src",
    emptySearchImg,
  );
});

test("Update the existing chat list when switching agents", async () => {
  prepareAgents();
  const supportUnreadGate = context.mocks.deferred<void>();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });
  const supportThread = createThread(INCIDENT_THREAD_ID, "Support escalation", {
    agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
  });
  const olderSupportThread = createThread(
    AUTOMATION_THREAD_ID,
    "Support archive",
    {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    },
  );
  mockSidebarThreadStory([researchThread, supportThread, olderSupportThread]);
  context.mocks.api(chatThreadsContract.unreads, async ({ query, respond }) => {
    if (query.agentId === SUPPORT_AGENT_ID) {
      await supportUnreadGate.promise;
    }
    const threadId =
      query.agentId === SUPPORT_AGENT_ID
        ? INCIDENT_THREAD_ID
        : RESEARCH_THREAD_ID;
    return respond(200, {
      unreads: [
        {
          threadId,
          unreadAt: "2026-03-10T00:05:00Z",
        },
      ],
    });
  });

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
  openChatListMenu();
  click(menuItemByText("Unread only"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
  const chatList = within(sidebar()).getByLabelText("Chat threads");

  fireEvent.keyDown(document.body, {
    key: "}",
    ctrlKey: true,
    shiftKey: true,
  });

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    expect(
      within(sidebar()).queryByText("Research kickoff"),
    ).not.toBeInTheDocument();
    expect(within(sidebar()).getByLabelText("Chat threads")).toBe(chatList);
  });

  supportUnreadGate.resolve(undefined);
  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Support escalation"),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByLabelText("Chat threads")).toBe(chatList);
  });
});

test("Use context actions on pinned agents", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  const researchAgent = await waitFor(() => {
    return pinnedAgentLink(grid, "Research Agent");
  });

  fireEvent.contextMenu(researchAgent);
  expect(menuItemByText("Unpin")).toBeInTheDocument();
  click(menuItemByText("Unpin"));
  await waitFor(() => {
    expect(within(grid).queryByText("Research Agent")).toBeNull();
  });

  const supportAgent = pinnedAgentLink(grid, "Support Agent");
  fireEvent.touchStart(supportAgent, {
    touches: [{ identifier: 1, clientX: 12, clientY: 12 }],
  });
  await waitFor(() => {
    expect(menuItemByText("Unpin")).toBeInTheDocument();
  });
  fireEvent.touchEnd(supportAgent, {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: 12, clientY: 12 }],
  });
  fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
  await waitFor(() => {
    expect(queryMenuItemByText("Unpin")).toBeNull();
  });

  click(supportAgent);
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
  });
});

test("Show the three-column chat navigation and actions", async () => {
  prepareDefaultAgent();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const rail = await waitFor(() => {
    return screen.getByTestId("labeled-nav-rail");
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(within(rail).getByText("Chat")).toBeInTheDocument();
  expect(chatLink.querySelector(".lucide-message-circle")).toBeInTheDocument();
  expect(within(rail).getByText("Agents")).toBeInTheDocument();
  expect(within(rail).getByText("Connectors")).toBeInTheDocument();

  const list = screen.getByTestId("chat-list-column");
  expect(within(list).getByText("Chat")).toBeInTheDocument();
  const searchButton = within(list).getByLabelText("Search workspace");
  const chatThreadsTitle = within(list).getByText("Chats with Okou");
  if (!searchButton.parentElement || !chatThreadsTitle.parentElement) {
    throw new Error("Chat action headers not found");
  }
  const headerNewChat = within(searchButton.parentElement).getByLabelText(
    "New chat",
  );
  const threadNewChat = within(chatThreadsTitle.parentElement).getByLabelText(
    "New chat",
  );
  expect(searchButton).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+F Control+Shift+F",
  );
  expect(headerNewChat.querySelector(".lucide-square-pen")).toBeInTheDocument();
  expect(threadNewChat.querySelector(".lucide-plus")).toBeInTheDocument();
  expect(
    within(list).getByTestId("pinned-agents-horizontal"),
  ).toBeInTheDocument();
});

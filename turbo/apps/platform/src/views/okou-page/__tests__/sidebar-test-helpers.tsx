import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { compile } from "tailwindcss";
import { expect, vi } from "vitest";

import {
  chatThreadByIdContract,
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
import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import type { ChatThreadEventQueryResult } from "../../../shared-database/data-key.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

// The composer editor is mounted on first paint and mounted again once page
// bootstrap settles, so an element captured too early is detached before a test
// can drive it. Keyboard events on a detached editor are silently dropped.
export function mountedComposer(): HTMLElement {
  const composer = document.querySelector(
    '[data-slot="chat-composer-card"] [contenteditable="true"]',
  );
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Composer editor is not mounted");
  }
  return composer;
}

export const context = testContext();

export const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
export const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
export const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
export const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
export const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
export const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";
export const RESEARCH_THREAD_ID = "b0000000-0000-4000-a000-000000000005";
export const LAYERED_AVATAR_URL = avatarComposerUrl({
  face: "round",
  hair: "curly-cap",
  expression: "calm",
  skin: "light",
  hairColor: "blue",
  sweater: "lime",
});

export interface SidebarThread {
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

export function prepareDefaultAgent(
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

export function prepareAgents(targetContext = context): AgentResponse[] {
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
export function prepareOverflowingPinnedAgents(
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

export function createThread(
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

export function mockChatThreadSnapshot(
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
      unreadAt: {},
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

export function mockUnreadAgents(
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
      unreadAt: {},
    });
  });
}

export function menuItemByText(text: string): HTMLElement {
  const item = queryMenuItemByText(text);
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

export function queryMenuItemByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitem").find((candidate) => {
      const semanticContent = candidate.cloneNode(true);
      if (!(semanticContent instanceof HTMLElement)) {
        return false;
      }
      for (const hidden of semanticContent.querySelectorAll(
        '[aria-hidden="true"]',
      )) {
        hidden.remove();
      }
      return (
        candidate.getAttribute("aria-label") === text ||
        semanticContent.textContent?.replace(/\s+/g, " ").trim() === text
      );
    }) ?? null
  );
}

export function buttonByText(
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

export function buttonByLabel(
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

export function sidebar(): HTMLElement {
  return screen.getByTestId("chat-list-column");
}

export function queryMobileSidebar(): HTMLElement | null {
  return screen.queryByRole("complementary", { name: "Sidebar" });
}

export function mobileSidebar(): HTMLElement {
  const drawer = queryMobileSidebar();
  if (!drawer) {
    throw new Error("Mobile sidebar not found");
  }
  return drawer;
}

export function mockMobileLayout() {
  return context.mocks.browser.matchMedia(false);
}

export function pinnedAgentLink(
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

export function setupSidebarPage(
  options: Parameters<typeof setupPage>[0],
): Promise<void> {
  return setupPage(options);
}

export function pinnedAgentNames(container: HTMLElement): string[] {
  return within(container)
    .getAllByTestId("pinned-agent-card")
    .map((card) => {
      return card.textContent?.trim() ?? "";
    });
}

/** Names of the given agents as the dialog lists them, in rendered order. */
export function dialogAgentOrder(
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

export function commandItemByText(
  container: HTMLElement,
  text: string,
): HTMLElement {
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

export function createDataTransferStub(
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

export async function renderTailwindUtilities(
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
export function stubSidebarTitleLayout(): void {
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
export function titleFadeBox(title: string): HTMLElement {
  const box = within(sidebar()).getByText(title).parentElement;
  if (!box) {
    throw new Error(`${title} title fade box not found`);
  }
  return box;
}

export function threadRowByTitle(
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

export function threadLinkByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate
        .querySelector('[data-slot="sidebar-thread-title"]')
        ?.textContent?.replace(/\s+/g, " ")
        .trim() === title
    );
  });
  if (!link) {
    throw new Error(`${title} thread link not found`);
  }
  return link;
}

export function visibleThreadTitles(
  expectedTitles: readonly string[],
): string[] {
  const expected = new Set(expectedTitles);
  return queryAllByRoleFast("link", sidebar()).flatMap((candidate) => {
    const title = candidate
      .querySelector('[data-slot="sidebar-thread-title"]')
      ?.textContent?.replace(/\s+/g, " ")
      .trim();
    return title && expected.has(title) ? [title] : [];
  });
}

export function agentRowByName(
  container: HTMLElement,
  name: string,
): HTMLElement {
  const text = within(container).getByText(name);
  const row = text.closest(".group");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${name} agent row not found`);
  }
  return row;
}

export function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

export function openChatListMenu(): void {
  click(within(sidebar()).getByLabelText("Open chat list menu"));
}

export function chatListNewChatButton(): HTMLElement {
  const menuButton = within(sidebar()).getByLabelText("Open chat list menu");
  const actions = menuButton.parentElement;
  if (!actions) {
    throw new Error("Chat list actions not found");
  }
  return within(actions).getByLabelText("New chat");
}

export function mockSidebarViewport(
  height: number,
  scrollHeight: number,
): void {
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

export function mockSidebarThreadStory(
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

export function mockLongSidebarHistory(
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

export async function scrollToArchivedContext(): Promise<HTMLElement> {
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

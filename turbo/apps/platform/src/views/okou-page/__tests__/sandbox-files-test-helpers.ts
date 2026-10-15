import { vi } from "vitest";
import {
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  type SandboxChannelMessage,
  type SandboxChannelWireError,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { now } from "../../../lib/time.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  normalizeMockChatEvents,
  mockChatEventRows,
} from "./chat-event-test-helpers.ts";

export const FILES_THREAD_ID = "b0000000-0000-4000-a000-000000000964";
export const FILES_RUN_ID = "d0000000-0000-4000-a000-000000000964";
export type FilesRequest = Extract<SandboxChannelMessage, { type: "request" }>;
export type FilesReply =
  { readonly result: unknown } | { readonly error: SandboxChannelWireError };
export function entry(
  name: string,
  kind: "directory" | "file" | "symlink" | "other" = "file",
) {
  return {
    nameToken: btoa(String.fromCharCode(...new TextEncoder().encode(name)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
    displayName: name,
    kind,
  };
}
export function listing(
  entries = [entry("workspace", "directory")],
  nextCursor: string | null = null,
  listingId = "home",
): FilesReply {
  return { result: { listingId, entries, nextCursor } };
}
export function filesPath(...names: string[]): string[] {
  return names.map((name) => {
    return entry(name).nameToken;
  });
}
export function navigationListing(request: FilesRequest): FilesReply {
  const tree: Record<string, ReturnType<typeof entry>[]> = {
    [JSON.stringify([])]: [entry("home", "directory"), entry("root.txt")],
    [JSON.stringify(filesPath("home"))]: [entry("user", "directory")],
    [JSON.stringify(filesPath("home", "user"))]: [
      entry("workspace", "directory"),
      entry("reports", "directory"),
      entry("home.txt"),
    ],
    [JSON.stringify(filesPath("home", "user", "workspace"))]: [
      entry("nested", "directory"),
      entry("workspace.txt"),
    ],
    [JSON.stringify(filesPath("home", "user", "workspace", "nested"))]: [
      entry("nested.txt"),
    ],
    [JSON.stringify(filesPath("home", "user", "reports"))]: [
      entry("report.txt"),
    ],
  };
  const entries = tree[JSON.stringify(request.params.path)];
  return entries ? listing(entries) : { error: { code: "not_found" } };
}
export function filesButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected Files button ${name}`);
  }
  return button;
}
export function filesMenuItem(name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected Files menu item ${name}`);
  }
  return item;
}
export async function setupFilesPage(
  context: TestContext,
  options: {
    readonly handler?: (
      request: FilesRequest,
      connection: number,
    ) => FilesReply | Promise<FilesReply>;
    readonly closeHandler?: () => FilesReply | Promise<FilesReply>;
    readonly categories?: Record<string, number>;
    readonly active?: boolean;
    readonly queued?: boolean;
    readonly enabled?: boolean;
    readonly mobile?: boolean;
    readonly viewportHeight?: number;
    readonly bootstrapUnavailable?: boolean;
    readonly twoThreads?: boolean;
    readonly helloError?: SandboxChannelWireError;
  } = {},
) {
  const sockets: Socket[] = [];
  const requests: FilesRequest[] = [];
  const bootstraps: string[] = [];
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  class Socket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    readyState: number = Socket.CONNECTING;
    readonly index: number;
    constructor() {
      super();
      this.index = sockets.length;
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== Socket.CONNECTING) {
          return;
        }
        this.readyState = Socket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data: unknown): void {
      if (typeof data === "string") {
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", { data: '{"type":"auth.ok"}' }),
          );
        });
        return;
      }
      if (!(data instanceof ArrayBuffer)) {
        throw new Error("expected binary business frame");
      }
      const request = decodeSandboxChannelFrame(data);
      if (request.type === "hello") {
        this.reply(
          request.id,
          options.helloError
            ? { error: options.helloError }
            : { result: { categories: options.categories ?? { fs: 2 } } },
        );
      } else if (request.type === "request") {
        requests.push(request);
        detach(
          this.respond(request),
          Reason.Deferred,
          "external Guest response",
        );
      } else {
        throw new Error("unexpected frame type");
      }
    }
    async respond(request: FilesRequest): Promise<void> {
      const response =
        request.operation === "list.close"
          ? await (options.closeHandler?.() ?? { result: {} })
          : await (options.handler?.(request, this.index) ?? listing());
      context.signal.throwIfAborted();
      if (this.readyState === Socket.OPEN) {
        this.reply(request.id, response);
      }
    }
    reply(requestId: string, response: FilesReply): void {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: encodeSandboxChannelFrame({
            schemaVersion: 1,
            type: "response",
            id: crypto.randomUUID(),
            requestId,
            ...response,
          }),
        }),
      );
    }
    close(): void {
      if (this.readyState === Socket.CLOSED) {
        return;
      }
      this.readyState = Socket.CLOSED;
      this.dispatchEvent(new CloseEvent("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "sandbox-files-viewport"
        ? (options.viewportHeight ?? 264)
        : 0;
    },
  );
  context.mocks.browser.matchMedia((query) => {
    return (
      !options.mobile &&
      (query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)")
    );
  });
  context.mocks.api(
    runnerWssTicketsContract.bootstrap,
    ({ params, respond }) => {
      bootstraps.push(params.runId);
      if (options.bootstrapUnavailable) {
        return respond(404, {
          error: { message: "unavailable", code: "NOT_FOUND" },
        });
      }
      return respond(200, {
        wssUrl: `wss://runner.example.com:443/ws/${params.runId}`,
        ticket: "a".repeat(43),
        expiresAt: new Date(now() + 30_000).toISOString(),
      });
    },
  );
  const lifecycle = mockChatLifecycle(context, {
    threadId: FILES_THREAD_ID,
    threadTitle: "Files test thread",
    activeRunIds: options.active === false ? [] : [FILES_RUN_ID],
    chatEvents: [
      {
        id: "files-prompt",
        role: "user",
        content: "Inspect sandbox files",
        runId:
          options.active === false && options.queued ? undefined : FILES_RUN_ID,
        seqId: 1,
        createdAt: "2026-10-14T12:00:00.000Z",
      },
      ...(options.active === false && !options.queued
        ? [
            {
              id: "files-completed",
              role: "assistant" as const,
              content: null,
              runId: FILES_RUN_ID,
              runLifecycleEvent: "completed" as const,
              seqId: 2,
              createdAt: "2026-10-14T12:00:01.000Z",
            },
          ]
        : []),
    ],
  });
  const threads = options.twoThreads
    ? [
        continuityThread(964, 1, "Left Files thread"),
        continuityThread(964, 2, "Right Files thread"),
      ]
    : [];
  const workspace = options.twoThreads
    ? installContinuityWorkspace(context, {
        caseId: 964,
        threads,
        chatEventRows: threads.flatMap((thread, index) => {
          return mockChatEventRows(
            normalizeMockChatEvents(
              [
                {
                  id: `a0000000-0000-4000-a000-00000000096${index}`,
                  role: "user",
                  content: `Inspect thread ${index}`,
                  runId:
                    index === 0
                      ? FILES_RUN_ID
                      : "d0000000-0000-4000-a000-000000000965",
                  seqId: 1,
                  createdAt: "2026-10-14T12:00:00.000Z",
                },
              ],
              thread.id,
            ),
          );
        }),
      })
    : null;
  await setupPage({
    context,
    path:
      workspace && threads[0] && threads[1]
        ? `/chats/${threads[0].id}?sidebar=${threads[1].id}`
        : `/chats/${FILES_THREAD_ID}`,
    host: "app.okou.ai",
    ...workspace?.pageOptions,
    featureSwitches: {
      [FeatureSwitchKey.SandboxFilesSidebar]: options.enabled ?? true,
    },
  });
  return { sockets, requests, bootstraps, lifecycle, threads, workspace };
}

export function openFiles(mobile = false): Promise<HTMLElement> {
  if (mobile) {
    click(filesButton("More actions"));
    const item = queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.trim() === "Files";
    });
    if (!item) {
      throw new Error("missing Files menu item");
    }
    click(item);
  } else {
    click(filesButton("Open files"));
  }
  return screen.findByRole("region", { name: "Files" });
}

export function scrollFilesToEnd(panel: HTMLElement): void {
  const viewport = within(panel).getByTestId("sandbox-files-viewport");
  const list = within(panel).getByTestId("sandbox-files-virtual-list");
  fireEvent.scroll(viewport, {
    target: {
      scrollTop: Math.max(
        0,
        Number.parseFloat(list.style.height) - viewport.clientHeight,
      ),
    },
  });
}

export async function loadMoreFiles(
  panel: HTMLElement,
  { scrollToEnd = true }: { readonly scrollToEnd?: boolean } = {},
): Promise<void> {
  if (scrollToEnd) {
    scrollFilesToEnd(panel);
  }
  const more = await waitFor(() => {
    const control = filesButton("Load more", panel);
    expectEnabled(control);
    return control;
  });
  await act(() => {
    click(more);
    return Promise.resolve();
  });
  await waitFor(
    () => {
      expectEnabledOrRemoved(more);
    },
    { container: panel },
  );
}

function expectEnabled(control: HTMLElement): void {
  if (
    control.hasAttribute("disabled") ||
    control.getAttribute("aria-disabled") === "true"
  ) {
    throw new Error("Files page is still loading");
  }
}
function expectEnabledOrRemoved(control: HTMLElement): void {
  if (control.isConnected) {
    expectEnabled(control);
  }
}

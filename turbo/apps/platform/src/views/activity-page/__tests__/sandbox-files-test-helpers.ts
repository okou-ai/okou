import { vi } from "vitest";
import {
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  type SandboxChannelMessage,
  type SandboxChannelWireError,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import { SANDBOX_FS_VERSION } from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import { logsByIdContract } from "@okouai/api-contracts/contracts/logs";
import {
  runAgentEventsContract,
  runsByIdContract,
} from "@okouai/api-contracts/contracts/run-routes";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { now } from "../../../lib/time.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../../okou-page/sidebar-breakpoint.ts";

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
    readonly status?: RunStatus;
    readonly enabled?: boolean;
    readonly jsonTree?: boolean;
    readonly mobile?: boolean;
    readonly viewportHeight?: number;
    readonly activityHeaderHeight?: number;
    readonly bootstrapUnavailable?: boolean | "network";
    readonly initialTab?: string;
    readonly statusHandler?: (runId: string) => RunStatus | Promise<RunStatus>;
    readonly helloError?: SandboxChannelWireError;
  } = {},
) {
  const sockets: Socket[] = [];
  const requests: FilesRequest[] = [];
  const bootstraps: string[] = [];
  const statuses = new Map<string, RunStatus>([
    [
      FILES_RUN_ID,
      options.status ??
        (options.active === false
          ? options.queued
            ? "queued"
            : "completed"
          : "running"),
    ],
  ]);
  let statusUnavailable = false;
  const readStatus = (runId: string) => {
    return statuses.get(runId) ?? "running";
  };
  context.mocks.api(logsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      sessionId: null,
      agentId: null,
      displayName: "Files test activity",
      framework: "codex",
      modelProvider: null,
      selectedModel: null,
      triggerSource: "slack",
      status: readStatus(params.id),
      prompt: "Inspect sandbox files",
      appendSystemPrompt: null,
      error: null,
      createdAt: "2026-10-14T12:00:00.000Z",
      startedAt: null,
      completedAt: null,
      artifact: { name: null, version: null },
    });
  });
  context.mocks.api(
    runAgentEventsContract.getAgentEvents,
    ({ params, respond }) => {
      return respond(200, {
        events: [],
        hasMore: false,
        status: readStatus(params.id),
        lastEventSequence: null,
      });
    },
  );
  context.mocks.api(runsByIdContract.getById, async ({ params, respond }) => {
    if (statusUnavailable) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Run unavailable" },
      });
    }
    const status = await (options.statusHandler?.(params.id) ??
      readStatus(params.id));
    return respond(200, {
      runId: params.id,
      status,
      prompt: "Inspect sandbox files",
      appendSystemPrompt: null,
      createdAt: "2026-10-14T12:00:00.000Z",
      source: {
        providerType: null,
        runtimeProviderType: null,
        model: null,
        credentialScope: null,
        account: { status: "unknown" },
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
            : {
                result: {
                  categories: options.categories ?? { fs: SANDBOX_FS_VERSION },
                },
              },
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
      return this.dataset.testid === "activity-detail-viewport"
        ? (options.viewportHeight ?? 264)
        : 0;
    },
  );
  const rectangle = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const viewport = this.closest<HTMLElement>(
        '[data-testid="activity-detail-viewport"]',
      );
      const top =
        (options.activityHeaderHeight ?? 0) - (viewport?.scrollTop ?? 0);
      if (
        this.tagName === "SECTION" &&
        this.getAttribute("aria-label") === "Files"
      ) {
        return new DOMRect(0, top, 600, 0);
      }
      if (this.dataset.testid === "sandbox-files-virtual-list") {
        return new DOMRect(
          0,
          top + 48,
          600,
          Number.parseFloat(this.style.height),
        );
      }
      return rectangle.call(this);
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
      if (options.bootstrapUnavailable === "network") {
        throw Response.error();
      }
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
  await setupPage({
    context,
    path: `/activities/${FILES_RUN_ID}${options.initialTab ? `?tab=${options.initialTab}` : ""}`,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: options.enabled ?? true,
      [FeatureSwitchKey.JsonTreePreview]: options.jsonTree ?? false,
    },
  });
  return {
    sockets,
    requests,
    bootstraps,
    setStatus(status: RunStatus, runId = FILES_RUN_ID) {
      statuses.set(runId, status);
    },
    setStatusUnavailable(unavailable: boolean) {
      statusUnavailable = unavailable;
    },
  };
}

export function filesTab(name: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`Expected Activity tab ${name}`);
  }
  return tab;
}

export function openFiles(): Promise<HTMLElement> {
  click(filesTab("Files"));
  return screen.findByRole("region", { name: "Files" });
}

export function filesViewport(panel: HTMLElement): HTMLElement {
  const viewport = panel.closest<HTMLElement>(
    '[data-testid="activity-detail-viewport"]',
  );
  if (!viewport) {
    throw new Error("Expected the Activity page scrollport");
  }
  return viewport;
}

export function scrollFilesToEnd(panel: HTMLElement): void {
  const viewport = filesViewport(panel);
  const list = within(panel).getByTestId("sandbox-files-virtual-list");
  fireEvent.scroll(viewport, {
    target: {
      scrollTop: Math.max(
        0,
        viewport.scrollTop +
          list.getBoundingClientRect().bottom -
          viewport.getBoundingClientRect().top -
          viewport.clientHeight,
      ),
    },
  });
}

export async function loadMoreFiles(panel: HTMLElement): Promise<void> {
  scrollFilesToEnd(panel);
  const more = await waitFor(() => {
    const control = filesButton("Load more", panel);
    expectEnabled(control);
    return control;
  });
  click(more);
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

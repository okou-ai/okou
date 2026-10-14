import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import {
  normalizeMockChatEvents,
  mockChatEventRows,
} from "./chat-event-test-helpers.ts";
import {
  entry,
  filesButton,
  listing,
  openFiles,
  setupFilesPage,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Collapsing an in-flight folder closes its late cursor without publishing stale rows", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (Array.isArray(request.params.path) && request.params.path.length) {
        return response.promise;
      }
      return listing();
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  const folder = filesButton("workspace", panel);
  click(folder);
  await expect(
    within(panel).findByText("Loading…"),
  ).resolves.toBeInTheDocument();
  click(folder);
  await waitFor(() => {
    expect(folder).toHaveAttribute("aria-expanded", "false");
  });
  response.resolve(listing([entry("obsolete.txt")], "late-cursor", "child"));
  await waitFor(() => {
    expect(fixture.requests.at(-1)).toMatchObject({
      operation: "list.close",
      params: { cursor: "late-cursor" },
    });
  });
  expect(within(panel).queryByText("obsolete.txt")).toBeNull();
  expect(fixture.sockets).toHaveLength(1);
});

test("Refreshing home invalidates pending descendants and releases their terminal cursors", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      return Array.isArray(request.params.path) && request.params.path.length
        ? response.promise
        : listing();
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("Loading…"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Refresh", panel));
  await waitFor(() => {
    expect(filesButton("workspace", panel)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
  response.resolve(
    listing([entry("obsolete.txt")], "late-refresh-cursor", "child"),
  );
  await waitFor(() => {
    expect(fixture.requests.at(-1)).toMatchObject({
      operation: "list.close",
      params: { cursor: "late-refresh-cursor" },
    });
  });
  expect(within(panel).queryByText("obsolete.txt")).toBeNull();
});

test("Reconnect repeats readiness and reloads home while rejecting old-epoch data", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  const fixture = await setupFilesPage(context, {
    handler: (request, connection) => {
      if (
        connection === 0 &&
        Array.isArray(request.params.path) &&
        request.params.path.length
      ) {
        return response.promise;
      }
      return connection === 0
        ? listing()
        : listing([entry("fresh.txt")], null, "new-home");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("Loading…"),
  ).resolves.toBeInTheDocument();
  act(() => {
    fixture.sockets[0]?.close();
  });
  await expect(
    within(panel).findByText("fresh.txt"),
  ).resolves.toBeInTheDocument();
  response.resolve(
    listing([entry("obsolete.txt")], "old-epoch-cursor", "old-child"),
  );
  expect(within(panel).queryByText("workspace")).toBeNull();
  expect(fixture.sockets).toHaveLength(2);
  expect(
    fixture.requests.filter((request) => {
      return request.operation === "list.close";
    }),
  ).toHaveLength(0);
});

test("Run completion clears files and releases demand without reconnecting", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  act(() => {
    fixture.lifecycle.completeRun();
  });
  await expect(
    within(panel).findByText("Files are available while a run is active."),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("workspace")).toBeNull();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
});

test("Replacing Files with another utility panel releases the connection", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open artifacts"));
  await expect(
    screen.findByTestId("thread-sidebar-artifacts"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
});

test("Signing out tears down the mounted Files owner", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.sessionSignedOut(true);
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  });
  expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
});

test("Files follows its initiating pane and switching to the other thread releases the old peer", async () => {
  const fixture = await setupFilesPage(context, {
    twoThreads: true,
    handler: (_request, connection) => {
      return listing([entry(connection === 0 ? "left.txt" : "right.txt")]);
    },
  });
  const [left, right] = screen.getAllByRole("region", { name: "Chat thread" });
  if (!left || !right) {
    throw new Error("both thread panes must be ready");
  }
  click(filesButton("Open files", left));
  const panel = await screen.findByRole("region", { name: "Files" });
  await expect(
    within(panel).findByText("left.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open files", right));
  await expect(
    within(screen.getByRole("region", { name: "Files" })).findByText(
      "right.txt",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("left.txt")).toBeNull();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(fixture.bootstraps).toStrictEqual([
    "d0000000-0000-4000-a000-000000000964",
    "d0000000-0000-4000-a000-000000000965",
  ]);
  const home = queryAllByRoleFast("link").find((link) => {
    return link.getAttribute("href") === "/agents";
  });
  if (!home) {
    throw new Error("chat home navigation must exist");
  }
  click(home);
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
  expect(fixture.sockets[1]?.readyState).toBe(WebSocket.CLOSED);
});

test("An event-derived replacement Run clears the old directory and opens only the new peer", async () => {
  const fixture = await setupFilesPage(context, {
    twoThreads: true,
    handler: (_request, connection) => {
      return listing([entry(connection === 0 ? "old-run.txt" : "new-run.txt")]);
    },
  });
  const leftPane = screen.getAllByRole("region", { name: "Chat thread" })[0];
  const thread = fixture.threads[0];
  if (!leftPane || !thread || !fixture.workspace) {
    throw new Error("current thread fixture must be ready");
  }
  click(filesButton("Open files", leftPane));
  const panel = await screen.findByRole("region", { name: "Files" });
  await expect(
    within(panel).findByText("old-run.txt"),
  ).resolves.toBeInTheDocument();
  const rows = mockChatEventRows(
    normalizeMockChatEvents(
      [
        {
          id: "a0000000-0000-4000-a000-000000000960",
          role: "user",
          content: "Inspect thread 0",
          runId: "d0000000-0000-4000-a000-000000000964",
          seqId: 1,
          createdAt: "2026-10-14T12:00:00.000Z",
        },
        {
          id: "a0000000-0000-4000-a000-000000000970",
          role: "assistant",
          content: null,
          runLifecycleEvent: "completed",
          runId: "d0000000-0000-4000-a000-000000000964",
          seqId: 2,
          createdAt: "2026-10-14T12:00:01.000Z",
        },
        {
          id: "a0000000-0000-4000-a000-000000000971",
          role: "user",
          content: "Start another run",
          runId: "d0000000-0000-4000-a000-000000000966",
          seqId: 3,
          createdAt: "2026-10-14T12:00:02.000Z",
        },
      ],
      thread.id,
    ),
  );
  fixture.workspace.setChatEventRows(rows);
  act(() => {
    createChatEvent(thread.id);
  });
  await expect(
    within(panel).findByText("new-run.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("old-run.txt")).toBeNull();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(fixture.bootstraps.at(-1)).toBe(
    "d0000000-0000-4000-a000-000000000966",
  );
});

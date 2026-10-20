import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import {
  entry,
  filesButton,
  filesPath,
  listing,
  openFiles,
  setupFilesPage,
  FILES_RUN_ID,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Collapsing an in-flight folder closes its late cursor without publishing stale rows", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (
        Array.isArray(request.params.path) &&
        request.params.path.length > 2
      ) {
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
      return Array.isArray(request.params.path) &&
        request.params.path.length > 2
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
        request.params.path.length > 2
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
  fixture.setStatus("completed");
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("Files are available while a run is active."),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("workspace")).toBeNull();
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

test("Navigating between Activity Runs closes the old peer and binds the exact route Run", async () => {
  const nextRunId = "d0000000-0000-4000-a000-000000000965";
  const fixture = await setupFilesPage(context, {
    handler: (_request, connection) => {
      return listing([
        entry(connection === 0 ? "first-run.txt" : "second-run.txt"),
      ]);
    },
  });
  const firstPanel = await openFiles();
  await expect(
    within(firstPanel).findByText("first-run.txt"),
  ).resolves.toBeInTheDocument();
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: nextRunId },
    searchParams: new URLSearchParams({ tab: "files" }),
  });
  await expect(
    screen.findByText("second-run.txt"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("first-run.txt")).toBeNull();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(fixture.bootstraps).toStrictEqual([FILES_RUN_ID, nextRunId]);
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: nextRunId },
  });
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    expect(fixture.sockets[1]?.readyState).toBe(WebSocket.CLOSED);
  });
});

test("Late directory navigation from the previous Activity cannot replace a new Run's home", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  const nextRunId = "d0000000-0000-4000-a000-000000000966";
  const fixture = await setupFilesPage(context, {
    handler: (request, connection) => {
      if (connection > 0) {
        return listing([entry("new-run.txt")]);
      }
      return Array.isArray(request.params.path) &&
        request.params.path.length > 2
        ? response.promise
        : listing([entry("workspace", "directory"), entry("old-run.txt")]);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("old-run.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open workspace as current folder", panel));
  await waitFor(() => {
    expect(fixture.requests.at(-1)?.params.path).toStrictEqual(
      filesPath("home", "user", "workspace"),
    );
  });
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: nextRunId },
    searchParams: new URLSearchParams({ tab: "files" }),
  });
  await expect(screen.findByText("new-run.txt")).resolves.toBeInTheDocument();
  response.resolve(listing([entry("obsolete-old-run.txt")]));
  expect(screen.queryByText("old-run.txt")).toBeNull();
  expect(screen.queryByText("obsolete-old-run.txt")).toBeNull();
  const nextPanel = screen.getByRole("region", { name: "Files" });
  expect(
    within(nextPanel)
      .getByRole("navigation", { name: "Current folder" })
      .querySelector('[aria-current="location"]'),
  ).toHaveTextContent("user");
  expect(
    fixture.requests
      .filter((request) => {
        return request.operation === "list";
      })
      .at(-1)?.params.path,
  ).toStrictEqual(filesPath("home", "user"));
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(fixture.bootstraps.at(-1)).toBe(nextRunId);
});

import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  entry,
  filesButton,
  filesPath,
  listing,
  navigationListing,
  openFiles,
  setupFilesPage,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();
function currentFolder(panel: HTMLElement) {
  return within(panel)
    .getByRole("navigation", { name: "Current folder" })
    .querySelector('[aria-current="location"]');
}

test("Folder expansion and entry are distinct and every ancestor navigates the real fs v2 namespace", async () => {
  const fixture = await setupFilesPage(context, { handler: navigationListing });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  expect(currentFolder(panel)).toHaveTextContent("user");
  click(filesButton("Open workspace as current folder", panel));
  await waitFor(() => {
    expect(currentFolder(panel)).toHaveTextContent("workspace");
  });
  expect(within(panel).queryByText("home.txt")).toBeNull();
  click(filesButton("home", panel));
  await waitFor(() => {
    expect(currentFolder(panel)).toHaveTextContent("home");
  });
  click(filesButton("Root folder", panel));
  await expect(
    within(panel).findByText("root.txt"),
  ).resolves.toBeInTheDocument();
  expect(currentFolder(panel)).toHaveTextContent("/");
  click(filesButton("Open home as current folder", panel));
  await waitFor(() => {
    expect(currentFolder(panel)).toHaveTextContent("home");
  });
  click(filesButton("Open user as current folder", panel));
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  const requests = fixture.requests.filter((request) => {
    return request.operation === "list";
  });
  expect(
    requests.every((request) => {
      return request.categoryVersion === 2;
    }),
  ).toBeTruthy();
  expect(
    requests.map((request) => {
      return request.params.path;
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      [],
      filesPath("home"),
      filesPath("home", "user"),
      filesPath("home", "user", "workspace"),
    ]),
  );
});

test("The mobile folder entry works by direct touch-style click without a hover event", async () => {
  await setupFilesPage(context, { mobile: true, handler: navigationListing });
  const panel = await openFiles(true);
  const enter = await waitFor(() => {
    return filesButton("Open workspace as current folder", panel);
  });
  fireEvent.click(enter);
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  expect(currentFolder(panel)).toHaveTextContent("workspace");
  expect(within(panel).queryByText("home.txt")).toBeNull();
});

test("Failed navigation keeps the original path and rows and retries the target from the stable toolbar button", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  let targetCalls = 0;
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (
        JSON.stringify(request.params.path) ===
        JSON.stringify(filesPath("home", "user"))
      ) {
        return listing(
          [entry("workspace", "directory"), entry("home.txt")],
          "old-view-cursor",
        );
      }
      if (
        JSON.stringify(request.params.path) ===
        JSON.stringify(filesPath("home", "user", "workspace"))
      ) {
        targetCalls++;
        return targetCalls === 1
          ? response.promise
          : navigationListing(request);
      }
      return navigationListing(request);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  const refresh = filesButton("Refresh", panel);
  click(filesButton("Open workspace as current folder", panel));
  await waitFor(() => {
    expect(targetCalls).toBe(1);
  });
  const closedIndex = fixture.requests.findIndex((request) => {
    return (
      request.operation === "list.close" &&
      request.params.cursor === "old-view-cursor"
    );
  });
  const targetIndex = fixture.requests.findIndex((request) => {
    return (
      JSON.stringify(request.params.path) ===
      JSON.stringify(filesPath("home", "user", "workspace"))
    );
  });
  expect(closedIndex).toBeGreaterThanOrEqual(0);
  expect(closedIndex).toBeLessThan(targetIndex);
  click(filesButton("Open workspace as current folder", panel));
  expect(targetCalls).toBe(1);
  expect(currentFolder(panel)).toHaveTextContent("user");
  expect(within(panel).getByText("home.txt")).toBeInTheDocument();
  response.resolve({ error: { code: "not_found" } });
  await expect(
    within(panel).findByText("Couldn't open /home/user/workspace. Retry."),
  ).resolves.toBeInTheDocument();
  expect(filesButton("Retry", panel)).toBe(refresh);
  expect(currentFolder(panel)).toHaveTextContent("user");
  expect(within(panel).getByText("home.txt")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", panel).filter((control) => {
      return control.getAttribute("aria-label") === "Retry";
    }),
  ).toHaveLength(1);
  refresh.focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  expect(currentFolder(panel)).toHaveTextContent("workspace");
  expect(filesButton("Refresh", panel)).toBe(refresh);
  expect(targetCalls).toBe(2);
  expect(fixture.sockets).toHaveLength(1);
  await waitFor(() => {
    expect(refresh).toHaveFocus();
  });
});

test("A superseded directory response only closes its cursor and cannot replace the selected location", async () => {
  const obsolete = createDeferredPromise<FilesReply>(context.signal);
  let pending = false;
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (
        JSON.stringify(request.params.path) ===
        JSON.stringify(filesPath("home", "user", "workspace"))
      ) {
        pending = true;
        return obsolete.promise;
      }
      return navigationListing(request);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open workspace as current folder", panel));
  await waitFor(() => {
    expect(pending).toBeTruthy();
  });
  click(filesButton("Open reports as current folder", panel));
  await expect(
    within(panel).findByText("report.txt"),
  ).resolves.toBeInTheDocument();
  await act(() => {
    obsolete.resolve(
      listing([entry("obsolete.txt")], "obsolete-navigation-cursor"),
    );
  });
  await waitFor(() => {
    expect(fixture.requests).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "list.close",
          params: { cursor: "obsolete-navigation-cursor" },
        }),
      ]),
    );
  });
  expect(currentFolder(panel)).toHaveTextContent("reports");
  expect(within(panel).getByText("report.txt")).toBeInTheDocument();
  expect(within(panel).queryByText("obsolete.txt")).toBeNull();
});

test("Foreground polling follows the selected root instead of the abandoned home listing", async () => {
  let updated = false;
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (
        updated &&
        JSON.stringify(request.params.path) ===
          JSON.stringify(filesPath("home", "user", "workspace"))
      ) {
        return listing([entry("fresh-workspace.txt")]);
      }
      return navigationListing(request);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open workspace as current folder", panel));
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(filesButton("Refresh", panel)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  const before = fixture.requests.length;
  updated = true;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("fresh-workspace.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("workspace.txt")).toBeNull();
  expect(
    fixture.requests
      .slice(before)
      .filter((request) => {
        return request.operation === "list";
      })
      .map((request) => {
        return request.params.path;
      }),
  ).toStrictEqual([filesPath("home", "user", "workspace")]);
});

test("Navigation supersedes a manual refresh waiting for cursor release", async () => {
  const closed = createDeferredPromise<FilesReply>(context.signal);
  let rootCalls = 0;
  await setupFilesPage(context, {
    closeHandler: () => {
      return closed.promise;
    },
    handler: (request) => {
      if (
        Array.isArray(request.params.path) &&
        request.params.path.length === 0
      ) {
        rootCalls++;
        return rootCalls === 1
          ? listing([entry("root.txt")])
          : { error: { code: "unavailable" } };
      }
      return listing([entry("home.txt")], "manual-refresh-cursor");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Refresh", panel));
  click(filesButton("Root folder", panel));
  await expect(
    within(panel).findByText("root.txt"),
  ).resolves.toBeInTheDocument();
  await act(() => {
    closed.resolve({ result: {} });
  });
  await waitFor(() => {
    expect(filesButton("Refresh", panel)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(currentFolder(panel)).toHaveTextContent("/");
  expect(within(panel).getByText("root.txt")).toBeInTheDocument();
  expect(rootCalls).toBe(1);
});

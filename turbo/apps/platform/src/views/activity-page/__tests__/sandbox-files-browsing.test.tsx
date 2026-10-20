import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  filesButton,
  filesTab,
  listing,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Files connects on demand, supports browsing and releases when switching tabs", async () => {
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (request.params.cursor) {
        return listing(
          [
            entry(".hidden"),
            entry("second.txt"),
            entry("another", "directory"),
            entry("aaa.txt"),
          ],
          null,
        );
      }
      if (
        Array.isArray(request.params.path) &&
        request.params.path.length > 2
      ) {
        return listing([entry("inside.txt")], null, "child");
      }
      return listing(
        [
          entry(".hidden"),
          entry("workspace", "directory"),
          entry("<img>"),
          entry("shortcut", "symlink"),
          entry("socket", "other"),
        ],
        "home-cursor",
      );
    },
  });
  expect(fixture.bootstraps).toHaveLength(0);
  const panel = await openFiles();
  await expect(
    within(panel).findByText(".hidden"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("<img>")).toBeInTheDocument();
  expect(panel.querySelector("img")).toBeNull();
  expect(within(panel).getByText("Link")).toBeInTheDocument();
  expect(within(panel).getByText("Other")).toBeInTheDocument();
  expect(panel.querySelector("li")?.textContent).toBe("workspace");
  click(filesButton("Load more", panel));
  await expect(
    within(panel).findByText("second.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getAllByText(".hidden")).toHaveLength(1);
  const labels = [...panel.querySelectorAll("li")].map((row) => {
    return row.textContent;
  });
  expect(labels.slice(0, 2)).toStrictEqual(["another", "workspace"]);
  expect(labels.indexOf("aaa.txt")).toBeLessThan(labels.indexOf("second.txt"));
  const folder = filesButton("workspace", panel);
  folder.focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    within(panel).findByText("inside.txt"),
  ).resolves.toBeInTheDocument();
  expect(folder).toHaveAttribute("aria-expanded", "true");
  expect(fixture.requests.at(-1)?.params).toStrictEqual({
    path: [
      entry("home").nameToken,
      entry("user").nameToken,
      entry("workspace").nameToken,
    ],
  });
  click(folder);
  await waitFor(() => {
    expect(within(panel).queryByText("inside.txt")).toBeNull();
  });
  click(filesButton("Refresh", panel));
  await waitFor(() => {
    expect(filesButton("Refresh", panel)).toBeEnabled();
    expect(filesButton("Refresh", panel)).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  expect(fixture.sockets).toHaveLength(1);
  const refreshedFolder = filesButton("workspace", panel);
  click(refreshedFolder);
  await expect(
    within(panel).findByText("inside.txt"),
  ).resolves.toBeInTheDocument();
  filesTab("Steps").focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    expect(filesTab("Steps")).toHaveFocus();
  });
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
});

test("The mobile Activity Files tab opens the readonly browser", async () => {
  const fixture = await setupFilesPage(context, {
    mobile: true,
    handler: () => {
      return listing([]);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("This folder is empty."),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).getByText("Read-only files from the current run."),
  ).toBeInTheDocument();
  expect(fixture.sockets).toHaveLength(1);
  click(filesTab("Steps"));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
});

test("Debug off hides Files and starts no Files work, including a direct Files URL", async () => {
  const fixture = await setupFilesPage(context, {
    enabled: false,
    initialTab: "files",
  });
  await expect(
    screen.findByRole("heading", { name: "Files test activity" }),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("tab").find((tab) => {
      return tab.textContent?.trim() === "Files";
    }),
  ).toBeUndefined();
  expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  expect(fixture.bootstraps).toHaveLength(0);
  expect(fixture.sockets).toHaveLength(0);
});

test("An inactive Activity explains that Files require an active run without bootstrap", async () => {
  const fixture = await setupFilesPage(context, {
    active: false,
    queued: false,
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("Files are available while a run is active."),
  ).resolves.toBeInTheDocument();
  expect(fixture.bootstraps).toHaveLength(0);
});

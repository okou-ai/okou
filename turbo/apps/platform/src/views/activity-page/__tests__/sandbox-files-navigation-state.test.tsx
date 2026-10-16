import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  filesButton,
  filesMenuItem,
  filesPath,
  listing,
  navigationListing,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Closing and reconnecting reload the selected same-Run directory", async () => {
  const fixture = await setupFilesPage(context, { handler: navigationListing });
  let panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open workspace as current folder", panel));
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Close files", panel));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
  panel = await openFiles();
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("home.txt")).toBeNull();
  await act(() => {
    fixture.sockets.at(-1)?.close();
  });
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(fixture.sockets).toHaveLength(3);
  });
  expect(
    fixture.requests
      .filter((request) => {
        return request.operation === "list";
      })
      .at(-1)?.params.path,
  ).toStrictEqual(filesPath("home", "user", "workspace"));
});

test("Returning through ancestors restores loaded expansion and scroll without reusing cursor handles", async () => {
  await setupFilesPage(context, {
    handler: (request) => {
      if (
        JSON.stringify(request.params.path) ===
        JSON.stringify(filesPath("home", "user"))
      ) {
        return listing([
          entry("workspace", "directory"),
          ...Array.from({ length: 20 }, (_, index) => {
            return entry(`home-${index}.txt`);
          }),
        ]);
      }
      return navigationListing(request);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  const viewport = within(panel).getByTestId("sandbox-files-viewport");
  fireEvent.scroll(viewport, { target: { scrollTop: 440 } });
  click(filesButton("home", panel));
  await expect(
    waitFor(() => {
      return filesButton("Open user as current folder", panel);
    }),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open user as current folder", panel));
  await waitFor(() => {
    expect(viewport.scrollTop).toBe(440);
  });
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
  await waitFor(() => {
    expect(filesButton("workspace", panel)).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
  expect(within(panel).getByText("workspace.txt")).toBeInTheDocument();
});

test("Long breadcrumbs expose omitted ancestors in a keyboard-owned menu", async () => {
  await setupFilesPage(context, { handler: navigationListing });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open workspace as current folder", panel));
  await expect(
    within(panel).findByText("workspace.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Open nested as current folder", panel));
  await expect(
    within(panel).findByText("nested.txt"),
  ).resolves.toBeInTheDocument();
  const parents = filesButton("Parent folders", panel);
  parents.focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    waitFor(() => {
      return filesMenuItem("/home");
    }),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
  expect(parents).toHaveFocus();
  click(parents);
  click(
    await waitFor(() => {
      return filesMenuItem("/home/user");
    }),
  );
  await expect(
    within(panel).findByText("home.txt"),
  ).resolves.toBeInTheDocument();
});

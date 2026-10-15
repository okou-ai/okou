import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  filesButton,
  listing,
  openFiles,
  setupFilesPage,
  loadMoreFiles,
  scrollFilesToEnd,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("The panel entry budget keeps its partial listing and closes an over-limit continuation", async () => {
  const fixture = await setupFilesPage(context, {
    viewportHeight: 44,
    handler: (request) => {
      const page =
        typeof request.params.cursor === "string"
          ? Number(request.params.cursor.slice(5))
          : 0;
      return listing(
        Array.from({ length: 128 }, (_unused, index) => {
          return entry(`file-${String(page * 128 + index).padStart(5, "0")}`);
        }),
        `page-${page + 1}`,
      );
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("file-00000"),
  ).resolves.toBeInTheDocument();
  scrollFilesToEnd(panel);
  const more = await waitFor(() => {
    return filesButton("Load more", panel);
  });
  // A focused pagination control stays mounted as rows are appended. Paging
  // the entry budget does not need to scroll through each intermediate page.
  await userEvent.setup({ delay: null, skipHover: true }).click(more);
  expect(more).toHaveFocus();
  for (let page = 2; page <= 32; page++) {
    await loadMoreFiles(panel, { scrollToEnd: false });
  }
  scrollFilesToEnd(panel);
  await expect(
    within(panel).findByText(
      "Some files could not be loaded because the panel limit was reached. Collapse folders or refresh to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("file-04095")).toBeInTheDocument();
  expect(within(panel).queryByText("file-04096")).toBeNull();
  expect(panel.querySelectorAll("li").length).toBeLessThan(40);
  expect(within(panel).queryByText("file-00000")).toBeNull();
  await waitFor(() => {
    expect(
      fixture.requests
        .filter((request) => {
          return request.operation === "list.close";
        })
        .map((request) => {
          return request.params.cursor;
        }),
    ).toContain("page-33");
  });
});

test("A Guest load limit preserves partial rows and exposes a recoverable state", async () => {
  await setupFilesPage(context, {
    handler: (request) => {
      return request.params.cursor
        ? { error: { code: "limit_exceeded" } }
        : listing([entry("partial.txt")], "continue");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("partial.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Load more", panel));
  await expect(
    within(panel).findByText(
      "Some files could not be loaded because the panel limit was reached. Collapse folders or refresh to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("partial.txt")).toBeInTheDocument();
  expect(filesButton("Retry", panel)).toBeEnabled();
});

import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  listing,
  openFiles,
  setupFilesPage,
  filesButton,
  loadMoreFiles,
  scrollFilesToEnd,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Encoded metadata reaches its limit before the entry count and releases the discarded page", async () => {
  const fixture = await setupFilesPage(context, {
    viewportHeight: 44,
    handler: (request) => {
      const page =
        typeof request.params.cursor === "string"
          ? Number(request.params.cursor.slice(5))
          : 0;
      return listing(
        Array.from({ length: 72 }, (_unused, index) => {
          return entry(
            `file-${String(page).padStart(3, "0")}-${String(index).padStart(2, "0")}-${"x".repeat(243)}`,
          );
        }),
        `page-${page + 1}`,
      );
    },
  });
  const panel = await openFiles();
  await waitFor(() => {
    expect(panel.querySelectorAll("li").length).toBeGreaterThan(0);
  });
  const message =
    "Some files could not be loaded because the panel limit was reached. Collapse folders or refresh to continue.";
  scrollFilesToEnd(panel);
  const more = filesButton("Load more", panel);
  // Keep the focused paging control mounted in a single-row pane.
  await userEvent.setup({ delay: null, skipHover: true }).click(more);
  expect(more).toHaveFocus();
  // Valid 255-byte basenames also retain their 340-byte raw tokens and virtual
  // row keys. Each page stays below 48 KiB; retained metadata reaches 4 MiB
  // before 4096 entries. Even all 56 pages contain only 4032 entries, so the
  // entry cap cannot satisfy this assertion. Stop on the user-visible limit.
  for (
    let page = 2;
    page < 56 &&
    !Array.from(panel.querySelectorAll('[role="status"]')).some((status) => {
      return status.textContent === message;
    });
    page++
  ) {
    await loadMoreFiles(panel, { scrollToEnd: false });
  }
  scrollFilesToEnd(panel);
  await expect(
    within(panel).findByText(
      "Some files could not be loaded because the panel limit was reached. Collapse folders or refresh to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(panel.querySelectorAll("li").length).toBeLessThan(40);
  expect(panel.querySelectorAll("li").length).toBeGreaterThan(0);
  await waitFor(() => {
    expect(fixture.requests.at(-1)?.operation).toBe("list.close");
  });
});

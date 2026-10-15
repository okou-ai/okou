import { fireEvent, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  listing,
  openFiles,
  filesButton,
  setupFilesPage,
  loadMoreFiles,
  scrollFilesToEnd,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Replacing a directory frees its cached descendants before the refresh quota check", async () => {
  let replaced = false;
  await setupFilesPage(context, {
    viewportHeight: 88,
    handler: (request) => {
      if (
        Array.isArray(request.params.path) &&
        request.params.path.length === 2
      ) {
        return replaced
          ? listing([entry("replacement", "directory"), entry("new.txt")])
          : listing();
      }
      if (replaced) {
        return listing([entry("usable.txt")], null, "replacement");
      }
      const page =
        typeof request.params.cursor === "string"
          ? Number(request.params.cursor.slice(5))
          : 0;
      const length = Math.min(128, 4095 - page * 128);
      return listing(
        Array.from({ length }, (_unused, index) => {
          return entry(`file-${String(page * 128 + index).padStart(5, "0")}`);
        }),
        page < 31 ? `page-${page + 1}` : null,
        "child",
      );
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("file-00000"),
  ).resolves.toBeInTheDocument();
  // Keep the focused paging control mounted in a compact pane. Replacing a
  // directory at the quota edge does not need a new virtual viewport per page.
  scrollFilesToEnd(panel);
  filesButton("Load more", panel).focus();
  fireEvent.scroll(within(panel).getByTestId("sandbox-files-viewport"), {
    target: { scrollTop: 0 },
  });
  // The home row plus 4095 descendants fill the 4096-entry budget. The two
  // refreshed home entries fit only after the old descendants are discarded.
  for (let page = 1; page <= 31; page++) {
    await loadMoreFiles(panel, { scrollToEnd: false });
  }
  scrollFilesToEnd(panel);
  await expect(
    within(panel).findByText("file-04094"),
  ).resolves.toBeInTheDocument();
  replaced = true;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("replacement"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("new.txt")).toBeInTheDocument();
  expect(within(panel).queryByRole("status")).toBeNull();
  click(filesButton("replacement", panel));
  await expect(
    within(panel).findByText("usable.txt"),
  ).resolves.toBeInTheDocument();
});

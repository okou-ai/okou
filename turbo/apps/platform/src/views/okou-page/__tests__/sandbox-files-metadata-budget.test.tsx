import { waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  listing,
  openFiles,
  setupFilesPage,
  loadMoreFiles,
  scrollFilesToEnd,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Encoded metadata reaches its limit before the entry count and releases the discarded page", async () => {
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      const page =
        typeof request.params.cursor === "string"
          ? Number(request.params.cursor.slice(5))
          : 0;
      return listing(
        Array.from({ length: 11 }, (_unused, index) => {
          return {
            ...entry(`file-${page}-${index}`),
            displayName: `file-${String(page).padStart(3, "0")}-${index} ${"界".repeat(1355)}`,
          };
        }),
        `page-${page + 1}`,
      );
    },
  });
  const panel = await openFiles();
  await waitFor(() => {
    expect(panel.querySelectorAll("li").length).toBeGreaterThan(1);
  });
  const message =
    "Some files could not be loaded because the panel limit was reached. Collapse folders or refresh to continue.";
  // Eleven entries fill the public 48 KiB response budget without exceeding it;
  // retained UTF-8
  // metadata exceeds 4 MiB well before 4096 entries. Stop on observable removal.
  for (
    let page = 1;
    page < 110 &&
    !Array.from(panel.querySelectorAll('[role="status"]')).some((status) => {
      return status.textContent === message;
    });
    page++
  ) {
    await loadMoreFiles(panel);
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

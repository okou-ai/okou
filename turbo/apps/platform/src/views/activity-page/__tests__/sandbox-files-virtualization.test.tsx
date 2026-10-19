import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  filesButton,
  filesViewport,
  listing,
  openFiles,
  setupFilesPage,
  scrollFilesToEnd,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test.each([
  { mobile: false, activityHeaderHeight: 220, viewportHeight: 600 },
  { mobile: true, activityHeaderHeight: 310, viewportHeight: 260 },
  { mobile: true, activityHeaderHeight: 100, viewportHeight: 160 },
])(
  "Page scrolling reaches long Files lists below Activity information (%j)",
  async (layout) => {
    await setupFilesPage(context, {
      ...layout,
      handler: () => {
        return listing(
          Array.from({ length: 128 }, (_unused, index) => {
            return entry(`file-${String(index).padStart(3, "0")}.txt`);
          }),
        );
      },
    });
    const panel = await openFiles();
    await expect(
      within(panel).findByText("file-000.txt"),
    ).resolves.toBeInTheDocument();
    const viewport = filesViewport(panel);
    fireEvent.scroll(viewport, {
      target: { scrollTop: layout.activityHeaderHeight + 80 * 44 },
    });
    await expect(
      within(panel).findByText("file-080.txt"),
    ).resolves.toBeInTheDocument();
    expect(within(panel).queryByText("file-071.txt")).toBeNull();
    expect(filesButton("Go to home folder", panel)).toBeEnabled();
    expect(filesButton("Refresh", panel)).toBeEnabled();
    scrollFilesToEnd(panel);
    await expect(
      within(panel).findByText("file-127.txt"),
    ).resolves.toBeInTheDocument();
    expect(panel.querySelectorAll("li").length).toBeLessThan(40);
  },
);

test("The Files virtual viewport scrolls, resizes and retains a focused folder", async () => {
  await setupFilesPage(context, {
    handler: (request) => {
      return Array.isArray(request.params.path) &&
        request.params.path.length > 2
        ? listing([entry("inside.txt")], null, "child")
        : listing(
            Array.from({ length: 128 }, (_unused, index) => {
              return entry(
                `folder-${String(index).padStart(3, "0")}`,
                "directory",
              );
            }),
            "continue",
          );
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("folder-000"),
  ).resolves.toBeInTheDocument();
  const folder = filesButton("folder-000", panel);
  const viewport = filesViewport(panel);
  folder.focus();
  scrollFilesToEnd(panel);
  await expect(
    within(panel).findByText("folder-127"),
  ).resolves.toBeInTheDocument();
  expect(folder).toHaveFocus();
  expect(panel.querySelectorAll("li").length).toBeLessThan(40);
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(folder).toHaveAttribute("aria-expanded", "true");
  });
  fireEvent.scroll(viewport, { target: { scrollTop: 0 } });
  await expect(
    within(panel).findByText("inside.txt"),
  ).resolves.toBeInTheDocument();
  expect(folder).toHaveFocus();
  await userEvent.keyboard(" ");
  await waitFor(() => {
    expect(folder).toHaveAttribute("aria-expanded", "false");
  });
  expect(within(panel).queryByText("inside.txt")).toBeNull();
  vi.spyOn(viewport, "clientHeight", "get").mockReturnValue(528);
  fireEvent(window, new Event("resize"));
  await expect(
    within(panel).findByText("folder-018"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("folder-025")).toBeNull();
});

import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  filesButton,
  listing,
  openFiles,
  setupFilesPage,
  scrollFilesToEnd,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

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
  const viewport = within(panel).getByTestId("sandbox-files-viewport");
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
    within(panel).findByText("folder-019"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("folder-025")).toBeNull();
});

import {
  act,
  fireEvent,
  waitFor,
  within,
  screen,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  entry,
  listing,
  openFiles,
  filesButton,
  filesTab,
  filesViewport,
  setupFilesPage,
  loadMoreFiles,
  scrollFilesToEnd,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Foreground refresh updates expanded files silently and stops after switching tabs", async () => {
  let generation = 0;
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      return Array.isArray(request.params.path) &&
        request.params.path.length > 2
        ? listing([entry(generation ? "fresh.txt" : "old.txt")], null, "child")
        : listing();
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("old.txt"),
  ).resolves.toBeInTheDocument();
  generation++;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("fresh.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("old.txt")).toBeNull();
  expect(filesButton("workspace", panel)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(within(panel).queryByRole("status")).toBeNull();
  click(filesTab("Steps"));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
  const requests = fixture.requests.length;
  fireEvent(document, new Event("visibilitychange"));
  expect(fixture.requests).toHaveLength(requests);
});

test("Automatic refresh retains loaded pagination coverage and removes deleted names", async () => {
  let generation = 0;
  await setupFilesPage(context, {
    handler: (request) => {
      return request.params.cursor
        ? listing(
            [entry(generation ? "new-tail.txt" : "old-tail.txt")],
            null,
            generation ? "fresh" : "home",
          )
        : listing(
            [entry("first.txt")],
            generation ? "fresh-cursor" : "old-cursor",
            generation ? "fresh" : "home",
          );
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("first.txt"),
  ).resolves.toBeInTheDocument();
  await loadMoreFiles(panel);
  expect(within(panel).getByText("old-tail.txt")).toBeInTheDocument();
  generation++;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("new-tail.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("first.txt")).toBeInTheDocument();
  expect(within(panel).queryByText("old-tail.txt")).toBeNull();
  expect(within(panel).queryByText("Load more")).toBeNull();
});

test("A hidden page pauses refresh and foreground updates after returning", async () => {
  let generation = 0;
  const fixture = await setupFilesPage(context, {
    handler: () => {
      return listing([entry(generation ? "fresh.txt" : "old.txt")]);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("old.txt"),
  ).resolves.toBeInTheDocument();
  generation++;
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const requests = fixture.requests.length;
  fireEvent(document, new Event("visibilitychange"));
  expect(fixture.requests).toHaveLength(requests);
  expect(within(panel).getByText("old.txt")).toBeInTheDocument();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("fresh.txt"),
  ).resolves.toBeInTheDocument();
});

test("Short response pages refresh all previously loaded entries", async () => {
  let refreshing = false;
  await setupFilesPage(context, {
    handler: (request) => {
      if (!refreshing) {
        return listing(
          Array.from({ length: 75 }, (_unused, index) => {
            return entry(`old-${String(index).padStart(3, "0")}`);
          }),
        );
      }
      const page =
        typeof request.params.cursor === "string"
          ? Number(request.params.cursor.slice(5))
          : 0;
      return listing(
        [entry(`new-${String(page).padStart(3, "0")}`)],
        page < 74 ? `page-${page + 1}` : null,
        "fresh",
      );
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("old-000"),
  ).resolves.toBeInTheDocument();
  refreshing = true;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("new-000"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("old-000")).toBeNull();
  scrollFilesToEnd(panel);
  await expect(
    within(panel).findByText("new-074"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("Load more")).toBeNull();
});

test("Refreshing an empty directory keeps the settled empty state without a loading notice", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  let requests = 0;
  await setupFilesPage(context, {
    handler: () => {
      requests++;
      return requests === 1 ? listing([]) : response.promise;
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("This folder is empty."),
  ).resolves.toBeInTheDocument();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(requests).toBe(2);
  });
  expect(within(panel).getByText("This folder is empty.")).toBeInTheDocument();
  expect(within(panel).queryByText("Loading…")).toBeNull();
  await act(async () => {
    response.resolve(listing([]));
    await response.promise;
  });
  expect(within(panel).getByText("This folder is empty.")).toBeInTheDocument();
});

test("Background refresh keeps the pagination button focused and inert until its snapshot settles", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  let listings = 0;
  const fixture = await setupFilesPage(context, {
    handler: () => {
      listings++;
      return listings === 1
        ? listing([entry("retained.txt")], "old-cursor")
        : response.promise;
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("retained.txt"),
  ).resolves.toBeInTheDocument();
  const more = filesButton("Load more", panel);
  more.focus();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(listings).toBe(2);
  });
  expect(more).toHaveFocus();
  expect(more).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter}");
  expect(listings).toBe(2);
  expect(
    fixture.requests.filter((request) => {
      return request.operation === "list";
    }),
  ).toHaveLength(2);
  response.resolve(listing([entry("retained.txt")], "fresh-cursor", "fresh"));
  await waitFor(() => {
    expect(more).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(more).toHaveFocus();
  expect(within(panel).queryByText("Loading…")).toBeNull();
});

test("Completing a focused pagination action returns focus to the Files list", async () => {
  await setupFilesPage(context, {
    handler: (request) => {
      return request.params.cursor
        ? listing([entry("last.txt")])
        : listing([entry("first.txt")], "continue");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("first.txt"),
  ).resolves.toBeInTheDocument();
  filesButton("Load more", panel).focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    within(panel).findByText("last.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("Load more")).toBeNull();
  expect(within(panel).getByTestId("sandbox-files-virtual-list")).toHaveFocus();
});

test("A failed focused pagination action keeps rows and makes Retry reachable by keyboard", async () => {
  await setupFilesPage(context, {
    handler: (request) => {
      return request.params.cursor
        ? { error: { code: "forbidden" } }
        : listing([entry("first.txt")], "continue");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("first.txt"),
  ).resolves.toBeInTheDocument();
  filesButton("Load more", panel).focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("first.txt")).toBeInTheDocument();
  expect(within(panel).getByTestId("sandbox-files-virtual-list")).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(filesButton("Retry", panel)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(
      within(panel).queryByText("Files are unavailable. Try again."),
    ).toBeNull();
  });
  await expect(
    within(panel).findByText("first.txt"),
  ).resolves.toBeInTheDocument();
  expect(filesButton("Refresh", panel)).toHaveFocus();
});

test("Background refresh failure keeps rows and pauses until the user retries", async () => {
  let fail = false;
  const fixture = await setupFilesPage(context, {
    handler: () => {
      return fail
        ? { error: { code: "forbidden" } }
        : listing([entry("retained.txt")]);
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("retained.txt"),
  ).resolves.toBeInTheDocument();
  fail = true;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  expect(within(panel).getByText("retained.txt")).toBeInTheDocument();
  const requests = fixture.requests.length;
  fireEvent(document, new Event("visibilitychange"));
  expect(fixture.requests).toHaveLength(requests);
  fail = false;
  click(filesButton("Retry", panel));
  await waitFor(() => {
    expect(
      within(panel).queryByText("Files are unavailable. Try again."),
    ).toBeNull();
  });
  await expect(
    within(panel).findByText("retained.txt"),
  ).resolves.toBeInTheDocument();
});

test("A scrolled listing exposes failure and retry on the existing refresh control", async () => {
  let fail = false;
  await setupFilesPage(context, {
    handler: () => {
      return fail
        ? { error: { code: "forbidden" } }
        : listing(
            Array.from({ length: 128 }, (_unused, index) => {
              return entry(`file-${String(index).padStart(3, "0")}`);
            }),
          );
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("file-000"),
  ).resolves.toBeInTheDocument();
  const viewport = filesViewport(panel);
  const refresh = filesButton("Refresh", panel);
  fireEvent.scroll(viewport, { target: { scrollTop: 1760 } });
  await expect(
    within(panel).findByText("file-040"),
  ).resolves.toBeInTheDocument();
  fail = true;
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(refresh).toHaveAccessibleName("Retry");
  });
  expect(refresh).toBeVisible();
  expect(refresh).toHaveTextContent("!");
  expect(refresh).toHaveAccessibleDescription(
    "Files are unavailable. Try again.",
  );
  expect(within(panel).getByText("file-040")).toBeInTheDocument();
  expect(viewport.scrollTop).toBe(1760);
  expect(panel.querySelectorAll("li").length).toBeLessThan(40);
  expect(
    queryAllByRoleFast("button", panel).filter((button) => {
      return button.getAttribute("aria-label") === "Retry";
    }),
  ).toHaveLength(1);
  expect(within(panel).queryByText("Retry")).toBeNull();
  const user = userEvent.setup();
  await user.hover(refresh);
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "Files are unavailable. Try again.",
  );
  fail = false;
  refresh.focus();
  await userEvent.keyboard("{Enter}");
  await expect(
    within(panel).findByText("file-000"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).queryByText("Files are unavailable. Try again."),
  ).toBeNull();
  expect(filesButton("Refresh", panel)).toBe(refresh);
  expect(refresh).not.toHaveTextContent("!");
  expect(refresh).toHaveFocus();
});

test("Removing a failed directory retains focus on the same refresh control", async () => {
  let fail = false;
  let removed = false;
  await setupFilesPage(context, {
    handler: (request) => {
      if (
        Array.isArray(request.params.path) &&
        request.params.path.length > 2
      ) {
        return fail
          ? { error: { code: "forbidden" } }
          : listing([entry("inside.txt")], null, "child");
      }
      return removed ? listing([entry("replacement.txt")]) : listing();
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("inside.txt"),
  ).resolves.toBeInTheDocument();
  fail = true;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  within(panel).getByTestId("sandbox-files-virtual-list").focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  const refresh = filesButton("Retry", panel);
  expect(refresh).toHaveFocus();
  removed = true;
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("replacement.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).queryByText("Files are unavailable. Try again."),
  ).toBeNull();
  expect(filesButton("Refresh", panel)).toBe(refresh);
  expect(refresh).toHaveFocus();
});

test("Retrying a failed folder keeps the toolbar focused and inert until it settles", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  let state: "healthy" | "failed" | "retry" = "healthy";
  await setupFilesPage(context, {
    handler: (request) => {
      if (
        !Array.isArray(request.params.path) ||
        request.params.path.length === 2
      ) {
        return listing();
      }
      if (state === "retry") {
        return response.promise;
      }
      return state === "failed"
        ? { error: { code: "forbidden" } }
        : listing([entry("before.txt")], null, "child");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("before.txt"),
  ).resolves.toBeInTheDocument();
  state = "failed";
  fireEvent(document, new Event("visibilitychange"));
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  const refresh = filesButton("Retry", panel);
  refresh.focus();
  state = "retry";
  await userEvent.keyboard("{Enter}");
  await expect(
    within(panel).findByText("Loading…"),
  ).resolves.toBeInTheDocument();
  expect(refresh).toHaveAttribute("aria-disabled", "true");
  expect(refresh).toHaveAttribute("aria-busy", "true");
  expect(refresh).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await act(async () => {
    response.resolve(listing([entry("after.txt")], null, "child-retried"));
    await response.promise;
  });
  await expect(
    within(panel).findByText("after.txt"),
  ).resolves.toBeInTheDocument();
  expect(filesButton("workspace", panel)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(refresh).toHaveAttribute("aria-disabled", "false");
  expect(refresh).toHaveAttribute("aria-busy", "false");
  expect(refresh).toHaveFocus();
});

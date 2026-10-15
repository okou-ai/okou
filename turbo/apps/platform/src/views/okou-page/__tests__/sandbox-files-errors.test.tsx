import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  entry,
  filesButton,
  listing,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("An unsupported schema is a stable update state while chat remains usable", async () => {
  const fixture = await setupFilesPage(context, {
    helloError: {
      code: "unsupported_schema",
      expectedVersion: 2,
      receivedVersion: 1,
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText(
      "This run does not support files. Start a new run after the sandbox is updated.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
    "Files test thread",
  );
  expect(fixture.requests).toHaveLength(0);
});

test.each<Record<string, number>>([{}, { fs: 2 }])(
  "An unsupported fs category %j shows an update state without a list call",
  async (categories) => {
    const fixture = await setupFilesPage(context, { categories });
    const panel = await openFiles();
    await expect(
      within(panel).findByText(
        "This run does not support files. Start a new run after the sandbox is updated.",
      ),
    ).resolves.toBeInTheDocument();
    expect(fixture.requests).toHaveLength(0);
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Files test thread",
    );
  },
);

test.each(["directory_changed"] as const)(
  "A %s continuation preserves partial rows and can refresh",
  async (code) => {
    const fixture = await setupFilesPage(context, {
      handler: (request) => {
        return request.params.cursor
          ? { error: { code } }
          : listing([entry("first.txt")], "home-cursor");
      },
    });
    const panel = await openFiles();
    await expect(
      within(panel).findByText("first.txt"),
    ).resolves.toBeInTheDocument();
    click(filesButton("Load more", panel));
    await expect(
      within(panel).findByText(
        "This listing changed or expired. Refresh to continue.",
      ),
    ).resolves.toBeInTheDocument();
    expect(within(panel).getByText("first.txt")).toBeInTheDocument();
    expect(within(panel).queryByText("This folder is empty.")).toBeNull();
    await waitFor(() => {
      expect(fixture.requests.at(-1)).toMatchObject({
        operation: "list.close",
        params: { cursor: "home-cursor" },
      });
    });
    click(filesButton("Retry", panel));
    await waitFor(() => {
      expect(
        within(panel).queryByText(
          "This listing changed or expired. Refresh to continue.",
        ),
      ).toBeNull();
    });
  },
);

test("An expired continuation automatically starts a fresh directory listing", async () => {
  let initialListings = 0;
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (request.params.cursor) {
        return { error: { code: "cursor_expired" } };
      }
      initialListings++;
      return initialListings === 1
        ? listing([entry("old.txt")], "expired-cursor")
        : listing([entry("fresh.txt")], null, "fresh");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("old.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Load more", panel));
  await expect(
    within(panel).findByText("fresh.txt"),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("old.txt")).toBeNull();
  expect(within(panel).queryByText("Load more")).toBeNull();
  expect(initialListings).toBe(2);
  expect(fixture.requests).toContainEqual(
    expect.objectContaining({
      operation: "list.close",
      params: { cursor: "expired-cursor" },
    }),
  );
});

test("A failed fresh listing after expiration stops automatic recovery", async () => {
  let initialListings = 0;
  await setupFilesPage(context, {
    handler: (request) => {
      if (request.params.cursor) {
        return { error: { code: "cursor_expired" } };
      }
      initialListings++;
      return initialListings === 1
        ? listing([entry("old.txt")], "expired-cursor")
        : { error: { code: "cursor_expired" } };
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("old.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Load more", panel));
  await expect(
    within(panel).findByText(
      "This listing changed or expired. Refresh to continue.",
    ),
  ).resolves.toBeInTheDocument();
  expect(filesButton("Retry", panel)).toBeEnabled();
  expect(initialListings).toBe(2);
});

test("A malformed terminal result remains an error and never publishes unsafe names", async () => {
  await setupFilesPage(context, {
    handler: () => {
      return {
        result: {
          listingId: "bad",
          entries: [
            { nameToken: "Li4", displayName: "unsafe", kind: "directory" },
          ],
          nextCursor: null,
        },
      };
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  expect(within(panel).queryByText("unsafe")).toBeNull();
  expect(within(panel).queryByText("This folder is empty.")).toBeNull();
});

test("A terminal bootstrap 404 requires explicit retry and never implies an empty home", async () => {
  const fixture = await setupFilesPage(context, { bootstrapUnavailable: true });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  expect(fixture.bootstraps).toHaveLength(1);
  expect(fixture.sockets).toHaveLength(0);
  click(filesButton("Retry", panel));
  await waitFor(() => {
    expect(fixture.bootstraps).toHaveLength(2);
  });
  await expect(
    within(panel).findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  click(filesButton("Close files", panel));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
  expect(fixture.bootstraps).toHaveLength(2);
});

test("A continuation with a different listing identity is stale and releases its returned cursor", async () => {
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      return request.params.cursor
        ? listing([entry("wrong.txt")], "wrong-cursor", "different")
        : listing([entry("first.txt")], "home-cursor");
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("first.txt"),
  ).resolves.toBeInTheDocument();
  click(filesButton("Load more", panel));
  await expect(
    within(panel).findByText(
      "This listing changed or expired. Refresh to continue.",
    ),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      fixture.requests
        .filter((request) => {
          return request.operation === "list.close";
        })
        .map((request) => {
          return request.params.cursor;
        }),
    ).toContain("wrong-cursor");
  });
  expect(within(panel).queryByText("wrong.txt")).toBeNull();
});

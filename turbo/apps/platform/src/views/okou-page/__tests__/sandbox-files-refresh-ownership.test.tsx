import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  entry,
  listing,
  openFiles,
  filesButton,
  setupFilesPage,
  type FilesReply,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("Collapsing a directory during automatic refresh releases a late cursor without continuing it", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  let childListings = 0;
  const fixture = await setupFilesPage(context, {
    handler: (request) => {
      if (Array.isArray(request.params.path) && request.params.path.length) {
        childListings++;
        return childListings === 1
          ? listing([entry("first.txt"), entry("second.txt")], null, "child")
          : response.promise;
      }
      return listing();
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  click(filesButton("workspace", panel));
  await expect(
    within(panel).findByText("second.txt"),
  ).resolves.toBeInTheDocument();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(childListings).toBe(2);
  });
  click(filesButton("workspace", panel));
  response.resolve(
    listing([entry("obsolete.txt")], "obsolete-cursor", "fresh-child"),
  );
  await waitFor(() => {
    expect(fixture.requests).toContainEqual(
      expect.objectContaining({
        operation: "list.close",
        params: { cursor: "obsolete-cursor" },
      }),
    );
  });
  expect(filesButton("workspace", panel)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(within(panel).queryByText("obsolete.txt")).toBeNull();
  expect(
    fixture.requests.some((request) => {
      return (
        request.operation === "list" &&
        request.params.cursor === "obsolete-cursor"
      );
    }),
  ).toBeFalsy();
});

test("A pending automatic snapshot cannot cross a reconnect or overlap a foreground round", async () => {
  const response = createDeferredPromise<FilesReply>(context.signal);
  let initialListings = 0;
  const fixture = await setupFilesPage(context, {
    handler: (_request, connection) => {
      if (connection > 0) {
        return listing([entry("new-epoch.txt")], null, "new-home");
      }
      initialListings++;
      return initialListings === 1
        ? listing([entry("first.txt"), entry("second.txt")])
        : response.promise;
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("second.txt"),
  ).resolves.toBeInTheDocument();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(initialListings).toBe(2);
  });
  fireEvent(document, new Event("visibilitychange"));
  expect(initialListings).toBe(2);
  expect(within(panel).getByText("second.txt")).toBeInTheDocument();
  act(() => {
    fixture.sockets[0]?.close();
  });
  await expect(
    within(panel).findByText("new-epoch.txt"),
  ).resolves.toBeInTheDocument();
  const requests = fixture.requests.length;
  await act(async () => {
    response.resolve(
      listing([entry("obsolete.txt")], "old-epoch-cursor", "old-home"),
    );
    await response.promise;
  });
  expect(fixture.requests).toHaveLength(requests);
  expect(within(panel).queryByText("obsolete.txt")).toBeNull();
  expect(within(panel).getByText("new-epoch.txt")).toBeInTheDocument();
});

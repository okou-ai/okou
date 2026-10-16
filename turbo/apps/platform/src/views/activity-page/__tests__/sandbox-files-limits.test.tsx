import { within } from "@testing-library/react";
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

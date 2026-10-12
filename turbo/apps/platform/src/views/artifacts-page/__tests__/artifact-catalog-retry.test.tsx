import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  artifact,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("A failed catalog read keeps its message while Try again reports the re-read", async () => {
  let attempts = 0;
  const secondRead = createDeferredPromise<void>(context.signal);
  context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
    attempts += 1;
    if (attempts === 1) {
      return respond(500, {
        error: { code: "INTERNAL", message: "Catalog unavailable" },
      });
    }
    await secondRead.promise;
    return respond(200, {
      artifacts: [artifact({ title: "recovered-plan.txt" })],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context);

  const message = await screen.findByText("Couldn't load artifacts.");
  const failure = message.closest<HTMLElement>('[role="status"]');
  if (!failure) {
    throw new Error("Expected the catalog failure to be a status region");
  }

  click(getButtonByName("Try again", failure));

  // The page used to swap the message for a skeleton, so the failure vanished
  // during the re-read and returned unchanged if it failed again. It now stays
  // and the button carries the in-flight state.
  try {
    await waitFor(() => {
      expect(getButtonByName("Try again", failure)).toHaveAttribute(
        "aria-busy",
        "true",
      );
    });
    expect(failure).toHaveTextContent("Couldn't load artifacts.");
  } finally {
    secondRead.resolve();
  }

  await expect(
    screen.findByText("recovered-plan.txt"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText("Couldn't load artifacts."),
  ).not.toBeInTheDocument();
});

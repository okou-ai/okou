import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";

const context = testContext();

test("A Clerk UI load failure reports the error without a partial auth form", async () => {
  const clerk = context.mocks.clerk();
  // Clerk's core script waits on the first gate; the hosted UI script that the
  // sign-in route requests later waits on the second.
  const core = clerk.resourcePending();
  const page = await startPage({ context, path: "/sign-in", auth: null });
  const ui = clerk.resourcePending();
  core.resolve();
  await waitFor(() => {
    expect(clerk.uiRequests).not.toStrictEqual([]);
  });

  clerk.resourceUnavailable(new Error("Clerk UI script failed to load"));
  ui.resolve();

  await page.content;
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Oops! Something went sideways",
  );
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
});

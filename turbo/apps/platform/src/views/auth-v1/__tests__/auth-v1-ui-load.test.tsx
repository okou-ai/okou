import * as clerkScript from "@clerk/shared/loadScript";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";

const context = testContext();

test("A Clerk UI load failure reports the error without a partial auth form", async () => {
  vi.spyOn(clerkScript, "loadScript").mockRejectedValueOnce(
    new Error("UI resource is unavailable"),
  );
  const page = await startPage({
    context,
    host: "app.okou.ai",
    path: "/sign-in",
    auth: null,
  });

  const alert = await screen.findByRole("alert");
  await page.ready;
  expect(alert).toHaveTextContent("Oops! Something went sideways");
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
});

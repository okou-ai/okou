import * as clerkScript from "@clerk/shared/loadScript";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test.each(["network", "missing export", "version mismatch"])(
  "A Clerk UI %s failure offers a visible refresh without a partial auth form",
  async (failure) => {
    // oxlint-disable-next-line no-console -- Preserve the test harness's fatal handling of every unexpected log.
    const unexpectedError = vi.mocked(console.error).getMockImplementation();
    // oxlint-disable-next-line no-console -- The expected SDK failure is asserted through its visible recovery UI below.
    vi.mocked(console.error).mockImplementation((...args) => {
      if (args.includes("Clerk UI failed to load")) {
        return;
      }
      unexpectedError?.(...args);
    });
    const loader = vi.spyOn(clerkScript, "loadScript");
    if (failure === "network") {
      loader.mockRejectedValueOnce(new Error("UI resource is unavailable"));
    } else {
      loader.mockImplementationOnce(() => {
        if (failure === "version mismatch") {
          Reflect.set(window, "__okouClerkUI", {
            version: "1.25.0",
            ClerkUI: function () {},
          });
        }
        return Promise.resolve(document.createElement("script"));
      });
    }
    const page = await startPage({
      context,
      host: "app.okou.ai",
      path: "/sign-in",
      auth: null,
    });

    const alert = await screen.findByRole("alert");
    await page.ready;
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    expect(alert).toHaveTextContent("Oops! Something went sideways");
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    const refresh = queryAllByRoleFast("button", alert).find((button) => {
      return button.textContent === "Refresh";
    });
    expect(refresh).toBeDefined();
    if (!refresh) {
      throw new Error("Refresh action is missing");
    }
    click(refresh);
    expect(reload).toHaveBeenCalledOnce();
  },
);

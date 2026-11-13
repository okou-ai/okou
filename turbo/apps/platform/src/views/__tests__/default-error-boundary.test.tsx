import { screen, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("The error page does not wait for the workspace worker", async () => {
  class PendingSharedWorker extends EventTarget {
    readonly port: MessagePort;

    constructor() {
      super();
      const channel = new MessageChannel();
      this.port = channel.port1;
      context.signal.addEventListener(
        "abort",
        () => {
          channel.port1.close();
          channel.port2.close();
        },
        { once: true },
      );
    }
  }
  vi.stubGlobal("SharedWorker", PendingSharedWorker);
  const page = await startPage({
    context,
    host: "app.okou.ai",
    path: "/_/error",
    sharedWorkerTestTransport: "browser",
  });
  await page.content;

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Oops! Something went sideways");
  expect(alert).toHaveTextContent("We're here to help");
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
});

test.each([false, true])(
  "The error page retains support and theme controls (dark: %s)",
  async (dark) => {
    context.mocks.browser.matchMedia(dark);
    await setupPage({
      context,
      host: "app.okou.ai",
      path: "/_/error",
      auth: null,
    });

    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("heading", {
        name: "Oops! Something went sideways",
      }),
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent("Give it another try or reach out");
    expect(alert).toHaveTextContent("We're here to help");
    const support = queryAllByRoleFast("link", alert).find((link) => {
      return link.textContent?.trim() === "support";
    });
    expect(support).toHaveAttribute("href", "mailto:contact@okou.ai");
    const home = queryAllByRoleFast("link").find((link) => {
      return link.querySelector('img[alt="Okou"]') !== null;
    });
    expect(home).toHaveAttribute("href", "/");

    const toggle = screen.getByLabelText("Toggle theme");
    expect(toggle).toHaveAttribute("aria-pressed", String(dark));
    click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-pressed", String(!dark));
    });
    expect(alert).toHaveTextContent("We're here to help");
  },
);

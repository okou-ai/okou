import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function control(role: "button" | "link", name: string): HTMLElement {
  const found = queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Expected the ${name} ${role}`);
  }
  return found;
}

test("The error page does not wait for the workspace worker", async () => {
  // The browser starts the workspace SharedWorker, which never answers.
  const asked = context.mocks.deferred<void>();
  class SilentSharedWorker extends EventTarget {
    readonly port: MessagePort;
    constructor() {
      super();
      const channel = new MessageChannel();
      channel.port2.addEventListener(
        "message",
        () => {
          asked.resolve();
        },
        { once: true },
      );
      channel.port2.start();
      this.port = channel.port1;
    }
  }
  vi.stubGlobal("SharedWorker", SilentSharedWorker);

  const page = await startPage({
    context,
    path: "/_/error",
    sharedWorkerTestTransport: "browser",
  });

  await page.content;
  await asked.promise;
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Oops! Something went sideways");
  expect(alert).toHaveTextContent("We're here to help");
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
});

test("The error page retains support and theme controls (dark: false)", async () => {
  await setupPage({ context, path: "/_/error", auth: null });
  const alert = await screen.findByRole("alert");
  const theme = control("button", "Toggle theme");
  expect(theme).toHaveAttribute("aria-pressed", "false");

  click(theme);

  await waitFor(() => {
    expect(theme).toHaveAttribute("aria-pressed", "true");
  });
  expect(alert).toHaveTextContent("We're here to help");
  expect(alert).toHaveTextContent("Give it another try or reach out");
  expect(
    queryAllByRoleFast("link", alert).map((link) => {
      return [link.textContent?.trim(), link.getAttribute("href")];
    }),
  ).toStrictEqual([["support", "mailto:contact@okou.ai"]]);
  expect(control("link", "Go to Okou home")).toHaveAttribute("href", "/");
});

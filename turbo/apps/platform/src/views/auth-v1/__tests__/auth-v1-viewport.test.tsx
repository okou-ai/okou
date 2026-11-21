import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import indexHtml from "../../../../index.html?raw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

/** The viewport meta the deployed document ships with. */
function installDeployedViewport(): {
  readonly meta: HTMLMetaElement;
  readonly appPolicy: string;
} {
  const deployed = new DOMParser()
    .parseFromString(indexHtml, "text/html")
    .querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!deployed) {
    throw new Error("index.html is missing its viewport meta");
  }
  const meta = document.importNode(deployed, true);
  document.head.append(meta);
  context.signal.addEventListener(
    "abort",
    () => {
      meta.remove();
    },
    { once: true },
  );
  return { meta, appPolicy: deployed.content };
}

function pinchPrevented(): boolean {
  return !fireEvent(
    document.body,
    new Event("gesturestart", { bubbles: true, cancelable: true }),
  );
}

function controlWheelPrevented(): boolean {
  // Happy DOM's WheelEvent drops modifier keys, so the trackpad pinch arrives
  // as its MouseEvent base with the same wheel type and Control key.
  return !fireEvent(
    document.body,
    new MouseEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true }),
  );
}

function visit(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

test("Leaving hosted auth restores the existing app zoom policy", async () => {
  const { meta, appPolicy } = installDeployedViewport();
  expect(appPolicy).toMatch(/user-scalable=no/u);

  await setupPage({ context, path: "/sign-in", auth: null });
  await expect(screen.findByTestId("app-sign-in")).resolves.toBeVisible();
  expect(pinchPrevented()).toBeFalsy();
  expect(controlWheelPrevented()).toBeFalsy();

  visit("/sign-up");

  await expect(screen.findByTestId("app-sign-up")).resolves.toBeVisible();
  expect(meta.content).not.toMatch(/maximum-scale|user-scalable/u);
  expect(pinchPrevented()).toBeFalsy();
  expect(controlWheelPrevented()).toBeFalsy();

  visit("/_/error");

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Oops! Something went sideways",
  );
  expect(meta.content).toBe(appPolicy);
  expect(pinchPrevented()).toBeTruthy();
  expect(controlWheelPrevented()).toBeTruthy();
});

import { act, createEvent, fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const DEFAULT_VIEWPORT =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";
const ACCESSIBLE_VIEWPORT =
  "width=device-width, initial-scale=1.0, viewport-fit=cover";

function installViewport(): HTMLMetaElement {
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = DEFAULT_VIEWPORT;
  document.head.append(viewport);
  context.signal.addEventListener(
    "abort",
    () => {
      viewport.remove();
    },
    { once: true },
  );
  return viewport;
}

function expectPinchPrevented(prevented: boolean): void {
  // Safari can target the document itself; this must not depend on the
  // gesture starting inside a particular Clerk child or app-owned wrapper.
  for (const eventName of ["gesturestart", "gesturechange"]) {
    const gesture = new Event(eventName, { bubbles: true, cancelable: true });
    fireEvent(document, gesture);
    expect(gesture.defaultPrevented).toBe(prevented);
  }
  const wheel = createEvent.wheel(document.body);
  Object.defineProperties(wheel, {
    ctrlKey: { value: true },
    deltaY: { value: -20 },
  });
  fireEvent(document.body, wheel);
  expect(wheel.defaultPrevented).toBe(prevented);
}

test.each([
  ["sign-in", ""],
  ["sign-up", ""],
  ["sign-in", "/tasks/choose-organization"],
  ["sign-up", "/verify-email-address"],
])("Hosted %s%s permits viewport zoom", async (mode, suffix) => {
  const viewport = installViewport();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: `/${mode}${suffix}`,
    auth: null,
  });

  expect(screen.getByTestId(`clerk-${mode}`)).toBeVisible();
  expect(viewport.content).toBe(ACCESSIBLE_VIEWPORT);
  expectPinchPrevented(false);
});

test("Leaving hosted auth restores the existing app zoom policy", async () => {
  const viewport = installViewport();
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/sign-in",
    auth: null,
  });
  expect(screen.getByTestId("clerk-sign-in")).toBeVisible();
  expectPinchPrevented(false);

  act(() => {
    window.history.pushState(null, "", "/sign-up");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(screen.findByTestId("clerk-sign-up")).resolves.toBeVisible();
  expect(viewport.content).toBe(ACCESSIBLE_VIEWPORT);
  expectPinchPrevented(false);

  act(() => {
    window.history.pushState(null, "", "/_/error");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    screen.findByText("Oops! Something went sideways"),
  ).resolves.toBeVisible();
  expect(viewport.content).toBe(DEFAULT_VIEWPORT);
  expectPinchPrevented(true);

  act(() => {
    window.history.back();
  });
  await expect(screen.findByTestId("clerk-sign-up")).resolves.toBeVisible();
  expect(viewport.content).toBe(ACCESSIBLE_VIEWPORT);
  expectPinchPrevented(false);
});

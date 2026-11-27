import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";
import indexHtml from "../../../../index.html?raw";

const context = testContext();

function openForm(path: string) {
  return setupPage({
    context,
    host: "app.okou.ai",
    auth: null,
    path,
  });
}

test("auth-v1-page-006 The nested organization task renders its base sign-in form alone", async () => {
  await openForm("/sign-in/tasks/choose-organization");
  const form = await screen.findByTestId("clerk-sign-in");
  expect(within(form).getByText("/sign-in")).toBeVisible();
  expect(screen.queryByTestId("clerk-google-one-tap")).toBeNull();
  expect(document.title).toBe("Sign in | Okou");
});

test("auth-v1-page-011 Trusted skeleton navigation survives sign-in, One Tap and registration", async () => {
  const target = "https://app.okou.ai/_/skeleton";
  context.mocks.browser.matchMedia(false);
  await openForm("/sign-in?" + new URLSearchParams({ redirect_url: target }));
  const form = await screen.findByTestId("clerk-sign-in");
  expect(form).toHaveAttribute("data-clerk-force-redirect-url", target);
  const signup = new URL(form.dataset.clerkSignUpUrl ?? "", location.href);
  expect(signup.pathname).toBe("/sign-up");
  expect(signup.searchParams.get("redirect_url")).toBe(target);
  expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
    "data-sign-in-force-redirect-url",
    target,
  );
  expect(document.title).toBe("Sign in | Okou");
  expect(screen.getByLabelText("Go to Okou home")).toHaveAttribute("href", "/");
});

test("auth-v1-page-015 Address verification keeps the theme on a sibling-site signup return", async () => {
  const target = "https://www.okou.ai/connector/success?vm0_theme=light";
  await openForm(
    "/sign-up/verify-email-address?" +
      new URLSearchParams({ redirect_url: target }),
  );
  await expect(screen.findByTestId("clerk-sign-up")).resolves.toHaveAttribute(
    "data-clerk-force-redirect-url",
    target,
  );
});

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

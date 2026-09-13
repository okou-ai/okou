import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  emitMockedClerkEvent,
  mockClerkSessionTransitioning,
} from "../../__tests__/mock-auth.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  expectComposerModel,
  mockAgent,
  mockOrgModelRoutes,
} from "../../views/okou-page/__tests__/chat-composer-test-helpers.ts";

const CUSTOMER_ORG_ID = "org_customer_workspace";

async function openTemplates() {
  click(await screen.findByLabelText("Template"));
  await screen.findByRole("dialog");
}

function introVideoTab() {
  return queryAllByRoleFast("tab").find((tab) => {
    return tab.textContent?.trim() === "Intro video";
  });
}

test("A signed-in workspace receives its enabled features", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.IntroVideo]: true,
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
  await openTemplates();
  await waitFor(() => {
    expect(introVideoTab()).toBeVisible();
  });
});

async function setupModelPickerRolloutPage(args: {
  readonly email: string;
  readonly fullName: string;
  readonly userId: string;
}) {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: {
        [FeatureSwitchKey.ModelPickerMenu]: false,
        [FeatureSwitchKey.IntroVideo]: true,
      },
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: {
      user: { id: args.userId, fullName: args.fullName, email: args.email },
      organization: {
        activeOrg: { id: CUSTOMER_ORG_ID, name: "Customer" },
        memberships: [{ id: CUSTOMER_ORG_ID }],
      },
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
  // The intro video tab is visible only after the workspace feature response
  // has been applied, so it marks the end of feature hydration.
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByLabelText("Template"));
  await screen.findByRole("dialog");
  await waitFor(() => {
    expect(introVideoTab()).toBeVisible();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
}

// The legacy picker renders its trigger as a <button role="combobox">; only
// the model picker menu renders a plain button named after the model.
function modelMenuTrigger(): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    const role = button.getAttribute("role");
    return (
      (role === null || role === "button") &&
      (button.getAttribute("aria-label") === "Claude Sonnet 4.6" ||
        button.textContent?.trim() === "Claude Sonnet 4.6")
    );
  });
}

test("Bingjie retains the model picker menu rollout after hydration", async () => {
  await setupModelPickerRolloutPage({
    email: "BINGJIE@OKOU.AI",
    fullName: "Bingjie",
    userId: "user_bingjie",
  });

  const trigger = await waitFor(() => {
    const button = modelMenuTrigger();
    if (!button) {
      throw new Error("Expected the model picker menu trigger");
    }
    return button;
  });
  click(trigger);
  await expect(
    screen.findByRole("region", { name: "Models" }),
  ).resolves.toBeVisible();
});

test("another member does not receive the model picker menu rollout", async () => {
  await setupModelPickerRolloutPage({
    email: "ethan@okou.ai",
    fullName: "Another member",
    userId: "user_other_member",
  });

  await expectComposerModel("Claude Sonnet 4.6");
  expect(modelMenuTrigger()).toBeUndefined();
});

test("Image recognition remains available by default", async () => {
  const user = userEvent.setup({ delay: null });
  mockOrgModelRoutes("claude-opus-5");
  mockAgent();
  context.mocks.upload.success({
    id: "default-image-recognition-upload",
    filename: "workspace-map.png",
    contentType: "image/png",
    size: 3,
    url: "https://example.com/workspace-map.png",
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await expectComposerModel("Claude Opus 5");
  const fileInput =
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) {
    throw new Error("Composer file input not found");
  }

  await user.upload(
    fileInput,
    new File(["png"], "workspace-map.png", { type: "image/png" }),
  );

  await expect(
    screen.findByLabelText("Open image preview for workspace-map.png"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByText(/Claude Opus 5 cannot recognize images or videos/iu),
  ).not.toBeInTheDocument();
});

test("A signed-out page does not load workspace features", async () => {
  let workspaceFeatureRequested = false;
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    workspaceFeatureRequested = true;
    return respond(200, {
      switches: { [FeatureSwitchKey.AhrefsConnector]: true },
      effectiveSwitches: { [FeatureSwitchKey.AhrefsConnector]: true },
    });
  });

  await setupPage({
    context,
    path: "/sign-in",
    auth: null,
  });

  // Hosted Clerk owns the form, so the mounted component marks readiness.
  await screen.findByTestId("clerk-sign-in");

  expect(screen.queryByText("Ahrefs")).not.toBeInTheDocument();
  expect(workspaceFeatureRequested).toBeFalsy();
});

test("A feature response is discarded after identity changes", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  const requestStarted = context.mocks.deferred<void>();
  const requestCancelled = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  let originalRequestPending = true;
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, signal, withSignal }) => {
      if (!originalRequestPending) {
        return respond(200, {
          switches: { [FeatureSwitchKey.Lab]: true },
          effectiveSwitches: { [FeatureSwitchKey.Lab]: true },
        });
      }
      originalRequestPending = false;
      signal.addEventListener(
        "abort",
        () => {
          requestCancelled.resolve(undefined);
        },
        { once: true },
      );
      requestStarted.resolve(undefined);
      await withSignal(releaseResponse.promise);
      return respond(200, {
        switches: {
          [FeatureSwitchKey.IntroVideo]: true,
        },
        effectiveSwitches: {
          [FeatureSwitchKey.IntroVideo]: true,
        },
      });
    },
  );

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await screen.findByRole("textbox", { name: "Message" });
  await openTemplates();
  expect(introVideoTab()).toBeUndefined();
  await requestStarted.promise;

  mockClerkSessionTransitioning(true);
  await requestCancelled.promise;
  releaseResponse.resolve(undefined);
  mockClerkSessionTransitioning(false);

  expect(introVideoTab()).toBeUndefined();
});

test("The same identity can finish feature loading through an auth refresh", async () => {
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockAgent();
  const requestStarted = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    requestStarted.resolve(undefined);
    await releaseResponse.promise;
    return respond(200, {
      switches: {
        [FeatureSwitchKey.IntroVideo]: true,
      },
      effectiveSwitches: {
        [FeatureSwitchKey.IntroVideo]: true,
      },
    });
  });

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await screen.findByRole("textbox", { name: "Message" });
  await openTemplates();
  expect(introVideoTab()).toBeUndefined();
  await requestStarted.promise;

  emitMockedClerkEvent();
  releaseResponse.resolve(undefined);

  await waitFor(() => {
    expect(introVideoTab()).toBeVisible();
  });
});

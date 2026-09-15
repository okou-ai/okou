import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  startPage,
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

async function setupEffortRolloutPage(args: {
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
        [FeatureSwitchKey.RefactorModelSelect]: false,
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
  // Routes start only after the workspace feature response has been applied.
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

// The effort control names itself after the level it carries, and it renders
// only for a user the switch reaches.
function effortTrigger(): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label")?.startsWith("Effort, ");
  });
}

test("Bingjie retains the chat effort rollout after feature loading", async () => {
  await setupEffortRolloutPage({
    email: "BINGJIE@OKOU.AI",
    fullName: "Bingjie",
    userId: "user_bingjie",
  });

  const trigger = await waitFor(() => {
    const button = effortTrigger();
    if (!button) {
      throw new Error("Expected the chat effort control");
    }
    return button;
  });
  click(trigger);
  await expect(
    screen.findByRole("slider", { name: "Effort" }),
  ).resolves.toBeVisible();
});

test("another member does not receive the chat effort rollout", async () => {
  await setupEffortRolloutPage({
    email: "ethan@okou.ai",
    fullName: "Another member",
    userId: "user_other_member",
  });

  await expectComposerModel("Claude Sonnet 4.6");
  expect(effortTrigger()).toBeUndefined();
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

test("Routes wait for authoritative workspace features", async () => {
  const requestStarted = context.mocks.deferred<void>();
  const releaseResponse = context.mocks.deferred<void>();
  context.mocks.api(
    featureSwitchesContract.get,
    async ({ respond, withSignal }) => {
      requestStarted.resolve(undefined);
      await withSignal(releaseResponse.promise);
      return respond(200, {
        switches: {},
        effectiveSwitches: {},
      });
    },
  );

  const page = await startPage({ context, path: "/agents" });
  await requestStarted.promise;
  await expect(screen.findByTestId("app-skeleton")).resolves.toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Agents" }),
  ).not.toBeInTheDocument();

  releaseResponse.resolve(undefined);
  await page.ready;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
});

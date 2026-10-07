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
  mockAgent,
  mockPersonalModelRoutes,
} from "../../views/okou-page/__tests__/chat-composer-test-helpers.ts";
import { bootstrapSkeleton } from "../../test/bootstrap-skeleton.ts";

const CUSTOMER_ORG_ID = "org_customer_workspace";

async function openTemplates() {
  click(await screen.findByLabelText("Template"));
  await screen.findByRole("dialog");
}

test("A signed-in workspace receives its enabled features", async () => {
  mockPersonalModelRoutes();
  mockAgent();

  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: true,
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
  await openTemplates();
  await waitFor(() => {
    expect(customTemplatesTab()).toBeVisible();
  });
});

// The workspace response cannot evaluate an email allowlist, so the email
// defaults are reapplied on top of it. Custom templates own that allowlist.
async function setupEmailRolloutPage(args: {
  readonly email: string;
  readonly fullName: string;
  readonly userId: string;
}) {
  mockPersonalModelRoutes();
  mockAgent();
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: {
        [FeatureSwitchKey.CustomTemplates]: false,
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

  // Routes start only after the workspace feature response has been applied,
  // so reaching the composer already proves the server payload landed and the
  // email defaults were reapplied on top of it.
  await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByLabelText("Template"));
  await screen.findByRole("dialog");
}

function customTemplatesTab(): HTMLElement | undefined {
  return queryAllByRoleFast("tab").find((tab) => {
    return tab.textContent?.trim() === "Custom";
  });
}

test("Bingjie retains the custom template rollout after feature loading", async () => {
  await setupEmailRolloutPage({
    email: "BINGJIE@OKOU.AI",
    fullName: "Bingjie",
    userId: "user_bingjie",
  });

  await waitFor(() => {
    expect(customTemplatesTab()).toBeVisible();
  });
});

test("another member does not receive the custom template rollout", async () => {
  await setupEmailRolloutPage({
    email: "ethan@okou.ai",
    fullName: "Another member",
    userId: "user_other_member",
  });

  expect(customTemplatesTab()).toBeUndefined();
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
  expect(bootstrapSkeleton()).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Agents" }),
  ).not.toBeInTheDocument();

  releaseResponse.resolve(undefined);
  await page.ready;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
});

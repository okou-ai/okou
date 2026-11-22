import { featureGuidesContract } from "@okouai/api-contracts/contracts/feature-guides";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { bootstrapSkeleton } from "../../../test/bootstrap-skeleton.ts";

const context = testContext();
const workspace = {
  context,
  path: "/workflows",
  sharedWorkerTestTransport: "message-port",
} as const;
function startupView() {
  const skeleton = bootstrapSkeleton();
  return {
    loading:
      !skeleton.hidden && skeleton.getAttribute("aria-hidden") !== "true",
    root: document.getElementById("root")?.hasChildNodes() ?? false,
    heading: screen.queryByRole("heading", { name: "Workflows" }) !== null,
    links: queryAllByRoleFast("link").length,
  };
}

test("authentication-startup-001 Workflows stays hidden until the current member's identity is ready", async () => {
  const sdk = context.mocks.clerk();
  const identity = sdk.runtimePending();
  const page = await startPage(workspace);
  await vi.waitUntil(() => {
    return sdk.loads.length > 0;
  });
  const held = startupView();
  identity.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(held).toMatchObject({ loading: true, heading: false, links: 0 });
  expect(bootstrapSkeleton()).toHaveAttribute("aria-hidden", "true");
  expect(queryAllByRoleFast("link").length).toBeGreaterThan(0);
  expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
});
test("bootstrap-feature-switch-002 Workspace features release the page and the feature guide request", async () => {
  const arrived = context.mocks.deferred<void>(),
    reply = context.mocks.deferred<void>();
  const guide = context.mocks.deferred<void>();
  const editions: string[] = [];
  context.mocks.api(featureGuidesContract.current, ({ request, respond }) => {
    editions.push(new URL(request.url).pathname);
    if (!guide.settled()) {
      guide.resolve();
    }
    return respond(200, { edition: null });
  });
  context.mocks.api(featureSwitchesContract.get, async ({ respond }) => {
    if (!arrived.settled()) {
      arrived.resolve();
    }
    await reply.promise;
    return respond(200, { switches: {}, effectiveSwitches: {} });
  });
  const page = await startPage(workspace);
  await arrived.promise;
  const held = { ...startupView(), editions: [...editions] };
  reply.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  await guide.promise;
  expect(held).toMatchObject({ loading: true, root: false, editions: [] });
  expect(editions).toStrictEqual([featureGuidesContract.current.path]);
});
test("authentication-startup-013 An old onboarding response cannot redirect the member after the active workspace changes", async () => {
  const clerk = context.mocks.clerk();
  const held = context.mocks.deferred<void>(),
    release = context.mocks.deferred<void>();
  const identities: string[] = [];
  context.mocks.api(
    onboardingStatusContract.getStatus,
    async ({ respond, request }) => {
      identities.push(new URL(request.url).pathname);
      if (!held.settled()) {
        held.resolve();
      }
      await release.promise;
      return respond(200, {
        needsOnboarding: true,
        onboardingComplete: false,
        isAdmin: true,
        hasOrg: true,
      });
    },
  );
  const page = await startPage(workspace);
  await held.promise;
  clerk.organization({
    activeOrg: { id: "org_current", name: "Current workspace" },
    memberships: [{ id: "org_current" }],
  });
  release.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  expect(identities).toStrictEqual([onboardingStatusContract.getStatus.path]);
  await waitFor(() => {
    return expect(location.pathname).toBe("/workflows");
  });
  expect(
    screen.queryByRole("heading", {
      name: /what do you want to make first|onboarding/i,
    }),
  ).toBeNull();
});

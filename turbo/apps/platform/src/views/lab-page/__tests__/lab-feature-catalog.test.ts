import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  getFeatureSwitchMetadata,
  isFeatureSwitchAvailable,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const orgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const user = {
  id: "user_lab_reader",
  fullName: "Lab Reader",
  email: "lab-reader@example.com",
} as const;

async function visitLab(banking = false, useSavedSwitches = false) {
  await setupPage({
    path: "/_/lab",
    context,
    auth: {
      user,
      organization: {
        activeOrg: { id: orgId, name: "Lab workspace" },
        memberships: [{ id: orgId }],
      },
    },
    ...(useSavedSwitches
      ? {}
      : {
          featureSwitches: {
            [FeatureSwitchKey.Lab]: true,
            [FeatureSwitchKey.Banking]: banking,
          },
        }),
  });
  await screen.findByText(FeatureSwitchKey.Banking, { exact: true });
}

function stageOf(key: FeatureSwitchKey) {
  return screen
    .getByText(key, { exact: true })
    .closest("section")
    ?.querySelector("h2")?.textContent;
}

test("lab-page-001 Lab still lists enabled Banking in Alpha when the member needs onboarding", async () => {
  context.mocks.api(onboardingStatusContract.getStatus, ({ respond }) => {
    return respond(200, {
      needsOnboarding: true,
      onboardingComplete: false,
      isAdmin: true,
      hasOrg: true,
    });
  });
  await visitLab(true);
  expect(screen.getByRole("heading", { name: "Lab" })).toBeVisible();
  expect(stageOf(FeatureSwitchKey.Banking)).toBe("Alpha");
  expect(screen.getByRole("switch", { name: /^banking\b/i })).toBeChecked();
});

test("lab-page-002 Each staff-visible feature has exactly one switch under its rollout heading", async () => {
  await visitLab();
  const catalog = getFeatureSwitchMetadata();
  const expected = Object.values(FeatureSwitchKey)
    .filter((key) => {
      return isFeatureSwitchAvailable(key, {
        orgId,
        userId: user.id,
        email: user.email,
      });
    })
    .map((key) => {
      return [catalog[key].rolloutStage, catalog[key].displayName ?? key].join(
        "/",
      );
    })
    .sort();
  const actual = screen
    .getAllByRole("listitem")
    .filter((row) => {
      return row.querySelector('[role="switch"]');
    })
    .map((row) => {
      const title = row
        .closest("section")
        ?.querySelector("h2")
        ?.textContent?.toLowerCase();
      return [title, row.querySelector("label span")?.textContent].join("/");
    });
  expect(actual.sort()).toStrictEqual(expected);
  expect(stageOf(FeatureSwitchKey.Banking)).toBe("Alpha");
  expect(stageOf(FeatureSwitchKey.TestOauthConnector)).toBe("Internal");
  expect(getButtonByName("Reset all")).toBeEnabled();
});

test("lab-page-005 Filtering the Lab catalog preserves the All total and restores its full switch list", async () => {
  await visitLab();
  const all = screen.getByText("All", { exact: true }).closest("button")!;
  const original = screen.getAllByRole("switch").length;
  expect(all).toHaveTextContent(String(original));
  click(screen.getByText("bingjie", { exact: true }));
  expect(screen.getByText(FeatureSwitchKey.PresentationConvert)).toBeVisible();
  expect(screen.queryByText(FeatureSwitchKey.Banking)).toBeNull();
  expect(screen.getAllByRole("switch").length).toBeLessThan(original);
  expect(all).toHaveTextContent(String(original));
  click(all);
  expect(screen.getByText(FeatureSwitchKey.Banking)).toBeVisible();
  expect(screen.getAllByRole("switch")).toHaveLength(original);
});

test("lab-page-006 Reset all restores the test OAuth connector's original off state", async () => {
  let overrides: Partial<Record<FeatureSwitchKey, boolean>> = {};
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: overrides, effectiveSwitches: overrides });
  });
  context.mocks.api(featureSwitchesContract.update, ({ respond, body }) => {
    overrides = { ...overrides, ...body.switches };
    return respond(200, { switches: overrides, effectiveSwitches: overrides });
  });
  context.mocks.api(featureSwitchesContract.delete, ({ respond }) => {
    overrides = {};
    return respond(200, { deleted: true });
  });
  await visitLab(false, true);
  const label = screen
    .getByText(FeatureSwitchKey.TestOauthConnector)
    .closest("label")!;
  const toggle = within(label).getByRole("switch");
  expect(toggle).not.toBeChecked();
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toBeChecked();
  });
  const reset = getButtonByName("Reset all");
  await waitFor(() => {
    return expect(reset).toBeEnabled();
  });
  click(reset);
  await waitFor(() => {
    return expect(toggle).not.toBeChecked();
  });
});

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { getButtonByName } from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { onboardingStatusContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  getAllFeatureStates,
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
  const banking = screen.getByRole("switch", {
    name: FeatureSwitchKey.Banking,
  });
  expect(banking).toBeChecked();
  expect(banking).toHaveAccessibleDescription(
    getFeatureSwitchMetadata()[FeatureSwitchKey.Banking].description,
  );
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
      const { rolloutStage } = catalog[key];
      return [rolloutStage, key].join("/");
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

test.each([[FeatureSwitchKey.PresentationOutputFormat, "Beta"]] as const)(
  "Staff see %s enabled by default in %s",
  async (key, stage) => {
    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: {},
        effectiveSwitches: getAllFeatureStates({ userId: user.id, orgId }),
      });
    });
    await visitLab(false, true);
    const row = screen.getByText(key, { exact: true }).closest("li")!;
    expect(row.closest("section")?.querySelector("h2")).toHaveTextContent(
      stage,
    );
    expect(within(row).getByRole("switch")).toBeChecked();
  },
);

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
  const featureKey = FeatureSwitchKey.TestOauthConnector;
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
  await setupPage({ context, path: "/_/lab" });
  const label = (await screen.findByText(featureKey, { exact: true })).closest(
    "label",
  )!;
  const toggle = within(label).getByRole("switch");
  expect(toggle).toHaveAttribute("aria-checked", "false");
  click(toggle);
  await waitFor(() => {
    return expect(toggle).toHaveAttribute("aria-checked", "true");
  });
  const reset = getButtonByName("Reset all");
  await waitFor(() => {
    return expect(reset).toBeEnabled();
  });
  click(reset);
  await waitFor(() => {
    return expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});

test("Any Lab tester can find presentation format in Beta, opt in, and reset it", async () => {
  const featureKey = FeatureSwitchKey.PresentationOutputFormat;
  let switches: Record<string, boolean> = { [FeatureSwitchKey.Lab]: true };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    switches = { ...switches, ...body.switches };
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(featureSwitchesContract.delete, ({ respond }) => {
    switches = { [FeatureSwitchKey.Lab]: true };
    return respond(200, { deleted: true });
  });
  await setupPage({
    context,
    path: "/_/lab",
    auth: {
      user: {
        id: "presentation-format-tester",
        fullName: "bingjie",
        email: "bingjie-tester@example.test",
      },
    },
  });

  await screen.findByRole("heading", { name: "Lab" });
  click(getButtonByName("bingjie"));
  const row = screen.getByText(featureKey, { exact: true }).closest("li")!;
  expect(row.closest("section")?.querySelector("h2")).toHaveTextContent("Beta");
  const control = within(row).getByRole("switch");
  expect(control).toHaveAttribute("aria-checked", "false");

  click(control);
  await waitFor(() => {
    expect(control).toHaveAttribute("aria-checked", "true");
  });

  const reset = getButtonByName("Reset all");
  await waitFor(() => {
    return expect(reset).toBeEnabled();
  });
  click(reset);
  await waitFor(() => {
    expect(control).toHaveAttribute("aria-checked", "false");
  });
});

test("Lab reads the embedded Banking preference before showing the service's later updates", async () => {
  const banking = FeatureSwitchKey.Banking;
  const bootstrap = document.createElement("script");
  bootstrap.type = "application/json";
  bootstrap.dataset.okouApiBootstrap = "";
  bootstrap.dataset.method = "GET";
  bootstrap.dataset.path = encodeURIComponent("/api/feature-switches");
  bootstrap.dataset.contentType = "application/json";
  bootstrap.textContent = JSON.stringify({
    switches: { [banking]: true },
    effectiveSwitches: { [banking]: true },
  });
  document.head.append(bootstrap);
  let network = false;
  const confirmed = new Map<string | null, boolean>();
  mockedClerk.sessionGetToken.mockResolvedValue("lab-reader");
  context.mocks.api(featureSwitchesContract.get, ({ request, respond }) => {
    confirmed.set(request.headers.get("Authorization"), network);
    return respond(200, {
      switches: { [banking]: network },
      effectiveSwitches: { [banking]: network },
    });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    network = Boolean(body.switches[banking]);
    return respond(200, {
      switches: { [banking]: network },
      effectiveSwitches: { [banking]: network },
    });
  });
  context.mocks.api(featureSwitchesContract.delete, ({ respond }) => {
    network = true;
    return respond(200, { deleted: true });
  });
  try {
    await visitLab(false, true);
    const toggle = () => {
      return screen.getByRole("switch", { name: FeatureSwitchKey.Banking });
    };
    expect(toggle()).toBeChecked();
    mockedClerk.sessionGetToken.mockResolvedValue("lab-editor");
    click(toggle());
    await waitFor(() => {
      expect([...confirmed]).toContainEqual(["Bearer lab-editor", false]);
      expect(toggle()).not.toBeChecked();
      expect(toggle()).toBeEnabled();
    });
    const reset = getButtonByName("Reset all");
    await waitFor(() => {
      expect(reset).toBeEnabled();
    });
    mockedClerk.sessionGetToken.mockResolvedValue("lab-reset");
    click(reset);
    await waitFor(() => {
      expect([...confirmed]).toContainEqual(["Bearer lab-reset", true]);
      expect(toggle()).toBeChecked();
    });
  } finally {
    bootstrap.remove();
  }
});

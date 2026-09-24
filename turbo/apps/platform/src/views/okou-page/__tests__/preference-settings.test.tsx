import { screen, waitFor, within } from "@testing-library/react";
import {
  morningBriefPreferenceContract,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function expectUnifiedSection(
  section: "preference" | "model" | "debug",
  heading: "Preference" | "Models" | "Debug",
): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(dialog).getByRole("heading", { name: heading })).toBeVisible();
  expect(pathname()).toBe("/agents");
  const params = new URLSearchParams(search());
  expect(params.get("settings")).toBe(section);
  expect(params.has("tab")).toBeFalsy();
}

describe("unified preference settings", () => {
  it.each(["/settings"])(
    "maps the legacy preference URL %s into unified Settings",
    async (path) => {
      await setupPage({ context, path });

      await expectUnifiedSection("preference", "Preference");
      expect(pathname()).toBe("/agents");
    },
  );

  it.each(["/settings?tab=model-configuration"])(
    "maps the legacy model URL %s into unified Settings",
    async (path) => {
      await setupPage({ context, path });

      await expectUnifiedSection("model", "Models");
      expect(pathname()).toBe("/agents");
    },
  );

  it("retains the unified Debug visibility fallback for legacy links", async () => {
    await setupPage({ context, path: "/preferences?tab=debug" });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(dialog).getByRole("heading", { name: "Preference" }),
    ).toBeVisible();
    expect(within(dialog).queryByText("Debug")).not.toBeInTheDocument();
    expect(pathname()).toBe("/agents");
    expect(new URLSearchParams(search()).get("settings")).toBe("debug");
  });

  it("hides email subscriptions and Morning Brief when only Official Workflows is available", async () => {
    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.MorningBrief]: false,
        [FeatureSwitchKey.OfficialWorkflows]: true,
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(dialog).queryByTestId("morning-brief-preference"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("region", { name: "Email subscriptions" }),
    ).not.toBeInTheDocument();
  });

  it("shows Morning Brief without requiring Official Workflows", async () => {
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      return respond(200, {
        enabled: false,
        status: "paused",
        unavailableReason: null,
      });
    });

    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.OfficialWorkflows]: false,
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await expect(
      within(dialog).findByTestId("morning-brief-preference"),
    ).resolves.toBeVisible();
  });

  it("updates Morning Brief and renders its actionable conflict state", async () => {
    const captured: boolean[] = [];
    let preference: MorningBriefPreferenceResponse = {
      enabled: false,
      status: "paused",
      unavailableReason: null,
    };
    let conflicted = false;
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      if (conflicted) {
        return respond(409, {
          error: {
            code: "MORNING_BRIEF_STATE_CONFLICT",
            message: "conflict",
          },
        });
      }
      return respond(200, preference);
    });
    context.mocks.api(
      morningBriefPreferenceContract.update,
      ({ body, respond }) => {
        captured.push(body.enabled);
        if (!body.enabled) {
          conflicted = true;
          return respond(409, {
            error: {
              code: "MORNING_BRIEF_STATE_CONFLICT",
              message: "conflict",
            },
          });
        }
        preference = {
          enabled: true,
          status: "enabled",
          unavailableReason: null,
        };
        return respond(200, preference);
      },
    );

    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.OfficialWorkflows]: false,
      },
    });
    const toggle = await screen.findByRole("switch", {
      name: "Morning brief",
    });
    click(toggle);
    await waitFor(() => {
      expect(captured).toStrictEqual([true]);
      expect(toggle).toBeChecked();
    });

    click(toggle);
    await waitFor(() => {
      expect(
        screen.getByText(/Morning Brief is temporarily unavailable/u),
      ).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      const retry = queryAllByRoleFast("button").find((button) => {
        return button.textContent === "Retry";
      });
      expect(retry).toBeEnabled();
    });
  });
});

test("shows pending Morning Brief enrollment and accepts cancellation", async () => {
  let preference: MorningBriefPreferenceResponse = {
    enabled: true,
    status: "preparing",
    unavailableReason: null,
  };
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    ({ body, respond }) => {
      preference = {
        ...preference,
        enabled: body.enabled,
        status: body.enabled ? "preparing" : "paused",
      };
      return respond(200, preference);
    },
  );
  await setupPage({ context, path: "/agents?settings=preference" });
  const card = await screen.findByTestId("morning-brief-preference");
  await expect(
    within(card).findByText(
      "Preparing your first Morning Brief. You can turn it off at any time.",
    ),
  ).resolves.toBeVisible();
  const toggle = within(card).getByRole("switch", { name: "Morning brief" });
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  click(toggle);
  await waitFor(() => {
    expect(
      within(card).getByRole("switch", { name: "Morning brief" }),
    ).not.toBeChecked();
  });
  click(within(card).getByRole("switch", { name: "Morning brief" }));
  await waitFor(() => {
    expect(
      within(card).getByRole("switch", { name: "Morning brief" }),
    ).toBeChecked();
  });
});

test("keeps the Morning Brief toggle disabled while an unavailable reason is reported", async () => {
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, {
      enabled: false,
      status: "paused",
      unavailableReason: "missing-default-agent",
    });
  });
  await setupPage({ context, path: "/agents?settings=preference" });
  const card = await screen.findByTestId("morning-brief-preference");
  await expect(
    within(card).findByText(
      "Choose a usable default Agent before enabling Morning Brief.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    within(card).getByRole("switch", { name: "Morning brief" }),
  ).toHaveAttribute("aria-disabled", "true");
});

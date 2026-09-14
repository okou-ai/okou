import { screen, waitFor, within } from "@testing-library/react";
import {
  morningBriefPreferenceContract,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockScrollIntoView(): ReturnType<typeof vi.fn> {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          descriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    },
    { once: true },
  );
  return scrollIntoView;
}

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
  it.each([
    "/settings",
    "/preferences",
    "/settings?tab=appearance",
    "/preferences?tab=timezone",
  ])(
    "maps the legacy preference URL %s into unified Settings",
    async (path) => {
      await setupPage({ context, path });

      await expectUnifiedSection("preference", "Preference");
      expect(pathname()).toBe("/agents");
    },
  );

  it.each([
    "/settings?tab=model-configuration",
    "/preferences?tab=personal-providers",
  ])("maps the legacy model URL %s into unified Settings", async (path) => {
    await setupPage({ context, path });

    await expectUnifiedSection("model", "Models");
    expect(pathname()).toBe("/agents");
  });

  it("maps a visible legacy Debug tab into unified Debug Settings", async () => {
    await setupPage({
      context,
      path: "/settings?tab=debug",
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await expectUnifiedSection("debug", "Debug");
    expect(pathname()).toBe("/agents");
  });

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

  it("updates the shell document color theme", async () => {
    context.mocks.data.userPreferences({ colorTheme: "blue-horizon" });

    await setupPage({
      context,
      path: "/agents?settings=preference",
      featureSwitches: {
        [FeatureSwitchKey.GradientColorThemes]: true,
      },
    });

    const colorTheme = await screen.findByRole("group", {
      name: "Color theme",
    });
    expect(document.documentElement).toHaveAttribute(
      "data-color-theme",
      "blue-horizon",
    );

    const goldenHourButton = queryAllByRoleFast("button", colorTheme).find(
      (candidate) => {
        return candidate.textContent?.trim() === "Golden hour";
      },
    );
    if (!goldenHourButton) {
      throw new Error("Golden hour button not found");
    }
    click(goldenHourButton);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-color-theme",
        "golden-hour",
      );
      expect(goldenHourButton).toHaveAttribute("aria-pressed", "true");
    });
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
        nextRunAt: null,
        timezone: "Asia/Shanghai",
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

  it("preserves the legacy Morning Brief focus and displays its authoritative next brief", async () => {
    const scrollIntoView = mockScrollIntoView();
    const nextRunAt = "2030-01-02T23:30:00.000Z";
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      return respond(200, {
        enabled: true,
        status: "enabled",
        nextRunAt,
        timezone: "Asia/Shanghai",
        unavailableReason: null,
      });
    });

    await setupPage({
      context,
      path: "/settings?tab=timezone&focus=morning-brief",
      featureSwitches: {
        [FeatureSwitchKey.MorningBrief]: true,
        [FeatureSwitchKey.OfficialWorkflows]: false,
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const card = within(dialog).getByTestId("morning-brief-preference");
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Shanghai",
    }).format(new Date(nextRunAt));
    expect(
      within(dialog).getByText(`Next brief ${formatted} (Asia/Shanghai)`),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("switch", { name: "Morning brief" }),
    ).toBeChecked();
    expect(within(dialog).queryByText("Send now")).not.toBeInTheDocument();
    expect(pathname()).toBe("/agents");
    const params = new URLSearchParams(search());
    expect(params.get("settings")).toBe("preference");
    expect(params.get("focus")).toBe("morning-brief");
    expect(params.has("tab")).toBeFalsy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(card).toHaveFocus();
  });

  it("updates Morning Brief and renders its actionable conflict state", async () => {
    const captured: boolean[] = [];
    let preference: MorningBriefPreferenceResponse = {
      enabled: false,
      status: "paused",
      nextRunAt: null,
      timezone: "Asia/Shanghai",
      unavailableReason: null,
    };
    let conflicted = false;
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      if (conflicted) {
        return respond(409, {
          error: {
            code: "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
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
              code: "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
              message: "conflict",
            },
          });
        }
        preference = {
          enabled: true,
          status: "enabled",
          nextRunAt: "2030-01-02T23:00:00.000Z",
          timezone: "Asia/Shanghai",
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
        screen.getByText(/Multiple Morning Brief installations exist/u),
      ).toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      const retry = queryAllByRoleFast("button").find((button) => {
        return button.textContent === "Retry";
      });
      expect(retry).toBeEnabled();
    });
  });
});

test("shows pending Morning Brief enrollment, accepts cancellation, and receives completion through realtime", async () => {
  let preference: MorningBriefPreferenceResponse = {
    enabled: true,
    status: "preparing",
    nextRunAt: null,
    timezone: "Asia/Shanghai",
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
  preference = {
    ...preference,
    status: "enabled",
    nextRunAt: "2030-01-02T23:00:00.000Z",
  };
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("morningBriefChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("morningBriefChanged");
  await waitFor(() => {
    expect(within(card).getByText(/Next brief/)).toBeVisible();
  });
  expect(
    within(card).queryByText(
      "Preparing your first Morning Brief. You can turn it off at any time.",
    ),
  ).toBeNull();
});

test("keeps the Morning Brief toggle disabled while an unavailable reason is reported", async () => {
  let preference: MorningBriefPreferenceResponse = {
    enabled: false,
    status: "paused",
    nextRunAt: null,
    timezone: "Asia/Shanghai",
    unavailableReason: "missing-default-agent",
  };
  const updated: boolean[] = [];
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    ({ body, respond }) => {
      updated.push(body.enabled);
      preference = {
        ...preference,
        enabled: body.enabled,
        status: "preparing",
      };
      return respond(200, preference);
    },
  );
  await setupPage({ context, path: "/agents?settings=preference" });
  const card = await screen.findByTestId("morning-brief-preference");
  await expect(
    within(card).findByText(
      "Choose a usable default Agent before enabling Morning Brief.",
    ),
  ).resolves.toBeVisible();
  expect(
    within(card).getByRole("switch", { name: "Morning brief" }),
  ).toHaveAttribute("aria-disabled", "true");

  preference = { ...preference, unavailableReason: null };
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("morningBriefChanged"),
    ).toBeTruthy();
  });
  context.mocks.ably.trigger("morningBriefChanged");
  await waitFor(() => {
    expect(
      within(card).getByRole("switch", { name: "Morning brief" }),
    ).toBeEnabled();
  });
  click(within(card).getByRole("switch", { name: "Morning brief" }));
  await waitFor(() => {
    expect(updated).toStrictEqual([true]);
  });
});

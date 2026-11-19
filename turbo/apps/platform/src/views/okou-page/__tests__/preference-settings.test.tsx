import { screen, waitFor, within } from "@testing-library/react";
import {
  morningBriefPreferenceContract,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { describe, expect, it, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("keeps the Morning Brief switch on while the platform recovers its schedule", async () => {
  let preference: MorningBriefPreferenceResponse = {
    enabled: true,
    status: "error",
    unavailableReason: null,
  };
  context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
    return respond(200, preference);
  });
  context.mocks.api(
    morningBriefPreferenceContract.update,
    ({ body, respond }) => {
      preference = { ...preference, enabled: body.enabled, status: "paused" };
      return respond(200, preference);
    },
  );
  await setupPage({ context, path: "/agents?settings=preference" });
  const card = await screen.findByTestId("morning-brief-preference");
  await expect(
    within(card).findByText("Temporarily unavailable."),
  ).resolves.toBeInTheDocument();
  const toggle = within(card).getByRole("switch", { name: "Morning brief" });
  expect(toggle).toBeChecked();
  click(toggle);
  await waitFor(() => {
    expect(toggle).not.toBeChecked();
  });
});

async function expectUnifiedSection(
  section: "preference" | "model" | "debug",
  heading: "Preference" | "Use more models" | "Debug",
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

      await expectUnifiedSection("model", "Use more models");
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      expect(
        within(dialog).getByRole("heading", { name: "Claude" }),
      ).toBeVisible();
      expect(
        within(dialog).getByRole("heading", { name: "ChatGPT (Codex)" }),
      ).toBeVisible();
    },
  );
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

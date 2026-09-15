import {
  emailSubscriptionContract,
  type EmailSubscriptionResponse,
} from "@okouai/api-contracts/contracts/email-subscription";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const emailPreference: EmailSubscriptionResponse = Object.freeze({
  subscribed: true,
  email: "alex@example.test",
  deliveryStatus: "available",
});

async function openPreferences() {
  await setupPage({
    context,
    path: "/agents?settings=preference",
    auth: {
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex@example.test",
      },
    },
    featureSwitches: { [FeatureSwitchKey.MorningBrief]: true },
  });
  return await screen.findByRole("region", { name: "Email subscriptions" });
}

function retryButton(region: HTMLElement) {
  const button = queryAllByRoleFast("button", region).find((candidate) => {
    return candidate.textContent?.trim() === "Retry";
  });
  if (!button) {
    throw new Error("Expected an email subscription retry button");
  }
  return button;
}

describe("email subscription settings", () => {
  it("refreshes an external opt-out when Settings is reopened", async () => {
    let subscribed = true;
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      return respond(200, { ...emailPreference, subscribed });
    });
    const region = await openPreferences();
    await expect(
      within(region).findByText("Subscribed"),
    ).resolves.toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    click(within(dialog).getByLabelText("Close"));
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
    subscribed = false;
    const account = queryAllByRoleFast("button").find((button) => {
      return (
        button.getAttribute("aria-label") === "Alex Rivera" ||
        button.textContent?.includes("Alex Rivera")
      );
    });
    if (!account) {
      throw new Error("Expected account menu trigger");
    }
    click(account);
    const menu = await screen.findByRole("menu");
    click(within(menu).getByText("Settings"));
    await expect(screen.findByText("Unsubscribed")).resolves.toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Receive emails from Okou" }),
    ).not.toBeChecked();
  });

  it("lets a user restore email without changing brief generation, then pause the brief independently", async () => {
    let subscribed = false;
    let briefEnabled = true;
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      return respond(200, { ...emailPreference, subscribed });
    });
    context.mocks.api(emailSubscriptionContract.update, ({ body, respond }) => {
      subscribed = body.subscribed;
      return respond(200, { subscribed });
    });
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      return respond(200, {
        enabled: briefEnabled,
        status: briefEnabled ? "enabled" : "paused",
        nextRunAt: briefEnabled ? "2030-01-02T23:00:00.000Z" : null,
        timezone: "Asia/Shanghai",
        unavailableReason: null,
      });
    });
    context.mocks.api(
      morningBriefPreferenceContract.update,
      ({ body, respond }) => {
        briefEnabled = body.enabled;
        return respond(200, {
          enabled: briefEnabled,
          status: briefEnabled ? "enabled" : "paused",
          nextRunAt: null,
          timezone: "Asia/Shanghai",
          unavailableReason: null,
        });
      },
    );

    const region = await openPreferences();
    await expect(within(region).findByText("Chat only")).resolves.toBeVisible();
    expect(
      within(region).getByText(
        "Email is off. Your brief will still appear in Chat.",
      ),
    ).toBeVisible();
    expect(within(region).getByText("alex@example.test")).toBeVisible();
    const emails = within(region).getByRole("switch", {
      name: "Receive emails from Okou",
    });
    const brief = within(region).getByRole("switch", { name: "Morning brief" });
    expect(emails).not.toBeChecked();
    expect(brief).toBeChecked();

    click(emails);
    await expect(
      within(region).findByText("Chat + email"),
    ).resolves.toBeVisible();
    expect(emails).toBeChecked();
    expect(brief).toBeChecked();

    click(brief);
    await expect(within(region).findByText("Paused")).resolves.toBeVisible();
    expect(brief).not.toBeChecked();
    expect(emails).toBeChecked();

    click(emails);
    await expect(
      within(region).findByText("Unsubscribed"),
    ).resolves.toBeVisible();
    click(brief);
    await expect(within(region).findByText("Chat only")).resolves.toBeVisible();
    expect(emails).not.toBeChecked();
    expect(brief).toBeChecked();
  });

  it("shows unknown subscription while loading instead of an off switch", async () => {
    const response = context.mocks.deferred<EmailSubscriptionResponse>();
    context.mocks.api(emailSubscriptionContract.get, async ({ respond }) => {
      return respond(200, await response.promise);
    });
    const region = await openPreferences();
    expect(
      within(region).getByText("Checking email subscription…"),
    ).toBeVisible();
    expect(
      within(region).queryByRole("switch", {
        name: "Receive emails from Okou",
      }),
    ).not.toBeInTheDocument();
    response.resolve(emailPreference);
    await expect(
      within(region).findByRole("switch", {
        name: "Receive emails from Okou",
      }),
    ).resolves.toBeChecked();
  });

  it("keeps the saved value and disables repeated changes while saving", async () => {
    const saved = context.mocks.deferred<void>();
    let subscribed = true;
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      return respond(200, { ...emailPreference, subscribed });
    });
    context.mocks.api(
      emailSubscriptionContract.update,
      async ({ body, respond }) => {
        await saved.promise;
        subscribed = body.subscribed;
        return respond(200, { subscribed });
      },
    );
    const region = await openPreferences();
    const toggle = await within(region).findByRole("switch", {
      name: "Receive emails from Okou",
    });
    click(toggle);
    await expect(within(region).findByText("Saving…")).resolves.toBeVisible();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    saved.resolve();
    await expect(
      within(region).findByText("Unsubscribed"),
    ).resolves.toBeVisible();
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toHaveAttribute("aria-disabled", "true");
  });

  it("retries a failed read without fabricating a subscription value", async () => {
    let failed = true;
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      if (failed) {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Unable to load email subscription",
          },
        });
      }
      return respond(200, emailPreference);
    });
    const region = await openPreferences();
    await expect(
      within(region).findByText(
        "Could not save or load your email subscription. Try again.",
      ),
    ).resolves.toBeVisible();
    expect(
      within(region).queryByRole("switch", {
        name: "Receive emails from Okou",
      }),
    ).not.toBeInTheDocument();
    failed = false;
    click(retryButton(region));
    await expect(
      within(region).findByText("Subscribed"),
    ).resolves.toBeVisible();
    expect(
      within(region).getByRole("switch", { name: "Receive emails from Okou" }),
    ).toBeChecked();
  });

  it("preserves the previous value after a failed save and retries the requested change", async () => {
    let subscribed = true;
    let failed = true;
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      return respond(200, { ...emailPreference, subscribed });
    });
    context.mocks.api(emailSubscriptionContract.update, ({ body, respond }) => {
      if (failed) {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Unable to save email subscription",
          },
        });
      }
      subscribed = body.subscribed;
      return respond(200, { subscribed });
    });
    const region = await openPreferences();
    const toggle = await within(region).findByRole("switch", {
      name: "Receive emails from Okou",
    });
    click(toggle);
    await expect(
      within(region).findByText(
        "Could not save or load your email subscription. Try again.",
      ),
    ).resolves.toBeVisible();
    expect(toggle).toBeChecked();
    failed = false;
    click(retryButton(region));
    await waitFor(() => {
      return expect(toggle).not.toBeChecked();
    });
    expect(within(region).getByText("Unsubscribed")).toBeVisible();
  });

  it.each(["suppressed", "no-email"] as const)(
    "explains %s delivery without promising an email",
    async (deliveryStatus) => {
      context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
        return respond(200, {
          ...emailPreference,
          deliveryStatus,
          email: deliveryStatus === "no-email" ? null : emailPreference.email,
        });
      });
      context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
        return respond(200, {
          enabled: true,
          status: "enabled",
          nextRunAt: "2030-01-02T07:00:00.000Z",
          timezone: "UTC",
          unavailableReason: null,
        });
      });
      const region = await openPreferences();
      await expect(
        within(region).findByText("Email unavailable"),
      ).resolves.toBeVisible();
      await expect(
        within(region).findByText("Chat only"),
      ).resolves.toBeVisible();
      expect(
        within(region).getByRole("switch", {
          name: "Receive emails from Okou",
        }),
      ).toBeChecked();
      expect(
        within(region).queryByText("Chat + email"),
      ).not.toBeInTheDocument();
    },
  );
});

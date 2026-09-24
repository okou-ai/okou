import {
  emailSubscriptionContract,
  type EmailSubscriptionResponse,
} from "@okouai/api-contracts/contracts/email-subscription";
import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
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

describe("email subscription settings", () => {
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
          unavailableReason: null,
        });
      },
    );

    const region = await openPreferences();
    const brief = await within(region).findByRole("switch", {
      name: "Morning brief",
    });
    await waitFor(() => {
      expect(brief).toBeChecked();
    });
    expect(
      within(region).queryByText(
        "Email is off. Your brief will still appear in Chat.",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(region).getByText(/updates at alex@example\.test/u),
    ).toBeVisible();
    expect(within(region).queryByText("Subscribed")).not.toBeInTheDocument();
    expect(within(region).queryByText("Unsubscribed")).not.toBeInTheDocument();
    const emails = within(region).getByRole("switch", {
      name: "Email updates",
    });
    expect(emails).not.toBeChecked();

    click(emails);
    await waitFor(() => {
      expect(emails).toBeChecked();
    });
    expect(brief).toBeChecked();

    click(brief);
    await waitFor(() => {
      expect(brief).not.toBeChecked();
    });
    expect(emails).toBeChecked();

    click(emails);
    await waitFor(() => {
      expect(emails).not.toBeChecked();
    });
    click(brief);
    await waitFor(() => {
      expect(brief).toBeChecked();
    });
    expect(emails).not.toBeChecked();
  });

  it("keeps the previous email setting after a failed save so the user can toggle again", async () => {
    let subscribed = false;
    let failNextUpdate = true;
    const releaseFailure = context.mocks.deferred<void>();
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      return respond(200, { ...emailPreference, subscribed });
    });
    context.mocks.api(
      emailSubscriptionContract.update,
      async ({ body, respond }) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          await releaseFailure.promise;
          return respond(500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Email preference is temporarily unavailable.",
            },
          });
        }
        subscribed = body.subscribed;
        return respond(200, { subscribed });
      },
    );
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      return respond(200, {
        enabled: true,
        status: "enabled",
        unavailableReason: null,
      });
    });

    const region = await openPreferences();
    const emails = await within(region).findByRole("switch", {
      name: "Email updates",
    });
    await waitFor(() => {
      expect(emails).not.toBeChecked();
    });

    click(emails);
    await waitFor(() => {
      expect(emails).toHaveAttribute("aria-disabled", "true");
    });
    releaseFailure.resolve();
    await waitFor(() => {
      expect(emails).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(emails).not.toBeChecked();

    click(emails);
    await waitFor(() => {
      expect(emails).toBeChecked();
    });
  });

  it("explains missing email delivery", async () => {
    context.mocks.api(emailSubscriptionContract.get, ({ respond }) => {
      return respond(200, {
        ...emailPreference,
        deliveryStatus: "no-email",
        email: null,
      });
    });
    context.mocks.api(morningBriefPreferenceContract.get, ({ respond }) => {
      return respond(200, {
        enabled: true,
        status: "enabled",
        unavailableReason: null,
      });
    });
    const region = await openPreferences();
    await expect(
      within(region).findByText("Email unavailable"),
    ).resolves.toBeVisible();
    expect(
      within(region).getByRole("switch", {
        name: "Email updates",
      }),
    ).toBeChecked();
  });
});

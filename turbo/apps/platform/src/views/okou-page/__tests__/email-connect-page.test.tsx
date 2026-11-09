import { beforeEach, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { integrationsEmailContract } from "@okouai/api-contracts/contracts/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const emailAddress = "verified@example.com";
function proof() {
  return {
    messageId: "00000000-0000-4000-8000-000000000001",
    expires: 1_784_880_000,
    signature: "a".repeat(64),
  };
}
const path = `/settings/email?${new URLSearchParams({ message: proof().messageId, expires: String(proof().expires), signature: proof().signature })}`;
function featureSwitches() {
  return { [FeatureSwitchKey.EmailIntegration]: true };
}

beforeEach(() => {
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: [],
      availableEmails: [emailAddress],
    });
  });
});

test("automatically connects the original email after authentication", async () => {
  const requests: unknown[] = [];
  context.mocks.api(integrationsEmailContract.connect, ({ body, respond }) => {
    requests.push(body);
    return respond(200, { emailAddress });
  });
  await setupPage({ context, path, featureSwitches: featureSwitches() });
  await expect(
    screen.findByText("Email connected"),
  ).resolves.toBeInTheDocument();
  expect(requests).toStrictEqual([proof()]);
  expect(control("link", "Open email")).toHaveAttribute(
    "href",
    "mailto:okou@okou.io",
  );
});

test("explains an expired connection without asking the user to resend account details", async () => {
  context.mocks.api(integrationsEmailContract.connect, ({ respond }) => {
    return respond(400, {
      error: {
        code: "BAD_REQUEST",
        message:
          "Invalid or expired email connection link. Send a new email to Okou.",
      },
    });
  });
  await setupPage({ context, path, featureSwitches: featureSwitches() });
  await expect(
    screen.findByText(/Invalid or expired email connection link/u),
  ).resolves.toBeInTheDocument();
});

test("disconnects a verified address and offers explicit reconnection", async () => {
  let linked = true;
  context.mocks.api(integrationsEmailContract.getLinkStatus, ({ respond }) => {
    return respond(200, {
      address: "okou@okou.io",
      configured: true,
      emails: linked ? [emailAddress] : [],
      availableEmails: [emailAddress],
    });
  });
  context.mocks.api(integrationsEmailContract.unlink, ({ body, respond }) => {
    expect(body.emailAddress).toBe(emailAddress);
    linked = false;
    return respond(204);
  });
  context.mocks.api(
    integrationsEmailContract.connectAddress,
    ({ body, respond }) => {
      expect(body.emailAddress).toBe(emailAddress);
      linked = true;
      return respond(200, { emailAddress });
    },
  );
  await setupPage({
    context,
    path: "/settings/email",
    featureSwitches: featureSwitches(),
  });
  click(
    await waitFor(() => {
      return control("button", "Disconnect");
    }),
  );
  await waitFor(() => {
    expect(linked).toBeFalsy();
  });
  await context.mocks.ably.trigger("email:changed");
  click(
    await waitFor(() => {
      return control("button", "Connect");
    }),
  );
  await waitFor(() => {
    expect(linked).toBeTruthy();
  });
  await context.mocks.ably.trigger("email:changed");
  await waitFor(() => {
    return expect(control("button", "Disconnect")).toBeInTheDocument();
  });
});

function control(role: "button" | "link", label: string): HTMLElement {
  const element = queryAllByRoleFast(role).find((item) => {
    return item.textContent?.trim() === label;
  });
  if (!element) {
    throw new Error("Expected control: " + label);
  }
  return element;
}

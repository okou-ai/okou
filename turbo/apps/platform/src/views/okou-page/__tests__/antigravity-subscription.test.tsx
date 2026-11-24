import { antigravityPersonalSubscriptionContract as contract } from "@okouai/api-contracts/contracts/antigravity-personal-subscription";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const bindingId = "6b025d73-9eeb-43c4-abbb-24ec5ce293fe";
const staff = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
function pilotAuth() {
  return {
    user: { id: "user_antigravity_pilot", fullName: "Pilot member" },
    organization: {
      activeOrg: { id: staff, name: "Staff" },
      memberships: [{ id: staff }],
    },
  };
}

test("link, verify and disconnect a personal Google sign-in from Models settings", async () => {
  let status: "disconnected" | "pending" | "connected" = "disconnected";
  const pending = {
    status: "pending" as const,
    bindingId,
    expiresAt: "2030-11-25T12:00:00.000Z",
    loginHost: "tester@agy.example.com",
  };
  context.mocks.api(contract.get, ({ respond }) => {
    if (status === "pending") {
      return respond(200, pending);
    }
    if (status === "connected") {
      return respond(200, { status, bindingId });
    }
    return respond(200, { status });
  });
  context.mocks.api(contract.start, ({ respond }) => {
    status = "pending";
    return respond(200, pending);
  });
  context.mocks.api(contract.disconnect, ({ params, respond }) => {
    expect(params.bindingId).toBe(bindingId);
    status = "disconnected";
    return respond(200, { status });
  });
  await setupPage({
    context,
    path: "/?settings=model",
    featureSwitches: { [FeatureSwitchKey.GeminiAntigravity]: true },
    auth: pilotAuth(),
  });
  const card = () => {
    return within(
      screen.getByRole("region", { name: "Google AI (Antigravity)" }),
    );
  };
  await screen.findByRole("heading", { name: "Google AI (Antigravity)" });
  click(card().getByText("Connect account", { selector: "button" }));
  await expect(
    screen.findByText(`ssh -t -- ${pending.loginHost} ${bindingId}`),
  ).resolves.toBeInTheDocument();
  status = "connected";
  click(card().getByText("Check sign-in", { selector: "button" }));
  await waitFor(() => {
    return expect(card().getByText("Connected")).toBeInTheDocument();
  });
  click(card().getByText("Disconnect account", { selector: "button" }));
  await waitFor(() => {
    return expect(status).toBe("disconnected");
  });
});

test("explains how to obtain a sign-in terminal before enrollment is available", async () => {
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, { status: "unassigned" });
  });
  await setupPage({
    context,
    path: "/?settings=model",
    featureSwitches: { [FeatureSwitchKey.GeminiAntigravity]: true },
    auth: pilotAuth(),
  });
  const region = within(
    await screen.findByRole("region", { name: "Google AI (Antigravity)" }),
  );
  expect(
    region.getByText("Ask an administrator to assign your sign-in terminal."),
  ).toBeInTheDocument();
  expect(
    region.queryByText("Connect account", { selector: "button" }),
  ).toBeNull();
});

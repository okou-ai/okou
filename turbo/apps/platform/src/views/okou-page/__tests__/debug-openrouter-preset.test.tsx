import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { orgOpenrouterPresetContract } from "@okouai/api-contracts/contracts/org-openrouter-preset";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function openDebug(role: "member" | "admin") {
  const org = { id: "org_test", name: "Debug workshop" };
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { ...org, role });
  });
  await setupPage({
    context,
    path: "/?settings=debug",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: "org:" + role }],
      },
    },
  });
}

function presets(initial: string | null) {
  let value = initial;
  const read = context.mocks.deferred<void>();
  context.mocks.api(orgOpenrouterPresetContract.get, ({ respond }) => {
    if (!read.settled()) {
      read.resolve();
    }
    return respond(200, { openrouterPreset: value });
  });
  context.mocks.api(orgOpenrouterPresetContract.update, ({ body, respond }) => {
    value = body.openrouterPreset;
    return respond(200, { openrouterPreset: value });
  });
  return read;
}
async function picker() {
  return await screen.findByRole("combobox", { name: "OpenRouter preset" });
}
test("debug-openrouter-preset-001 the administrator switches organization presets and restores the default", async () => {
  presets(null);
  await openDebug("admin");
  const trigger = await picker();
  await waitFor(() => {
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveTextContent("System default");
  });
  const choices = [
    "System default",
    "@preset/okou-1-0",
    "@preset/okou-1-0-dsf",
    "@preset/okou-experimental",
  ];
  for (const name of [choices[2]!, choices[0]!, choices[3]!]) {
    click(trigger);
    const list = await screen.findByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((x) => {
          return x.textContent?.trim();
        }),
    ).toStrictEqual(choices);
    click(within(list).getByRole("option", { name }));
    await waitFor(() => {
      expect(trigger).toHaveTextContent(name);
      expect(trigger).toBeEnabled();
    });
  }
  expect(screen.getByText(/entire organization/)).toBeInTheDocument();
});
test("debug-openrouter-preset-002 member Debug opens without reading the organization preset", async () => {
  const read = presets(null);
  await openDebug("member");
  await findFastControl("button", "Run Morning Brief");
  expect(
    screen.queryByRole("combobox", { name: "OpenRouter preset" }),
  ).toBeNull();
  expect(read.settled()).toBeFalsy();
});
test("debug-openrouter-preset-006 a saved operator preset can be viewed but not chosen in the list", async () => {
  presets("@preset/operator-only");
  await openDebug("admin");
  const trigger = await picker();
  await waitFor(() => {
    expect(trigger).toHaveTextContent("@preset/operator-only");
  });
  click(trigger);
  const list = await screen.findByRole("listbox");
  expect(
    within(list).queryByRole("option", { name: "@preset/operator-only" }),
  ).toBeNull();
  expect(
    within(list).getByRole("option", { name: "@preset/okou-experimental" }),
  ).toBeEnabled();
});

import { screen, waitFor } from "@testing-library/react";
import { orgOpenrouterPresetContract } from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function openDebug(role: "admin" | "member" = "admin", debug = true) {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role });
  await setupPage({
    context,
    path: "/agents?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: debug },
  });
  await screen.findByRole("heading", { name: debug ? "Debug" : "Preference" });
}

test("shows only the four allowed presets and persists the administrator's selection", async () => {
  await openDebug();
  const select = await screen.findByRole("combobox", {
    name: "OpenRouter preset",
  });
  await waitFor(() => {
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent("System default");
  });
  click(select);
  const options = await screen.findAllByRole("option");
  expect(
    options.map((option) => {
      return option.textContent;
    }),
  ).toStrictEqual([
    "@preset/okou-1-0",
    "@preset/okou-1-0-dsf",
    "@preset/okou-experimental",
    "@preset/memory",
  ]);
  click(screen.getByRole("option", { name: "@preset/okou-1-0-dsf" }));
  await waitFor(() => {
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent("@preset/okou-1-0-dsf");
  });
  expect(screen.getByText(/for the entire organization/u)).toBeInTheDocument();
});

test.each([
  ["member", true],
  ["admin", false],
] as const)(
  "hides the preset control for role %s with Debug %s",
  async (role, debug) => {
    context.mocks.api(orgOpenrouterPresetContract.get, () => {
      throw new Error(
        "Unauthorized UI must not request the organization preset",
      );
    });
    await openDebug(role, debug);
    expect(
      screen.queryByRole("combobox", { name: "OpenRouter preset" }),
    ).not.toBeInTheDocument();
  },
);

test("keeps the saved preset on a failed update and permits retry", async () => {
  let current = "@preset/okou-1-0";
  let fail = true;
  context.mocks.api(orgOpenrouterPresetContract.get, ({ respond }) => {
    return respond(200, { openrouterPreset: current });
  });
  context.mocks.api(orgOpenrouterPresetContract.update, ({ body, respond }) => {
    if (fail) {
      fail = false;
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Preset update denied" },
      });
    }
    current = body.openrouterPreset;
    return respond(200, { openrouterPreset: current });
  });
  await openDebug();
  const select = await screen.findByRole("combobox", {
    name: "OpenRouter preset",
  });
  await waitFor(() => {
    return expect(select).toHaveTextContent(current);
  });
  click(select);
  click(await screen.findByRole("option", { name: "@preset/memory" }));
  await screen.findByText("Preset update denied");
  await waitFor(() => {
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent("@preset/okou-1-0");
  });
  click(select);
  click(await screen.findByRole("option", { name: "@preset/memory" }));
  await waitFor(() => {
    expect(select).toBeEnabled();
    expect(select).toHaveTextContent("@preset/memory");
  });
});

test("displays an existing operator preset without adding it to the selectable allowlist", async () => {
  context.mocks.api(orgOpenrouterPresetContract.get, ({ respond }) => {
    return respond(200, { openrouterPreset: "@preset/operator-only" });
  });
  await openDebug();
  const select = await screen.findByRole("combobox", {
    name: "OpenRouter preset",
  });
  await waitFor(() => {
    return expect(select).toHaveTextContent("@preset/operator-only");
  });
  click(select);
  await screen.findByRole("option", { name: "@preset/memory" });
  expect(
    screen.queryByRole("option", { name: "@preset/operator-only" }),
  ).not.toBeInTheDocument();
});

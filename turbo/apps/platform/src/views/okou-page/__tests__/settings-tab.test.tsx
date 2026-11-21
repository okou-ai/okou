import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
} from "./connector-integrations-test-helpers.ts";

const context = testContext();
const id = "a0000061-0000-4000-a000-000000000001";
function profileFixture() {
  const initial: AgentResponse = {
    agentId: id,
    isDefaultAgent: false,
    ownerId: "test-user-123",
    displayName: "Atlas",
    description: "Prepare field notes",
    sound: "professional",
    avatarUrl: null,
    visibility: "public",
  };
  let saved: AgentResponse | null = null;
  context.mocks.data.agents([initial]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, saved ?? initial);
  });
  context.mocks.api(agentsByIdContract.updateMetadata, ({ body, respond }) => {
    saved = { ...(saved ?? initial), ...body };
    context.mocks.data.agents([saved]);
    return respond(200, saved);
  });
  return () => {
    return saved;
  };
}
async function openProfile() {
  await setupPage({ context, path: "/agents/" + id + "?tab=profile" });
  return screen.findByRole("textbox", { name: "Name" });
}
test("settings-tab-005 an agent without an avatar offers creation and opens the face designer", async () => {
  profileFixture();
  await openProfile();
  const create = await findAction("button", "Create custom avatar");
  click(create);
  const createDialog = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(within(createDialog).queryByText("Edit avatar")).toBeNull();
  click(getAction("button", "Close", createDialog));
  await waitFor(() => {
    return expect(createDialog).not.toBeInTheDocument();
  });
  click(getAction("button", "Customize avatar"));
  const fromHeader = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  expect(fromHeader).toBeVisible();
  expect(within(fromHeader).queryByText("Edit avatar")).toBeNull();
});
test("settings-tab-007 all six avatar steps expose their first and last choices within the open editor", async () => {
  profileFixture();
  await openProfile();
  click(await findAction("button", "Create custom avatar"));
  const editor = await screen.findByRole("dialog", {
    name: "Give your agent a face",
  });
  const steps = [
    ["Face", "Round", "Oval"],
    ["Hair", "High bun", "Ribbon updo"],
    ["Mood", "Neutral smile", "Stubble smile"],
    ["Skin", "Gold", "Brown"],
    ["Color", "Blue", "Brown"],
    ["Sweater", "Lime", "Orange"],
  ] as const;
  for (const [step, first, last] of steps) {
    if (step !== "Face") {
      click(getAction("button", "Next step", editor));
    }
    await expect(
      within(editor).findByText(step, { exact: true }),
    ).resolves.toBeVisible();
    const choices = queryAllByRoleFast("button", editor).filter((option) => {
      return option.hasAttribute("aria-pressed");
    });
    const leading = choices.at(0);
    const trailing = choices.at(-1);
    expect(leading).toHaveAccessibleName(first);
    expect(leading).toBeVisible();
    expect(trailing).toHaveAccessibleName(last);
    expect(trailing).toBeVisible();
    expect(getAction("button", "Use this avatar", editor)).toBeEnabled();
  }
});
test("settings-tab-012 a confirmed private Research Lead profile retains its new description and tone across tabs", async () => {
  const saved = profileFixture();
  const name = await openProfile();
  expect(name).toHaveValue("Atlas");
  const description = screen.getByRole("textbox", { name: "Description" });
  expect(description).toHaveValue("Prepare field notes");
  const visible = screen.getByRole("switch", { name: "Make public" });
  expect(visible).toBeChecked();
  expect(getAction("button", "Professional")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await fill(name, "Research Lead");
  await fill(description, "Compile partner interviews");
  click(getAction("button", "Friendly"));
  click(visible);
  click(getAction("button", "Save"));
  const warning = await screen.findByRole("dialog", {
    name: /Make .+ private\?/u,
  });
  click(getAction("button", "Make private", warning));
  await screen.findByText("Profile saved");
  expect(saved()).toMatchObject({
    agentId: id,
    displayName: "Research Lead",
    description: "Compile partner interviews",
    sound: "friendly",
    visibility: "private",
  });
  expect(screen.queryByText("You have unsaved changes")).toBeNull();
  click(getAction("tab", "Instructions"));
  await waitFor(() => {
    return expect(getAction("tab", "Instructions")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  click(getAction("tab", "Profile"));
  await expect(
    screen.findByRole("textbox", { name: "Name" }),
  ).resolves.toHaveValue("Research Lead");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Compile partner interviews",
  );
  expect(getAction("button", "Friendly")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("switch", { name: "Make public" })).not.toBeChecked();
});
test("settings-tab-013 discarding identity, tone and visibility edits restores the public agent without a saved revision", async () => {
  const saved = profileFixture();
  const name = await openProfile();
  const biography = screen.getByRole("textbox", { name: "Description" });
  const access = screen.getByRole("switch", { name: "Make public" });
  await fill(biography, "Temporary description");
  await fill(name, "Temporary name");
  click(getAction("button", "Friendly"));
  click(access);
  expect(access).not.toBeChecked();
  expect(getAction("button", "Friendly")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await screen.findByText("You have unsaved changes");
  click(getAction("button", "Discard"));
  await waitFor(() => {
    return expect(name).toHaveValue("Atlas");
  });
  expect(biography).toHaveValue("Prepare field notes");
  expect(access).toBeChecked();
  expect(getAction("button", "Professional")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.queryByText("You have unsaved changes")).toBeNull();
  expect(saved()).toBeNull();
});
test("settings-tab-014 canceling deletion after reading its effect leaves Atlas on its original profile", async () => {
  const saved = profileFixture();
  await openProfile();
  click(await findAction("button", "Delete agent"));
  const warning = await screen.findByRole("dialog", { name: "Delete Atlas?" });
  expect(
    within(warning).getByText(
      "Deletes the agent, its workflows, automations, and everyone's chat history.",
    ),
  ).toBeVisible();
  click(getAction("button", "Cancel", warning));
  await waitFor(() => {
    return expect(warning).not.toBeInTheDocument();
  });
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Atlas");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    "Prepare field notes",
  );
  expect(saved()).toBeNull();
});

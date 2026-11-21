import {
  getAction,
  findAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import { screen, within, waitFor } from "@testing-library/react";

import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { agentFixture, setupTeamPage } from "./team-page-test-helpers.ts";
const context = testContext();
async function researchProfile(
  search: string,
  avatarUrl: string | null = null,
) {
  const research = context.resourceId;
  const primary = crypto.randomUUID();
  context.mocks.data.onboardingStatus({ defaultAgentId: primary });
  const path = "/agents/" + research;
  await setupTeamPage({
    context,
    path: path + search,
    agents: [
      agentFixture(primary, "Workspace assistant", { isDefaultAgent: true }),
      agentFixture(research, "Research Agent", { avatarUrl }),
    ],
  });
  await expect(
    screen.findByRole("heading", { name: "Research Agent" }),
  ).resolves.toBeInTheDocument();
  return path;
}
test.each([
  ["team-navigation-001", ""],
  ["team-navigation-002", "?tab=authorization"],
])(
  "%s the Research profile offers its two editing sections",
  async (_id, search) => {
    const path = await researchProfile(search);
    expect(
      queryAllByRoleFast("tab", document.body).map((tab) => {
        return tab.textContent?.trim();
      }),
    ).toStrictEqual(["Profile", "Instructions"]);
    const selector = screen.getByRole("combobox", {
      name: "Agent details section",
    });
    click(selector);
    const options = within(await screen.findByRole("listbox")).getAllByRole(
      "option",
    );
    expect(
      options.map((option) => {
        return option.textContent?.trim();
      }),
    ).toStrictEqual(["Profile", "Instructions"]);
    click(screen.getByRole("option", { name: "Instructions" }));
    await waitFor(() => {
      return expect(location.pathname + location.search).toBe(
        path + "?tab=instructions",
      );
    });
    expect(selector).toHaveTextContent("Instructions");
  },
);
test("team-navigation-004 avatar customization starts with all six saved Research selections", async () => {
  const avatar = avatarComposerUrl({
    face: "oval",
    hair: "rounded-crop",
    hairColor: "green",
    expression: "neutral-smile",
    skin: "deep",
    sweater: "lime",
  });
  await researchProfile("", avatar);
  const header = screen
    .getByRole("heading", { name: "Research Agent" })
    .closest("header");
  if (!header) {
    throw new Error("Research header is missing");
  }
  click(getAction("button", "Customize avatar", header));
  const editorElement = await screen.findByRole("dialog", {
    name: "Edit avatar",
  });
  expect(getAction("button", "Oval", editorElement)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  for (const selected of [
    "Rounded crop",
    "Neutral smile",
    "Deep",
    "Green",
    "Lime",
  ]) {
    click(getAction("button", "Next step", editorElement));
    await expect(
      findAction("button", selected, editorElement),
    ).resolves.toHaveAttribute("aria-pressed", "true");
  }
});

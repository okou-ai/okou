import { screen, waitFor } from "@testing-library/react";
import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  RESEARCH_AGENT_ID,
  agentFixture,
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();

test.each(["", "?tab=authorization"])(
  "Chat connector accounts keeps agent editing available without old authorization controls: %s",
  async (query) => {
    await setupTeamPage({
      context,
      path: `/agents/${RESEARCH_AGENT_ID}${query}`,
      featureSwitches: { [FeatureSwitchKey.ConnectorChatAccountAccess]: true },
    });

    await screen.findByRole("heading", { name: "Research Agent" });
    await screen.findByRole("textbox", { name: "Name" });
    expect(
      queryAllByRoleFast("tab").map((tab) => {
        return tab.textContent?.trim();
      }),
    ).toStrictEqual(["Profile", "Instructions"]);

    click(screen.getByRole("combobox", { name: "Agent details section" }));
    await screen.findByRole("option", { name: "Instructions" });
    expect(screen.queryByRole("option", { name: "Authorization" })).toBeNull();
    click(screen.getByRole("option", { name: "Instructions" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?tab=instructions");
    });
  },
);

test("Chat connector accounts preserves a member's chat access without exposing agent editing", async () => {
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "member",
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}?tab=authorization`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent", {
        ownerId: "other-owner",
      }),
    ],
    featureSwitches: { [FeatureSwitchKey.ConnectorChatAccountAccess]: true },
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  expect(screen.getByLabelText("Chat with Research Agent")).toHaveAttribute(
    "href",
    `/agents/${RESEARCH_AGENT_ID}/chat`,
  );
  expect(queryAllByRoleFast("tab")).toHaveLength(0);
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
});

function renderedAvatarSvgLayerSrcs(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLImageElement>("img"), (img) => {
    return img.src;
  }).filter((src) => {
    return src.includes("/platform/views/zero-page/assets/avatar-svg");
  });
}

function labelledButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!button) {
    throw new Error(`Labelled button not found: ${name}`);
  }
  return button;
}

test("The agent header opens avatar customization on the current avatar", async () => {
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent", {
        avatarUrl: avatarComposerUrl({
          face: "oval",
          hair: "rounded-crop",
          expression: "neutral-smile",
          skin: "deep",
          hairColor: "green",
          sweater: "lime",
        }),
      }),
    ],
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  click(labelledButton("Customize avatar"));

  const dialog = await screen.findByRole("dialog", { name: "Edit avatar" });
  expect(renderedAvatarSvgLayerSrcs(dialog).slice(0, 6)).toStrictEqual([
    expect.stringContaining("/neck/deep.svg"),
    expect.stringContaining("/hairs/oval/rounded-crop-green-rear.svg"),
    expect.stringContaining("/faces/oval-deep.svg"),
    expect.stringContaining("/hairs/oval/rounded-crop-green-front.svg"),
    expect.stringContaining("/expressions/neutral-smile-oval.svg"),
    expect.stringContaining("/sweater/lime.svg"),
  ]);
});

test("A member cannot customize another user's public agent avatar", async () => {
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "member",
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}?tab=profile`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Research Agent", {
        ownerId: "agent-owner",
      }),
    ],
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Create custom avatar"),
  ).not.toBeInTheDocument();
});

test("An org admin cannot customize another user's private agent avatar", async () => {
  context.mocks.data.org({
    id: "org_default",
    name: "Default Org",
    role: "admin",
  });
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}?tab=profile`,
    agents: [
      agentFixture(RESEARCH_AGENT_ID, "Private Agent", {
        ownerId: "agent-owner",
        visibility: "private",
      }),
    ],
  });

  await screen.findByRole("heading", { name: "Private Agent" });
  expect(screen.queryByLabelText("Customize avatar")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Create custom avatar"),
  ).not.toBeInTheDocument();
});

test("A user starts a chat from an agent's detail page", async () => {
  await setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });

  await screen.findByRole("heading", { name: "Research Agent" });
  const chatLink = screen.getByLabelText("Chat with Research Agent");
  expect(chatLink).toHaveAttribute("href", `/agents/${RESEARCH_AGENT_ID}/chat`);
  click(chatLink);

  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    expect(
      screen.getByText("Ask me to automate workflows, manage tasks..."),
    ).toBeVisible();
  });
});

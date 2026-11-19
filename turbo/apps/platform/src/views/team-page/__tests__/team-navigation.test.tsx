import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getConnectorAction } from "../../okou-page/__tests__/connector-page-test-helpers.ts";
import {
  agentFixture,
  RESEARCH_AGENT_ID,
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();

const CHAT_PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function tabNames(): (string | null)[] {
  return queryAllByRoleFast("tab").map((tab) => {
    return tab.textContent;
  });
}

async function findAgentHeader(): Promise<HTMLElement> {
  return await screen.findByRole("heading", {
    level: 1,
    name: "Research Agent",
  });
}

test.each(["", "?tab=authorization"])(
  "Chat connector accounts keeps agent editing available without old authorization controls: %s",
  async (query) => {
    await setupTeamPage({
      context,
      path: `/agents/${RESEARCH_AGENT_ID}${query}`,
    });
    await findAgentHeader();
    const section = await screen.findByRole("combobox", {
      name: "Agent details section",
    });
    expect(tabNames()).toStrictEqual(["Profile", "Instructions"]);

    click(section);
    const options = await screen.findAllByRole("option");
    expect(
      options.map((option) => {
        return option.textContent;
      }),
    ).toStrictEqual(["Profile", "Instructions"]);
    click(await screen.findByRole("option", { name: "Instructions" }));

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("tab")).toBe(
        "instructions",
      );
    });
    expect(screen.queryByRole("option", { name: /Authorization/u })).toBeNull();
    expect(tabNames()).toStrictEqual(["Profile", "Instructions"]);
  },
);

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
  const header = (await findAgentHeader()).closest("header");
  if (!header) {
    throw new Error("Expected the agent header");
  }

  click(getConnectorAction("button", "Customize avatar", header));

  const dialog = await screen.findByRole("dialog", { name: "Edit avatar" });
  const preview = getConnectorAction(
    "button",
    "Randomize avatar",
    dialog,
  ).parentElement;
  if (!preview) {
    throw new Error("Expected the avatar preview");
  }
  const layers = Array.from(preview.querySelectorAll("img")).map((image) => {
    return new URL(image.src).pathname;
  });
  expect(layers).toStrictEqual(
    expect.arrayContaining([
      expect.stringMatching(/\/faces\/oval-deep\.svg$/u),
      expect.stringMatching(/\/hairs\/oval\/rounded-crop-green-front\.svg$/u),
      expect.stringMatching(/\/expressions\/neutral-smile-oval\.svg$/u),
      expect.stringMatching(/\/sweater\/lime\.svg$/u),
    ]),
  );
  expect(getConnectorAction("button", "Oval", dialog)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("A user starts a chat from an agent's detail page", async () => {
  await setupTeamPage({ context, path: `/agents/${RESEARCH_AGENT_ID}` });
  await findAgentHeader();

  click(
    await waitFor(() => {
      return getConnectorAction("link", "Chat with Research Agent");
    }),
  );

  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toHaveAttribute("placeholder", CHAT_PLACEHOLDER);
});

/**
 * Boundary exception, per `docs/testing.md#external-behavior`.
 *
 * These cases are driven entirely through the production chat page — the real
 * route and the real agent — but the thing under test is not page-observable.
 * The texture is a background image and the placement is a transform, and
 * jsdom neither loads images nor performs layout, so nothing a user could see
 * changes in the DOM. The style the component wrote is the only available
 * evidence.
 *
 * The case is worth testing because both failures are silent. A texture that
 * collides with the avatar's own sweater still renders every layer; an artwork
 * that floats above the frame's bottom edge still renders every layer too. So
 * the assertions read the texture and artwork through their slot hooks and
 * check the relationships the rules guarantee, not the numbers that happen to
 * satisfy them today.
 */
import {
  avatarComposerUrl,
  DEFAULT_AGENT_AVATAR_URL,
} from "@okouai/core/agent-avatar";

import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000031";
/** The organization default agent the onboarding mock reports. */
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

/**
 * The flattest hair in the cast on a `round` face: the artwork covers the least
 * of its box, so framing scales it up the most and the gap under the collar is
 * the widest of the 72 face-and-hair combinations. If bottom anchoring works
 * here it works everywhere.
 */
const AVATAR = {
  face: "round",
  hair: "geometric-long",
  expression: "neutral-smile",
  skin: "gold",
  hairColor: "black",
  sweater: "blue",
} as const;

function mountedAgent(avatarUrl = avatarComposerUrl(AVATAR)): void {
  const agent: AgentResponse = {
    agentId: AGENT_ID,
    isDefaultAgent: false,
    ownerId: "test-user-123",
    displayName: "Nova",
    description: null,
    sound: null,
    avatarUrl,
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
}

/** The greeting avatar, which is the profile link at the top of the page. */
function avatarFrame(): HTMLElement {
  const frame = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === `/agents/${AGENT_ID}`;
  });
  if (!frame) {
    throw new Error("Greeting avatar link not found");
  }
  return frame;
}

function artworkTransform(container: ParentNode): string {
  const artwork = container.querySelector<HTMLElement>("[data-avatar-artwork]");
  if (!artwork) {
    throw new Error("Avatar artwork not found");
  }
  return artwork.style.transform;
}

function textureImage(container: ParentNode): string | null {
  const texture = container.querySelector<HTMLElement>("[data-avatar-texture]");
  return texture ? texture.style.backgroundImage : null;
}

/** The tile the frame is showing, named the way the pairing rule names it. */

function placement(transform: string): { scale: number; offset: number } {
  const scale = /scale\(([\d.]+)\)/u.exec(transform);
  const offset = /translateY\((-?[\d.]+)%\)/u.exec(transform);
  if (!scale?.[1] || !offset?.[1]) {
    throw new Error(`Incomplete placement in transform: ${transform}`);
  }
  return { scale: Number(scale[1]), offset: Number(offset[1]) };
}

async function setupChatPage(): Promise<void> {
  mountedAgent();
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?compose=1`,
  });
  await waitFor(() => {
    expect(avatarFrame()).toBeInTheDocument();
  });
}

/** Where the artwork's lower edge lands, as a percentage of the box. */
function artworkBottom(transform: string): number {
  const { scale, offset } = placement(transform);
  return (100 - 50 + offset) * scale + 50;
}

test("Keep every other avatar surface untextured", async () => {
  await setupChatPage();

  // The sidebar draws the same agent from the same avatar URL. Only the
  // greeting opts in, so every avatar outside that one frame is unchanged.
  const frame = avatarFrame();
  const elsewhere = Array.from(
    document.querySelectorAll<HTMLElement>("[data-avatar-artwork]"),
  ).filter((artwork) => {
    return !frame.contains(artwork);
  });

  expect(elsewhere.length).toBeGreaterThan(0);
  for (const artwork of elsewhere) {
    const container = artwork.parentElement;
    expect(textureImage(container!)).toBeNull();
    // Still centered, not anchored.
    expect(artworkBottom(artworkTransform(container!))).toBeLessThan(100);
  }
});

test("Draw the organization default agent with the animated Okou avatar once it is on", async () => {
  // Outside My Okou the default agent is drawn from its stored avatar, the flat
  // default artwork. With the switch on, that artwork gives way to the shared
  // animated avatar wherever an agent avatar is drawn.
  mountedAgent(DEFAULT_AGENT_AVATAR_URL);
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?compose=1`,
    featureSwitches: { [FeatureSwitchKey.OkouAnimatedAvatar]: true },
  });
  await waitFor(() => {
    expect(avatarFrame()).toBeInTheDocument();
  });

  expect(avatarFrame().querySelector("[data-okou-avatar]")).toHaveAttribute(
    "data-okou-avatar",
    "animated",
  );
  // The flat default artwork is no longer drawn in the frame.
  expect(avatarFrame().innerHTML).not.toContain(DEFAULT_AGENT_AVATAR_URL);
});

test("Greet with Okou's own animated avatar under My Okou", async () => {
  // My Okou draws Okou on the home greeting whatever the default agent's own
  // avatar is, through the shared avatar: textured, framed, and moving.
  const agent: AgentResponse = {
    agentId: DEFAULT_AGENT_ID,
    isDefaultAgent: true,
    ownerId: "test-user-123",
    displayName: "Okou",
    description: null,
    sound: null,
    avatarUrl: avatarComposerUrl(AVATAR),
    visibility: "public",
  };
  context.mocks.data.agents([agent]);
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, agent);
  });
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${DEFAULT_AGENT_ID}/chat?compose=1`,
    featureSwitches: { [FeatureSwitchKey.SingleAgent]: true },
  });
  const greeting = await screen.findByTestId("chat-greeting");

  const avatar = greeting.querySelector("[data-okou-avatar]");
  expect(avatar).toHaveAttribute("data-okou-avatar", "animated");
});

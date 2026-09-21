/**
 * Boundary exception, per `docs/testing/testing-external-behavior.md`.
 *
 * These cases are driven entirely through the production chat page — the real
 * route, the real agent, real feature-switch overrides — but the thing under
 * test is not page-observable. The texture is a background image and the
 * placement is a transform, and jsdom neither loads images nor performs layout,
 * so nothing a user could see changes in the DOM. The style the component wrote
 * is the only available evidence.
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
  admissibleAvatarTextures,
  avatarTextureUrl,
  defaultAgentAvatarTextures,
} from "@okouai/core/agent-avatar-texture";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000031";

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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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
function textureUrl(container: ParentNode): string {
  const image = textureImage(container);
  const url = image === null ? null : /url\("?([^")]+)"?\)/u.exec(image);
  if (!url?.[1]) {
    throw new Error(`No texture image on the frame: ${image ?? "none"}`);
  }
  return url[1];
}

function placement(transform: string): { scale: number; offset: number } {
  const scale = /scale\(([\d.]+)\)/u.exec(transform);
  const offset = /translateY\((-?[\d.]+)%\)/u.exec(transform);
  if (!scale?.[1] || !offset?.[1]) {
    throw new Error(`Incomplete placement in transform: ${transform}`);
  }
  return { scale: Number(scale[1]), offset: Number(offset[1]) };
}

async function setupChatPage(texture: boolean): Promise<void> {
  mountedAgent();
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      // Framing on, so the artwork carries a scale the anchor has to survive.
      [FeatureSwitchKey.AvatarFraming]: true,
      [FeatureSwitchKey.AvatarTexture]: texture,
    },
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

test("Leave the greeting avatar on its framed placement while the texture is off", async () => {
  await setupChatPage(false);

  const frame = avatarFrame();
  expect(textureImage(frame)).toBeNull();

  // Centering leaves a real gap under the collar — for this avatar about a
  // tenth of the box, 6px at the 56px the greeting renders at. It costs
  // nothing today only because the frame is the page's own colour, which is
  // exactly what a texture behind it takes away.
  const gap = 100 - artworkBottom(artworkTransform(frame));
  expect(gap).toBeGreaterThan(10);
});

test("Sit the greeting avatar on the frame's bottom edge once a texture is behind it", async () => {
  await setupChatPage(true);

  const frame = avatarFrame();

  // The texture is one of the tiles the colour rule allows for this avatar —
  // a blue sweater rules out both blue-based tiles on its own.
  const allowed = admissibleAvatarTextures(AVATAR).map(avatarTextureUrl);
  expect(allowed.length).toBeGreaterThan(0);
  expect(allowed).not.toContain(avatarTextureUrl("drop-blue-lightblue"));
  expect(allowed).toContain(textureUrl(frame));

  // The artwork's lower edge lands exactly on the box's lower edge, so the
  // frame carries the cut instead of leaving it floating over the texture.
  expect(placement(artworkTransform(frame)).scale).toBeGreaterThan(1);
  expect(artworkBottom(artworkTransform(frame))).toBeCloseTo(100, 5);
});

test("Leave an agent that cannot take a texture exactly as it was", async () => {
  // An uploaded image has no sweater or hair colour for the pairing rule to
  // clear, so it gets no texture even with the switch on — and must therefore
  // keep the centred placement, since nothing is drawn behind it to reveal the
  // cut edge. The frame's hairline follows the same answer.
  mountedAgent("https://example.test/uploaded-avatar.png");
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.AvatarFraming]: true,
      [FeatureSwitchKey.AvatarTexture]: true,
    },
  });
  await waitFor(() => {
    expect(avatarFrame()).toBeInTheDocument();
  });

  const frame = avatarFrame();
  expect(textureImage(frame)).toBeNull();
  expect(frame.querySelector("[data-avatar-artwork]")).toBeNull();
  expect(frame.querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/uploaded-avatar.png",
  );
});

test("Keep every other avatar surface untextured", async () => {
  await setupChatPage(true);

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
    expect(container).not.toBeNull();
    expect(textureImage(container!)).toBeNull();
    // Still centered, not anchored.
    expect(artworkBottom(artworkTransform(container!))).toBeLessThan(100);
  }
});

test("Give the organization default agent its own texture", async () => {
  // The avatar every workspace's chat home opens on. It is a drawn file rather
  // than a composer configuration, so it used to fall through to no texture at
  // all — on the one surface this feature exists for.
  mountedAgent(DEFAULT_AGENT_AVATAR_URL);
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.AvatarFraming]: true,
      [FeatureSwitchKey.AvatarTexture]: true,
    },
  });
  await waitFor(() => {
    expect(avatarFrame()).toBeInTheDocument();
  });

  const frame = avatarFrame();
  const expected = defaultAgentAvatarTextures()[0];
  expect(expected).toBeDefined();
  expect(textureUrl(frame)).toBe(avatarTextureUrl(expected!));
  // The artwork is the drawn file, still shown through the same frame.
  expect(frame.querySelector("img")).toHaveAttribute(
    "src",
    DEFAULT_AGENT_AVATAR_URL,
  );
});

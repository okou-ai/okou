/**
 * Boundary exception, per `docs/testing-external-behavior.md`.
 *
 * These cases are set up entirely through the production page — the real
 * Agents route and the real agent list — but they cannot be verified through
 * it. Avatar framing has no page-observable result: it is a transform whose
 * only effect is the rendered size of the artwork, and jsdom performs no
 * layout, so nothing a user could see changes in the DOM. The applied
 * transform is the only available evidence.
 *
 * The case is still worth testing because the whole point of the framing rule
 * is that two avatars stop differing in size, and a wrong scale is silent —
 * every layer still loads and every element still renders. So the assertions
 * read the artwork through the `AVATAR_ARTWORK_SLOT` hook rather than the DOM
 * shape around it, and check the relationship the rule guarantees rather than
 * the exact numbers that happen to produce it.
 */
import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const FLAT_HAIR_AGENT_ID = "c0000000-0000-4000-a000-000000000021";
const TALL_HAIR_AGENT_ID = "c0000000-0000-4000-a000-000000000022";
const LEGACY_AGENT_ID = "c0000000-0000-4000-a000-000000000023";

/**
 * The share of the avatar box each artwork covers as drawn, before any framing:
 * from the top of the hair, once the head has been moved onto the chin
 * baseline, down to the bottom of the sweater. These are properties of the
 * composer assets — the flattest hair leaves the canvas's whole forehead margin
 * empty, the tallest reaches past the top of it — and they are what makes one
 * agent card look larger than the next.
 */
const FLAT_HAIR_DRAWN_FILL = 250.4 / 380;
const TALL_HAIR_DRAWN_FILL = 383.4 / 380;

function agent(agentId: string, avatarUrl: string): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: "test-user-123",
    description: null,
    displayName: agentId,
    sound: null,
    avatarUrl,
    visibility: "public",
  };
}

const FLAT_HAIR_AVATAR_URL = avatarComposerUrl({
  face: "round",
  hair: "geometric-long",
  expression: "neutral-smile",
  skin: "gold",
  hairColor: "black",
  sweater: "blue",
});

const TALL_HAIR_AVATAR_URL = avatarComposerUrl({
  face: "square",
  hair: "high-bun",
  expression: "happy",
  skin: "deep",
  hairColor: "brown",
  sweater: "yellow",
});

function agentCard(agentId: string): HTMLElement {
  const card = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href") === `/agents/${agentId}`;
  });
  if (!card) {
    throw new Error(`${agentId} agent card not found`);
  }
  return card;
}

/** The transform placing the artwork inside the avatar box. */
function avatarFramingTransform(agentId: string): string {
  const artwork = agentCard(agentId).querySelector<HTMLElement>(
    "[data-avatar-artwork]",
  );
  if (!artwork) {
    throw new Error(`${agentId} avatar artwork not found`);
  }
  return artwork.style.transform;
}

function framingScale(transform: string): number {
  const match = /scale\(([\d.]+)\)/u.exec(transform);
  if (!match?.[1]) {
    throw new Error(`No scale in transform: ${transform}`);
  }
  return Number(match[1]);
}

function centeringOffset(transform: string): number {
  const match = /translateY\((-?[\d.]+)%\)/u.exec(transform);
  if (!match?.[1]) {
    throw new Error(`No vertical offset in transform: ${transform}`);
  }
  return Number(match[1]);
}

async function setupAgentsPage(
  agents: readonly AgentResponse[],
): Promise<void> {
  context.mocks.data.agents([...agents]);
  context.mocks.data.onboardingStatus({
    defaultAgentId: agents[0]?.agentId ?? null,
  });
  await setupPage({
    context,
    path: "/agents",
  });
  await waitFor(() => {
    expect(agentCard(agents[0]!.agentId)).toBeInTheDocument();
  });
}

test("Center each composer avatar and pull the cast toward one size", async () => {
  await setupAgentsPage([
    agent(FLAT_HAIR_AGENT_ID, FLAT_HAIR_AVATAR_URL),
    agent(TALL_HAIR_AGENT_ID, TALL_HAIR_AVATAR_URL),
  ]);

  const flat = avatarFramingTransform(FLAT_HAIR_AGENT_ID);
  const tall = avatarFramingTransform(TALL_HAIR_AGENT_ID);

  // The flat-haired artwork leaves the whole forehead margin of its canvas
  // empty, so centering moves it a long way up. The one whose bun already
  // reaches past the top of the canvas is close to centered where it is.
  expect(centeringOffset(flat)).toBeLessThan(-10);
  expect(Math.abs(centeringOffset(tall))).toBeLessThan(1);

  // The smaller artwork grows and the larger one shrinks, and neither moves far
  // enough to make its face the odd one out.
  const flatScale = framingScale(flat);
  const tallScale = framingScale(tall);
  expect(flatScale).toBeGreaterThan(1);
  expect(tallScale).toBeLessThan(1);
  expect(flatScale).toBeLessThan(1.25);
  expect(tallScale).toBeGreaterThan(0.9);

  // What the framing is for. As drawn these two differ by more than 1.5x, which
  // is what makes a row of cards look uneven. Framed, they are half that far
  // apart in log space — the rule corrects half the difference, so the framed
  // spread is the square root of the drawn one.
  const drawnRatio = TALL_HAIR_DRAWN_FILL / FLAT_HAIR_DRAWN_FILL;
  const framedRatio =
    (TALL_HAIR_DRAWN_FILL * tallScale) / (FLAT_HAIR_DRAWN_FILL * flatScale);
  expect(drawnRatio).toBeGreaterThan(1.5);
  expect(framedRatio).toBeLessThan(drawnRatio);
  expect(framedRatio).toBeCloseTo(Math.sqrt(drawnRatio), 2);
});

test("Keep legacy avatars on the scale they already shipped with", async () => {
  await setupAgentsPage([agent(LEGACY_AGENT_ID, "svg:r3s2h4c1f5h")]);

  expect(avatarFramingTransform(LEGACY_AGENT_ID)).toBe("scale(1.25)");
});

/**
 * The head group carries only the chin-baseline placement, so it is the layer
 * that proves the head is moved rather than resized. Same boundary exception as
 * above: a resized head has no page-observable result under jsdom.
 */
function headPlacementTransform(agentId: string): string {
  const head =
    agentCard(agentId).querySelector<HTMLElement>("[data-avatar-head]");
  if (!head) {
    throw new Error(`${agentId} avatar head group not found`);
  }
  return head.style.transform;
}

test("Move the head to the chin baseline instead of resizing it", async () => {
  await setupAgentsPage([
    agent(FLAT_HAIR_AGENT_ID, FLAT_HAIR_AVATAR_URL),
    agent(TALL_HAIR_AGENT_ID, TALL_HAIR_AVATAR_URL),
  ]);

  // The face assets are all drawn at one width. Resizing a head to reach the
  // shared collar made it up to 1.24x wider than its neighbour while the neck
  // and collar under it stayed fixed, which is what made one body look too big
  // for its head. Neither head carries a scale any more.
  for (const id of [FLAT_HAIR_AGENT_ID, TALL_HAIR_AGENT_ID]) {
    expect(headPlacementTransform(id)).not.toMatch(/scale\(/u);
    expect(headPlacementTransform(id)).toMatch(/^translateY\(-?[\d.]+%\)$/u);
  }

  // The two faces have different chins, so they move by different amounts to
  // land on the same collar.
  expect(headPlacementTransform(FLAT_HAIR_AGENT_ID)).not.toBe(
    headPlacementTransform(TALL_HAIR_AGENT_ID),
  );
});

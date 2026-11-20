import { avatarComposerUrl } from "@okouai/core/agent-avatar";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

// A round face with rounded-crop hair: its artwork spans 250.4 of the 380px
// canvas once the chin meets the collar.
const FLAT_HAIRED = "Flat-haired agent";
// A tall face with a high bun: its hair reaches above the canvas, 383.4/380.
const TALL_HAIRED = "Tall-haired agent";

function serveComposedAvatars(): void {
  const shared = {
    expression: "happy",
    skin: "tan",
    hairColor: "brown",
    sweater: "teal",
  } as const;
  context.mocks.data.agents([
    {
      agentId: "c0000000-0000-4000-a000-000000000b01",
      displayName: FLAT_HAIRED,
      visibility: "public",
      avatarUrl: avatarComposerUrl({
        ...shared,
        face: "round",
        hair: "rounded-crop",
      }),
    },
    {
      agentId: "c0000000-0000-4000-a000-000000000b02",
      displayName: TALL_HAIRED,
      visibility: "public",
      avatarUrl: avatarComposerUrl({
        ...shared,
        face: "tall",
        hair: "high-bun",
      }),
    },
  ]);
}

/** The transform written on a framed avatar slot, read from its style. */
function slotTransform(
  name: string,
  slot: "data-avatar-artwork" | "data-avatar-head",
): { scale: number; offsetY: number } {
  const element = screen
    .getByRole("img", { name })
    .querySelector<HTMLElement>(`[${slot}]`);
  const transform = element?.style.transform ?? "";
  const scale = /scale\(([-\d.]+)\)/u.exec(transform)?.[1];
  const offset = /translateY\(([-\d.]+)%\)/u.exec(transform)?.[1];
  return {
    scale: scale === undefined ? 1 : Number(scale),
    offsetY: offset === undefined ? 0 : Number(offset),
  };
}

async function openPublicAgents(): Promise<void> {
  serveComposedAvatars();
  await setupPage({ context, path: "/agents" });
  await expect(
    screen.findByRole("img", { name: FLAT_HAIRED }),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByRole("img", { name: TALL_HAIRED }),
  ).resolves.toBeInTheDocument();
}

test("Center each composer avatar and pull the cast toward one size", async () => {
  await openPublicAgents();

  const flat = slotTransform(FLAT_HAIRED, "data-avatar-artwork");
  const tall = slotTransform(TALL_HAIRED, "data-avatar-artwork");

  expect(flat.offsetY).toBeLessThan(-10);
  expect(flat.scale).toBeGreaterThan(1);
  expect(flat.scale).toBeLessThan(1.25);
  expect(Math.abs(tall.offsetY)).toBeLessThan(1);
  expect(tall.scale).toBeLessThan(1);
  expect(tall.scale).toBeGreaterThan(0.9);
  const initialRatio = 383.4 / 250.4;
  expect(initialRatio).toBeGreaterThan(1.5);
  const framedRatio = (383.4 * tall.scale) / (250.4 * flat.scale);
  expect(framedRatio).toBeCloseTo(Math.sqrt(initialRatio), 2);
});

test("Move the head to the chin baseline instead of resizing it", async () => {
  await openPublicAgents();

  const flatHead = slotTransform(FLAT_HAIRED, "data-avatar-head");
  const tallHead = slotTransform(TALL_HAIRED, "data-avatar-head");

  for (const head of [flatHead, tallHead]) {
    expect(head.scale).toBe(1);
    expect(head.offsetY).not.toBe(0);
  }
  expect(flatHead.offsetY).not.toBeCloseTo(tallHead.offsetY, 1);
});

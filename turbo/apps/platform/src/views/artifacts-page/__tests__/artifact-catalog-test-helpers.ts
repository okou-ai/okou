import type { ArtifactSummary } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen } from "@testing-library/react";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function artifact(
  overrides: Partial<ArtifactSummary> = {},
): ArtifactSummary {
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    kind: "file",
    title: "launch-plan.txt",
    thumbnail: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function setupArtifactCatalogPage(
  context: TestContext,
  options: {
    readonly path?: string;
  } = {},
): Promise<void> {
  return setupPage({
    context,
    path: options.path ?? "/artifacts",
  });
}

export function queryButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

export function getButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByName(name, container);
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

export async function findArtifactAction(title: string): Promise<HTMLElement> {
  const titleElement = await screen.findByText(title);
  const action = titleElement.closest<HTMLElement>(
    'a[href], button, [role="button"]',
  );
  if (!action) {
    throw new Error(`Expected an artifact action for "${title}"`);
  }
  return action;
}

export function getCatalogViewport(): HTMLElement {
  const viewport = document.querySelector<HTMLElement>("main");
  if (!viewport) {
    throw new Error("Expected the artifact catalog scroll region");
  }
  return viewport;
}

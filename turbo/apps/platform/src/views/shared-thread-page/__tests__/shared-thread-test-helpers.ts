import type { SharedThreadResponse } from "@okouai/api-contracts/contracts/shared-threads";
import type { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  queryAllByRoleFast,
  setupPage,
  type SetupPageAuth,
} from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const SHARED_THREAD_ID = "30000000-0000-4000-8000-000000000702";

export function sharedThread(
  overrides: Partial<SharedThreadResponse> = {},
): SharedThreadResponse {
  return {
    id: SHARED_THREAD_ID,
    title: "Public launch plan",
    publicBrand: "vm0",
    messages: [],
    ...overrides,
  };
}

export function setupSharedThreadPage(
  context: TestContext,
  options: {
    readonly host?: string;
    /** Omitted for the signed-out visitor every share link expects. */
    readonly auth?: SetupPageAuth;
    readonly featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>;
  } = {},
): Promise<void> {
  return setupPage({
    context,
    path: `/share/threads/${SHARED_THREAD_ID}`,
    host: options.host,
    auth: options.auth ?? null,
    ...(options.featureSwitches
      ? { featureSwitches: options.featureSwitches }
      : {}),
  });
}

export function linksByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement[] {
  return queryAllByRoleFast("link", container).filter((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

export function getLinkByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const link = linksByName(name, container)[0];
  if (!link) {
    throw new Error(`Expected link named "${name}"`);
  }
  return link;
}

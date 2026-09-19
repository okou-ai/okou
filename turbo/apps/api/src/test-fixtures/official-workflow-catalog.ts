import { AsyncLocalStorage } from "node:async_hooks";

import { db } from "../lib/db";
import { singleton } from "../lib/singleton";
import {
  currentOfficialWorkflowCatalogAuthority,
  lockOfficialWorkflowCatalogActivation,
  withOfficialWorkflowCatalogAuthorityForTest,
} from "../signals/services/official-workflow-catalog-authority";
import { createDeferredPromise } from "../signals/utils";

interface OfficialWorkflowCatalogFixtureState {
  readonly authority: string;
  readonly organizationIds: Set<string>;
}

const officialWorkflowCatalogFixtureState = singleton(() => {
  return new AsyncLocalStorage<OfficialWorkflowCatalogFixtureState>();
});

export async function withOfficialWorkflowCatalogFixture<T>(
  testId: string,
  work: () => Promise<T>,
): Promise<T> {
  return await withOfficialWorkflowCatalogAuthorityForTest(testId, async () => {
    const state: OfficialWorkflowCatalogFixtureState = {
      authority: currentOfficialWorkflowCatalogAuthority(),
      organizationIds: new Set(),
    };
    return await officialWorkflowCatalogFixtureState().run(state, work);
  });
}

function currentFixtureState(): OfficialWorkflowCatalogFixtureState {
  const state = officialWorkflowCatalogFixtureState.peek()?.getStore();
  if (!state || state.authority !== currentOfficialWorkflowCatalogAuthority()) {
    throw new Error("Official Workflow catalog test fixture is not active");
  }
  return state;
}

export function registerOfficialWorkflowCatalogFixtureOrganization(
  organizationId: string,
): void {
  if (organizationId.length === 0) {
    throw new Error(
      "Official Workflow catalog fixture organization is invalid",
    );
  }
  currentFixtureState().organizationIds.add(organizationId);
}

export function currentOfficialWorkflowCatalogFixtureOrganizationIds(): string[] {
  return [...currentFixtureState().organizationIds].sort();
}

export async function holdOfficialWorkflowCatalogActivationLockFixture(
  signal: AbortSignal,
): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
}> {
  const acquired = createDeferredPromise<void>(signal);
  const released = createDeferredPromise<void>(signal);
  const done = db().transaction(async (tx) => {
    await lockOfficialWorkflowCatalogActivation(tx);
    acquired.resolve(undefined);
    await released.promise;
  });
  await Promise.race([acquired.promise, done]);
  if (!acquired.settled()) {
    throw new Error(
      "Official Workflow catalog fixture finished before acquiring its lock",
    );
  }
  return {
    done,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  };
}

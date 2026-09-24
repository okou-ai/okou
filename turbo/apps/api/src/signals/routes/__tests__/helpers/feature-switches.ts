import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { seedRetainedNativeMorningBriefOverride } from "../../../../test-fixtures/retained-native-morning-brief-override";
import { createRouteMocks } from "./route-test";
import { featureSwitchesRoutes } from "../../feature-switches";

type ClerkOrgRole = "org:admin" | "org:member";

interface FeatureSwitchActor {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole?: ClerkOrgRole;
}

function featureSwitchesClient(context: TestContext) {
  return setupApp({ context, routes: featureSwitchesRoutes })(
    featureSwitchesContract,
  );
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function authenticateFeatureSwitchActor(
  context: TestContext,
  actor: FeatureSwitchActor,
): void {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
}

export async function updateFeatureSwitchesForUser(
  context: TestContext,
  actor: FeatureSwitchActor,
  switches: Readonly<Record<string, boolean>>,
): Promise<void> {
  authenticateFeatureSwitchActor(context, actor);
  await accept(
    featureSwitchesClient(context).update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

/**
 * A historical native opt-in cannot be created through the retired public API.
 * Seed only that old-writer state; keep all other writes on their real route.
 */
export async function seedRetainedNativeMorningBriefForUser(
  context: TestContext,
  actor: FeatureSwitchActor,
  switches: Readonly<Record<string, boolean>>,
): Promise<void> {
  if (switches[FeatureSwitchKey.NativeMorningBrief] !== true) {
    throw new Error("Expected a retained Native Morning Brief opt-in");
  }
  const other = Object.fromEntries(
    Object.entries(switches).filter(([key]) => {
      return key !== FeatureSwitchKey.NativeMorningBrief;
    }),
  );
  authenticateFeatureSwitchActor(context, actor);
  if (Object.keys(other).length > 0) {
    await updateFeatureSwitchesForUser(context, actor, other);
  }
  await seedRetainedNativeMorningBriefOverride(actor);
}

/** The old API could turn Native back on; the current API can only turn it off. */
export async function setHistoricalNativeMorningBriefForUser(
  context: TestContext,
  actor: FeatureSwitchActor,
  enabled: boolean,
): Promise<void> {
  const switches = { [FeatureSwitchKey.NativeMorningBrief]: enabled };
  if (enabled) {
    await seedRetainedNativeMorningBriefForUser(context, actor, switches);
  } else {
    await updateFeatureSwitchesForUser(context, actor, switches);
  }
}

export async function deleteFeatureSwitchesForUser(
  context: TestContext,
  actor: FeatureSwitchActor,
): Promise<void> {
  authenticateFeatureSwitchActor(context, actor);
  await accept(
    featureSwitchesClient(context).delete({ headers: authHeaders() }),
    [200],
  );
}

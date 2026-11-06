import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { onTestFinished } from "vitest";
import type { TestContext } from "../../../../__tests__/test-context";
import type { ApiTestUser } from "./api-bdd";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./feature-switches";

/** Opt this test-owned identity into the staged consumer using the public API. */
export async function enableConnectorSkillBundles(
  context: TestContext,
  actor: ApiTestUser,
): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Expected an organization for Connector Skill delivery");
  }
  const scoped = { ...actor, orgId: actor.orgId };
  await updateFeatureSwitchesForUser(context, scoped, {
    [FeatureSwitchKey.ConnectorSkillBundleDelivery]: true,
  });
  onTestFinished(() => {
    return deleteFeatureSwitchesForUser(context, scoped);
  });
}

import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import {
  ORG_DEFAULT_RUN_MODEL,
  type SupportedRunModel,
  type UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { modelPoliciesRoutes } from "../../model-policies";
import { updateFeatureSwitchesForUser } from "./feature-switches";

/**
 * A policy for the test helpers' wholesale policy replacement. The org default
 * is fixed, so a test that wants runs without an explicit model to use this
 * policy marks it `preferred`: the helper then stores it as the acting
 * member's model preference.
 */
export type TestOrgModelPolicy = UpdateOrgModelPolicy & {
  readonly preferred?: boolean;
};

/**
 * Build the request a real client sends: the fixed default policy is always
 * kept, and the preferred model (if any) is returned separately.
 */
export function orgModelPolicyWrite(policies: readonly TestOrgModelPolicy[]): {
  readonly policies: UpdateOrgModelPolicy[];
  readonly preferredModel: SupportedRunModel | null;
} {
  const request = policies.map((policy): UpdateOrgModelPolicy => {
    return {
      model: policy.model,
      defaultProviderType: policy.defaultProviderType,
      credentialScope: policy.credentialScope,
      modelProviderId: policy.modelProviderId,
      ...(policy.modelProviderSurfaceId === undefined
        ? {}
        : { modelProviderSurfaceId: policy.modelProviderSurfaceId }),
    };
  });
  const hasOrgDefault = request.some((policy) => {
    return policy.model === ORG_DEFAULT_RUN_MODEL;
  });
  const preferred = policies.find((policy) => {
    return policy.preferred === true;
  });
  return {
    policies: hasOrgDefault
      ? request
      : [
          {
            model: ORG_DEFAULT_RUN_MODEL,
            defaultProviderType: "built-in",
            credentialScope: "org",
            modelProviderId: null,
          },
          ...request,
        ],
    preferredModel: preferred?.model ?? null,
  };
}

/**
 * New organizations start in Auto, which manages policies and rejects
 * workspace credentials. Tests that configure either switch the organization
 * to Custom the way production does: a Debug admin uses the mode route.
 */
export async function ensureCustomModelModeForTest(
  context: TestContext,
  actor: {
    readonly userId: string;
    readonly orgId: string | null;
    readonly orgRole?: "org:admin" | "org:member";
  },
  authenticate: () => { readonly authorization?: string },
): Promise<void> {
  const orgId = actor.orgId;
  if (!orgId) {
    return;
  }
  const client = setupApp({ context, routes: modelPoliciesRoutes })(
    modelPoliciesMainContract,
  );
  const current = await accept(client.list({ headers: authenticate() }), [200]);
  if (current.body.modelMode !== "auto") {
    return;
  }
  const featureSwitchActor = { ...actor, orgId };
  await updateFeatureSwitchesForUser(context, featureSwitchActor, {
    [FeatureSwitchKey.OkouDebug]: true,
  });
  await accept(
    client.updateMode({ headers: authenticate(), body: { mode: "custom" } }),
    [200],
  );
  await updateFeatureSwitchesForUser(context, featureSwitchActor, {
    [FeatureSwitchKey.OkouDebug]: false,
  });
}

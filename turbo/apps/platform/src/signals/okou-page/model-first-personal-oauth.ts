import {
  getMemberModelPolicyRoute,
  isMemberModelPolicyAvailable,
} from "@okouai/api-contracts/contracts/member-model-policy";
import { command } from "ccstate";
import type {
  ModelProviderResponse,
  ModelProviderType,
  OrgModelPoliciesResponse,
} from "@okouai/api-contracts/contracts/model-providers";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import {
  personalModelProviders$,
  reloadPersonalModelProviders$,
} from "../external/personal-model-providers.ts";
import {
  modelPlanCapabilities$,
  memberModelPolicyAllowedForPlan,
} from "./model-plan-capabilities.ts";

type PersonalOauthProviderType =
  | "claude-code-oauth-token"
  | "codex-oauth-token";

type PersonalModelProviderStatus =
  | {
      status: "connected";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    }
  | {
      status: "missing";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
    }
  | {
      status: "needs_reconnect";
      providerType: PersonalOauthProviderType;
      modelLabel: string;
      credentialId: string;
    };

export const reloadPersonalModelProvider$ = command(({ set }) => {
  set(reloadPersonalModelProviders$);
});

export function isPersonalOauthProviderType(
  type: ModelProviderType,
): type is PersonalOauthProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

export function personalStatusForPolicy(
  policy: OrgModelPoliciesResponse["policies"][number] | undefined,
  personalProviders: readonly ModelProviderResponse[],
): PersonalModelProviderStatus | null {
  if (policy === undefined) {
    return null;
  }
  const route = getMemberModelPolicyRoute(policy);
  if (
    route.availability === "plan_restricted" ||
    route.credentialScope !== "member" ||
    !isPersonalOauthProviderType(route.providerType)
  ) {
    return null;
  }

  const provider = personalProviders.find((candidate) => {
    return (
      candidate.type === route.providerType && candidate.isActive !== false
    );
  });
  const providerDetails = {
    providerType: route.providerType,
    modelLabel: policy.modelLabel,
  };
  if (!provider) {
    return { ...providerDetails, status: "missing" };
  }
  if (provider.needsReconnect || route.availability === "reconnect_required") {
    return {
      ...providerDetails,
      status: "needs_reconnect",
      credentialId: provider.id,
    };
  }
  return { ...providerDetails, status: "connected" };
}

export const selectedModelAvailable$ = command(
  async (
    { get },
    selectedModel: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [policies, modelCapabilities] = await Promise.all([
      get(orgModelPolicies$),
      get(modelPlanCapabilities$),
    ]);
    signal.throwIfAborted();
    const policy = policies.policies.find((candidate) => {
      return candidate.model === selectedModel;
    });
    if (policy === undefined || !isMemberModelPolicyAvailable(policy)) {
      return false;
    }
    if (!memberModelPolicyAllowedForPlan(policy, modelCapabilities)) {
      return false;
    }
    if (policy.memberEffective) {
      return true;
    }
    if (
      policy.credentialScope !== "member" ||
      !isPersonalOauthProviderType(policy.defaultProviderType)
    ) {
      return true;
    }
    const { modelProviders } = await get(personalModelProviders$);
    signal.throwIfAborted();
    const status = personalStatusForPolicy(policy, modelProviders);
    return status?.status === "connected";
  },
);

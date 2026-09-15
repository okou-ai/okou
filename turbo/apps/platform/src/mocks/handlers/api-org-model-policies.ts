import {
  getCanonicalModelDisplayName,
  getBuiltInConcreteProviderType,
  isBuiltInModelProviderType,
  getDefaultOrgModelPolicySeed,
  type OrgModelPolicy,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

function policyId(index: number): string {
  return `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`;
}

function makeDefaultPolicies(): OrgModelPolicy[] {
  const now = "2026-05-08T00:00:00.000Z";
  return getDefaultOrgModelPolicySeed().map((seed, index) => {
    return {
      id: policyId(index),
      model: seed.model,
      modelLabel: getCanonicalModelDisplayName(seed.model),
      isDefault: seed.isDefault,
      defaultProviderType: seed.defaultProviderType,
      runtimeProviderType: getBuiltInConcreteProviderType(seed.model),
      credentialScope: seed.credentialScope,
      modelProviderId: seed.modelProviderId,
      modelProviderSurfaceId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

let mockOrgModelPolicies: OrgModelPolicy[] = makeDefaultPolicies();

function response(): OrgModelPoliciesResponse {
  const policies = [...mockOrgModelPolicies];
  const workspaceDefault =
    policies.find((policy) => {
      return policy.isDefault;
    }) ?? null;
  return {
    policies,
    workspaceDefaultModel: workspaceDefault?.model ?? null,
    workspaceDefaultPolicyId: workspaceDefault?.id ?? null,
  };
}

export function resetMockOrgModelPolicies(): void {
  mockOrgModelPolicies = makeDefaultPolicies();
}

export function setMockOrgModelPolicies(policies: OrgModelPolicy[]): void {
  mockOrgModelPolicies = policies;
}

function applyUpdate(policy: UpdateOrgModelPolicy): OrgModelPolicy {
  const now = nowDate().toISOString();
  const existing = mockOrgModelPolicies.find((item) => {
    return item.model === policy.model;
  });
  return {
    id: existing?.id ?? crypto.randomUUID(),
    model: policy.model,
    modelLabel: getCanonicalModelDisplayName(policy.model),
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    ...(isBuiltInModelProviderType(policy.defaultProviderType)
      ? { runtimeProviderType: getBuiltInConcreteProviderType(policy.model) }
      : {}),
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
    modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export const apiOrgModelPoliciesHandlers = [
  mockApi(modelPoliciesMainContract.list, ({ respond }) => {
    return respond(200, response());
  }),

  mockApi(modelPoliciesMainContract.update, ({ body, respond }) => {
    mockOrgModelPolicies = body.policies.map(applyUpdate);
    return respond(200, response());
  }),
];

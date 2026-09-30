import {
  ACTIVE_RUN_MODELS,
  getCanonicalModelDisplayName,
  getBuiltInConcreteProviderType,
  isBuiltInModelProviderType,
  ORG_DEFAULT_RUN_MODEL,
  type OrgModelPolicy,
  type OrgModelMode,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

function policyId(index: number): string {
  return `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`;
}

const SEEDED_MODELS = [
  "claude-fable-5-1",
  "gpt-6-astra",
  "gpt-6-luna",
  ORG_DEFAULT_RUN_MODEL,
] as const;

function makeDefaultPolicies(): OrgModelPolicy[] {
  const now = "2026-05-08T00:00:00.000Z";
  return SEEDED_MODELS.map((model, index) => {
    return {
      id: policyId(index),
      model,
      modelLabel: getCanonicalModelDisplayName(model),
      isDefault: model === ORG_DEFAULT_RUN_MODEL,
      defaultProviderType: "built-in",
      runtimeProviderType: getBuiltInConcreteProviderType(model),
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: null,
      routeStatus: "valid",
      routeStatusReason: null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

let mockOrgModelPolicies: OrgModelPolicy[] = makeDefaultPolicies();
let mockOrgModelMode: OrgModelMode = "custom";

function response(): OrgModelPoliciesResponse {
  const policies = [...mockOrgModelPolicies];
  // Deprecated compat fields for released iOS clients mirror the fixed default.
  const workspaceDefault =
    policies.find((policy) => {
      return policy.model === ORG_DEFAULT_RUN_MODEL;
    }) ?? null;
  const configuredModels = new Set(
    policies.map((policy) => {
      return policy.model;
    }),
  );
  return {
    modelMode: mockOrgModelMode,
    revision: policies
      .map((policy) => {
        return `${policy.id}:${policy.updatedAt}`;
      })
      .join(","),
    writePreconditionRequired: false,
    policies,
    modelsAvailableToAdd: ACTIVE_RUN_MODELS.filter((model) => {
      return (
        model !== "gpt-6-sol" &&
        model !== "claude-opus-5-5" &&
        model !== "gpt-6-luna" &&
        !configuredModels.has(model)
      );
    }),
    workspaceDefaultModel: workspaceDefault?.model ?? null,
    workspaceDefaultPolicyId: workspaceDefault?.id ?? null,
  };
}

export function resetMockOrgModelPolicies(): void {
  mockOrgModelPolicies = makeDefaultPolicies();
  mockOrgModelMode = "custom";
}

export function setMockOrgModelMode(mode: OrgModelMode): void {
  mockOrgModelMode = mode;
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
    isDefault: policy.model === ORG_DEFAULT_RUN_MODEL,
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

  mockApi(modelPoliciesMainContract.updateMode, ({ body, respond }) => {
    mockOrgModelMode = body.mode;
    if (body.mode === "auto") {
      mockOrgModelPolicies = [
        applyUpdate({
          model: ORG_DEFAULT_RUN_MODEL,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
          modelProviderSurfaceId: null,
        }),
      ];
    }
    return respond(200, { mode: body.mode });
  }),

  mockApi(modelPoliciesMainContract.update, ({ body, respond }) => {
    if (
      !body.policies.some((policy) => {
        return policy.model === ORG_DEFAULT_RUN_MODEL;
      })
    ) {
      return respond(400, {
        error: {
          message: `${ORG_DEFAULT_RUN_MODEL} cannot be removed`,
          code: "BAD_REQUEST",
        },
      });
    }
    mockOrgModelPolicies = body.policies.map(applyUpdate);
    return respond(200, response());
  }),
];

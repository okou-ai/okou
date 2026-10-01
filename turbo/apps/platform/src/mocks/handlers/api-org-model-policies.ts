import {
  isBuiltInModelProviderType,
  type OrgModelPolicy,
  type OrgModelMode,
  type OrgModelPoliciesResponse,
  type UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { nowDate } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";
import { getMockModelCatalog } from "./api-model-catalog.ts";

function catalogDisplayName(model: string): string {
  return (
    getMockModelCatalog().models.find((entry) => {
      return entry.model === model;
    })?.displayName ?? model
  );
}

function catalogBuiltInConcreteProvider(model: string) {
  const route = getMockModelCatalog()
    .routes.filter((candidate) => {
      return candidate.model === model && candidate.providerType === "built-in";
    })
    .sort((left, right) => {
      return left.priority - right.priority;
    })[0];
  return (route?.concreteProviderType ?? null) as
    | OrgModelPolicy["runtimeProviderType"]
    | null;
}

function systemDefaultModel(): string {
  return getMockModelCatalog().systemDefaultModel;
}

function policyId(index: number): string {
  return `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`;
}

// Org-configured rows only. The system default is projected by the server for
// every organization (see `response()`), never stored as an org row.
const SEEDED_MODELS = [
  "claude-fable-5-1",
  "gpt-6-astra",
  "gpt-6-luna",
] as const;

const SYSTEM_DEFAULT_POLICY_ID = "00000000-0000-4000-a000-0000000000d0";

function makeBuiltInPolicy(
  id: string,
  model: string,
  now: string,
): OrgModelPolicy {
  return {
    id,
    model,
    modelLabel: catalogDisplayName(model),
    defaultProviderType: "built-in",
    runtimeProviderType: catalogBuiltInConcreteProvider(model),
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeDefaultPolicies(): OrgModelPolicy[] {
  const now = "2026-05-08T00:00:00.000Z";
  return SEEDED_MODELS.map((model, index) => {
    return {
      id: policyId(index),
      model,
      modelLabel: catalogDisplayName(model),
      defaultProviderType: "built-in",
      runtimeProviderType: catalogBuiltInConcreteProvider(model),
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

function projectedPolicies(): OrgModelPolicy[] {
  const defaultModel = systemDefaultModel();
  // A test may store an explicit row for the default model to shape its
  // route; otherwise the server projects the Built-in system default.
  const stored = mockOrgModelPolicies.find((policy) => {
    return policy.model === defaultModel;
  });
  const systemDefault =
    stored ??
    makeBuiltInPolicy(
      SYSTEM_DEFAULT_POLICY_ID,
      defaultModel,
      "2026-05-08T00:00:00.000Z",
    );
  return [
    systemDefault,
    ...mockOrgModelPolicies.filter((policy) => {
      return policy.model !== defaultModel;
    }),
  ];
}

// Server admission (`allow_new_org_policy`) keeps some active models out of
// `modelsAvailableToAdd`; the client must follow the server's list.
const NON_ADMITTED_MODELS = new Set([
  "gpt-6-sol",
  "claude-opus-5-5",
  "gpt-6-luna",
]);

function response(): OrgModelPoliciesResponse {
  const policies = projectedPolicies();
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
    modelsAvailableToAdd: getMockModelCatalog()
      .models.filter((entry) => {
        return (
          entry.replacedBy === null &&
          !NON_ADMITTED_MODELS.has(entry.model) &&
          !configuredModels.has(entry.model)
        );
      })
      .map((entry) => {
        return entry.model;
      }),
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
    modelLabel: catalogDisplayName(policy.model),
    defaultProviderType: policy.defaultProviderType,
    ...(isBuiltInModelProviderType(policy.defaultProviderType)
      ? { runtimeProviderType: catalogBuiltInConcreteProvider(policy.model) }
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
      // Auto keeps only the server-projected system default.
      mockOrgModelPolicies = [];
    }
    return respond(200, { mode: body.mode });
  }),

  mockApi(modelPoliciesMainContract.update, ({ body, respond }) => {
    // The server manages the system default row and ignores it on writes.
    const defaultModel = systemDefaultModel();
    mockOrgModelPolicies = body.policies
      .filter((policy) => {
        return policy.model !== defaultModel;
      })
      .map(applyUpdate);
    return respond(200, response());
  }),
];

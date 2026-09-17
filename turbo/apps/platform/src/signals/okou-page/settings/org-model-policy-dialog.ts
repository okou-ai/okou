import { command, computed, state } from "ccstate";
import {
  isBuiltInModelProviderType,
  type ModelProviderResponse,
  type ModelProviderType,
  type ModelProviderWriteType,
  type OrgModelPolicy,
  type SupportedRunModel,
  type UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import { createOrgModelProvider$ } from "../../external/org-model-providers.ts";
import {
  refreshOrgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../external/org-model-policies.ts";

export type ModelPolicyDialogMode = "add" | "edit";
export type ModelPolicyRouteKind = "built-in" | "api-key" | "gateway" | "oauth";

interface ModelPolicyDialogState {
  open: boolean;
  mode: ModelPolicyDialogMode;
  model: SupportedRunModel | null;
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  surfaceId: string | null;
}

const internalModelPolicyDialogState$ = state<ModelPolicyDialogState>({
  open: false,
  mode: "add",
  model: null,
  routeKind: "built-in",
  providerType: null,
  surfaceId: null,
});

const internalModelPolicyApiKey$ = state<string>("");
const internalModelPolicyApiKeyError$ = state<string | null>(null);
const internalModelPolicyApiKeyTouched$ = state<boolean>(false);

export const modelPolicyApiKey$ = computed((get) => {
  return get(internalModelPolicyApiKey$);
});

export const modelPolicyApiKeyError$ = computed((get) => {
  return get(internalModelPolicyApiKeyError$);
});

export const modelPolicyApiKeyTouched$ = computed((get) => {
  return get(internalModelPolicyApiKeyTouched$);
});

export const setModelPolicyApiKey$ = command(({ set }, value: string) => {
  set(internalModelPolicyApiKey$, value);
  set(internalModelPolicyApiKeyTouched$, true);
  set(internalModelPolicyApiKeyError$, null);
});

export const markModelPolicyApiKeyTouched$ = command(({ set }) => {
  set(internalModelPolicyApiKeyTouched$, true);
});

export const setModelPolicyApiKeyError$ = command(
  ({ set }, error: string | null) => {
    set(internalModelPolicyApiKeyError$, error);
  },
);

function isOAuthMemberType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function getPolicyRouteKind(policy: OrgModelPolicy): ModelPolicyRouteKind {
  if (policy.modelProviderSurfaceId) {
    return "gateway";
  }
  if (isBuiltInModelProviderType(policy.defaultProviderType)) {
    return "built-in";
  }
  if (isOAuthMemberType(policy.defaultProviderType)) {
    return "oauth";
  }
  return "api-key";
}

function toOrgModelPolicyUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
  return {
    model: policy.model,
    isDefault: policy.isDefault,
    defaultProviderType: isBuiltInModelProviderType(policy.defaultProviderType)
      ? "built-in"
      : policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
    modelProviderSurfaceId: policy.modelProviderSurfaceId,
  };
}

function applyProviderRouteToPolicies(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
  provider: ModelProviderResponse,
): UpdateOrgModelPolicy[] {
  let found = false;
  const providerType: ModelProviderWriteType = isBuiltInModelProviderType(
    provider.type,
  )
    ? "built-in"
    : provider.type;
  const updates = policies.map((policy) => {
    const update = toOrgModelPolicyUpdate(policy);
    if (policy.model !== model) {
      return update;
    }
    found = true;
    return {
      ...update,
      defaultProviderType: providerType,
      credentialScope: "org" as const,
      modelProviderId: provider.id,
      modelProviderSurfaceId: null,
    };
  });

  if (!found) {
    updates.push({
      model,
      isDefault: updates.length === 0,
      defaultProviderType: providerType,
      credentialScope: "org",
      modelProviderId: provider.id,
      modelProviderSurfaceId: null,
    });
  }

  return updates;
}

export const modelPolicyDialogState$ = computed((get) => {
  return get(internalModelPolicyDialogState$);
});

export const openAddModelPolicyDialog$ = command(
  ({ set }, model: SupportedRunModel | null) => {
    set(internalModelPolicyDialogState$, {
      open: true,
      mode: "add",
      model,
      routeKind: "built-in",
      providerType: null,
      surfaceId: null,
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

export const openEditModelPolicyDialog$ = command(
  ({ set }, policy: OrgModelPolicy) => {
    const routeKind = getPolicyRouteKind(policy);
    set(internalModelPolicyDialogState$, {
      open: true,
      mode: "edit",
      model: policy.model,
      routeKind,
      providerType: isBuiltInModelProviderType(policy.defaultProviderType)
        ? null
        : policy.defaultProviderType,
      surfaceId: policy.modelProviderSurfaceId ?? null,
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

export const closeModelPolicyDialog$ = command(({ set }) => {
  set(internalModelPolicyDialogState$, (previous) => {
    return { ...previous, open: false };
  });
});

export const completeModelPolicyDialogClose$ = command(({ get, set }) => {
  if (get(internalModelPolicyDialogState$).open) {
    return;
  }
  set(internalModelPolicyApiKey$, "");
});

export const submitModelPolicyApiKeyRoute$ = command(
  async (
    { set },
    params: {
      model: SupportedRunModel;
      providerType: ModelProviderWriteType;
      apiKey: string;
    },
    signal: AbortSignal,
  ) => {
    const result = await set(
      createOrgModelProvider$,
      { type: params.providerType, secret: params.apiKey },
      signal,
    );
    signal.throwIfAborted();

    const latest = await set(refreshOrgModelPolicies$, signal);
    signal.throwIfAborted();

    await set(
      updateOrgModelPolicies$,
      {
        revision: latest.revision,
        policies: applyProviderRouteToPolicies(
          latest.policies,
          params.model,
          result.provider,
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    set(closeModelPolicyDialog$);
  },
);

export const updateModelPolicyDialogModel$ = command(
  ({ set }, model: SupportedRunModel) => {
    set(internalModelPolicyDialogState$, (prev) => {
      return {
        ...prev,
        model,
        routeKind: "built-in" as const,
        providerType: null,
        surfaceId: null,
      };
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

export const updateModelPolicyDialogRoute$ = command(
  (
    { set },
    params: {
      routeKind: ModelPolicyRouteKind;
      providerType: ModelProviderType | null;
      surfaceId?: string | null;
    },
  ) => {
    set(internalModelPolicyDialogState$, (prev) => {
      return {
        ...prev,
        ...params,
        surfaceId: params.surfaceId ?? null,
      };
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useLastResolved,
  useLoadable,
  useSet,
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  EllipsisVertical,
  Pencil,
  Plus,
  Trash,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import {
  MODEL_PROVIDER_TYPES,
  ACTIVE_RUN_MODELS,
  getCanonicalModelDisplayName,
  getProvidersForModel,
  getSelectableProviderTypes,
  isBuiltInModelProviderType,
  type ModelProviderResponse,
  type ModelProviderType,
  type OrgModelPolicy,
  type OrgModelPoliciesResponse,
  type SupportedRunModel,
  type UpdateOrgModelPolicy,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  getModelProviderTypeForSurfaceProtocol,
  type ModelProviderConnectionResponse,
  type ModelProviderSurfaceProtocol,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import {
  orgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../../../signals/external/org-model-policies.ts";
import { modelProviderConnections$ } from "../../../../signals/external/model-provider-connections.ts";
import { orgConfiguredProviders$ } from "../../../../signals/okou-page/settings/org-model-providers.ts";
import {
  closeModelPolicyDialog$,
  completeModelPolicyDialogClose$,
  modelPolicyApiKey$,
  modelPolicyApiKeyError$,
  modelPolicyApiKeyTouched$,
  markModelPolicyApiKeyTouched$,
  modelPolicyDialogState$,
  openAddModelPolicyDialog$,
  openEditModelPolicyDialog$,
  setModelPolicyApiKey$,
  setModelPolicyApiKeyError$,
  submitModelPolicyApiKeyRoute$,
  updateModelPolicyDialogModel$,
  updateModelPolicyDialogRoute$,
  type ModelPolicyDialogMode,
  type ModelPolicyRouteKind,
} from "../../../../signals/okou-page/settings/org-model-policy-dialog.ts";
import { reloadPersonalModelProvider$ } from "../../../../signals/okou-page/model-first-personal-oauth.ts";
import { startCheckout$ } from "../../../../signals/okou-page/billing.ts";
import {
  DEFAULT_MODEL_PLAN_CAPABILITIES,
  modelAllowedForPlan,
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
  type ModelPlanCapabilities,
} from "../../../../signals/okou-page/model-plan-capabilities.ts";
import { openSettingsBillingPlans$ } from "../../../../signals/okou-page/settings/settings-dialog.ts";
import {
  hasTokenInputValue,
  sanitizeTokenInput,
} from "../../../../signals/okou-page/settings/token-input.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  getModelBrandIconType as getModelIconType,
  getUILabel,
  getBuiltInModelPriceTier,
  getBuiltInModelPriceTierLabel,
  type ModelPriceTier,
} from "../settings/provider-ui-config.ts";
import { ProviderIcon } from "../settings/provider-icons.tsx";
import { ProBadge } from "../model-provider-picker.tsx";
import { SettingsSectionHeading } from "../settings/settings-section-heading.tsx";

function isOAuthMemberType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function isByokProviderType(type: ModelProviderType): boolean {
  return !isBuiltInModelProviderType(type) && !isOAuthMemberType(type);
}

function isAddableBuiltInModel(model: SupportedRunModel): boolean {
  const providerType = getModelIconType(model);
  return (
    providerType === "openai-api-key" ||
    providerType === "anthropic-api-key" ||
    providerType === "deepseek"
  );
}

function getApiProviderTypes(model: SupportedRunModel): ModelProviderType[] {
  return getProvidersForModel(model).filter((type) => {
    return isByokProviderType(type);
  });
}

function getOAuthProviderTypes(model: SupportedRunModel): ModelProviderType[] {
  return getProvidersForModel(model).filter((type) => {
    return isOAuthMemberType(type);
  });
}

const ZERO_BORDER = {
  border: "var(--border-width-surface) solid hsl(var(--gray-400))",
} as const;

function getOAuthRouteKind(
  oauthTypes: ModelProviderType[],
): "codex" | "claude" {
  return oauthTypes.includes("codex-oauth-token") ? "codex" : "claude";
}

function getProviderConfig(type: ModelProviderType) {
  return MODEL_PROVIDER_TYPES[type] as { helpText?: string } | undefined;
}

function getProviderSignupUrl(type: ModelProviderType): string | null {
  const helpText = getProviderConfig(type)?.helpText;
  if (!helpText) {
    return null;
  }
  const match = /https?:\/\/[^\s)]+/.exec(helpText);
  return match ? match[0] : null;
}

function findProviderByType(
  providers: ModelProviderResponse[],
  type: ModelProviderType | null,
): ModelProviderResponse | null {
  if (!type) {
    return null;
  }
  return (
    providers.find((provider) => {
      return provider.type === type;
    }) ?? null
  );
}

function toUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
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

function makeDefaultPolicy(
  model: SupportedRunModel,
  isDefault: boolean,
): UpdateOrgModelPolicy {
  return {
    model,
    isDefault,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
  };
}

function upsertPolicy(
  policies: OrgModelPolicy[],
  update: UpdateOrgModelPolicy,
): UpdateOrgModelPolicy[] {
  let found = false;
  const updates = policies.map((policy) => {
    if (policy.model !== update.model) {
      return toUpdate(policy);
    }
    found = true;
    return update;
  });
  if (!found) {
    updates.push(update);
  }
  return updates;
}

function removePolicy(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
): UpdateOrgModelPolicy[] {
  const removed = policies.find((policy) => {
    return policy.model === model;
  });
  const updates = policies.flatMap((policy) => {
    return policy.model === model ? [] : [toUpdate(policy)];
  });
  if (
    removed?.isDefault &&
    !updates.some((policy) => {
      return policy.isDefault;
    }) &&
    updates[0]
  ) {
    return updates.map((policy, index) => {
      return { ...policy, isDefault: index === 0 };
    });
  }
  return updates;
}

function makePolicyDefault(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
): UpdateOrgModelPolicy[] {
  const selected = policies.find((policy) => {
    return policy.model === model;
  });
  if (!selected) {
    return policies.map(toUpdate);
  }
  return policies.map((policy) => {
    return {
      ...toUpdate(policy),
      isDefault: policy.model === model,
    };
  });
}

function filterPolicyUpdatesForPlan(
  policies: UpdateOrgModelPolicy[],
  modelCapabilities: ModelPlanCapabilities,
): UpdateOrgModelPolicy[] {
  if (
    modelCapabilities.supportByok &&
    !modelCapabilities.restrictedBuiltInModels
  ) {
    return policies;
  }

  const allowed = policies.filter((policy) => {
    return modelPolicyAllowedForPlan(policy, modelCapabilities);
  });
  if (
    allowed.some((policy) => {
      return policy.isDefault;
    })
  ) {
    return allowed;
  }
  return allowed.map((policy, index) => {
    return { ...policy, isDefault: index === 0 };
  });
}

function DefaultModelRow({
  policies,
  workspaceDefaultModel,
  disabled,
  modelCapabilities,
  onChange,
  onUpgrade,
}: {
  policies: OrgModelPolicy[];
  workspaceDefaultModel: SupportedRunModel | null;
  disabled: boolean;
  modelCapabilities: ModelPlanCapabilities;
  onChange: (model: SupportedRunModel) => void;
  onUpgrade: () => void;
}) {
  const { t } = useTranslation();
  const selectItems = policies.filter((policy) => {
    return policy.routeStatus === "valid";
  });
  const currentDefault = selectItems.some((policy) => {
    return policy.model === workspaceDefaultModel;
  })
    ? (workspaceDefaultModel ?? "")
    : "";

  return (
    <div
      data-testid="default-model-row"
      className="flex flex-col gap-3 overflow-hidden rounded-xl bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      style={{
        border: "var(--border-width-surface) solid hsl(var(--gray-400))",
      }}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.settings.models.policies.defaultModel;
          })}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {t(($) => {
            return $.settings.models.policies.defaultModelDescription;
          })}
        </p>
      </div>
      {selectItems.length === 0 ? (
        <span className="shrink-0 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.policies.noAvailableModels;
          })}
        </span>
      ) : (
        <Select
          value={currentDefault}
          onValueChange={(value) => {
            const model = value as SupportedRunModel;
            const policy = selectItems.find((item) => {
              return item.model === model;
            });
            if (
              policy !== undefined &&
              !modelPolicyAllowedForPlan(policy, modelCapabilities)
            ) {
              onUpgrade();
              return;
            }
            onChange(model);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            className="h-9 w-full shrink-0 rounded-lg bg-card sm:w-[280px]"
            style={{
              border: "var(--border-width-surface) solid hsl(var(--gray-400))",
            }}
          >
            <SelectValue
              placeholder={t(($) => {
                return $.settings.models.policies.selectDefaultModel;
              })}
            />
          </SelectTrigger>
          <SelectContent>
            {selectItems.map((policy) => {
              const iconType = getModelIconType(policy.model);
              const restricted = !modelPolicyAllowedForPlan(
                policy,
                modelCapabilities,
              );
              return (
                <SelectItem key={policy.id} value={policy.model}>
                  <div className="flex w-full min-w-0 items-center gap-2">
                    {iconType && <ProviderIcon type={iconType} size={16} />}
                    <span className="min-w-0 flex-1 truncate">
                      {policy.modelLabel}
                    </span>
                    {restricted && <ProBadge />}
                  </div>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function getPolicyDetail(policy: OrgModelPolicy): string | null {
  if (policy.routeStatusReason) {
    return policy.routeStatusReason;
  }
  return null;
}

function PriceTierBadge({ tier }: { tier: ModelPriceTier }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-7 min-w-10 shrink-0 cursor-help items-center justify-center rounded-lg px-2 text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 transition-colors hover:bg-state-hover hover:text-foreground hover:decoration-muted-foreground">
            {tier}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {getBuiltInModelPriceTierLabel(tier)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function getSelectedByokProvider(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
): ModelProviderResponse | null {
  if (
    policy.credentialScope !== "org" ||
    !isByokProviderType(policy.defaultProviderType) ||
    !policy.modelProviderId
  ) {
    return null;
  }
  return (
    providers.find((provider) => {
      return provider.id === policy.modelProviderId;
    }) ?? null
  );
}

function findGatewayConnection(
  connections: ModelProviderConnectionResponse[],
  surfaceId: string | null,
): ModelProviderConnectionResponse | null {
  if (!surfaceId) {
    return null;
  }
  return (
    connections.find((connection) => {
      return connection.surfaces.some((surface) => {
        return surface.id === surfaceId;
      });
    }) ?? null
  );
}

function gatewaySurfacesForModel(
  connections: ModelProviderConnectionResponse[],
  model: SupportedRunModel,
) {
  return connections.flatMap((connection) => {
    return connection.surfaces.flatMap((surface) => {
      return surface.modelMappings[model] ? [{ connection, surface }] : [];
    });
  });
}

function gatewayProviderType(
  protocol: ModelProviderSurfaceProtocol,
): ModelProviderType {
  return getModelProviderTypeForSurfaceProtocol(protocol);
}

function getPolicyRouteSummary(
  policy: OrgModelPolicy,
  providers: ModelProviderResponse[],
  connections: ModelProviderConnectionResponse[],
  builtInLabel: string,
): { label: string; iconType: ModelProviderType } {
  if (isBuiltInModelProviderType(policy.defaultProviderType)) {
    return {
      label: builtInLabel,
      iconType: "built-in",
    };
  }

  const gatewayConnection = findGatewayConnection(
    connections,
    policy.modelProviderSurfaceId ?? null,
  );
  if (gatewayConnection) {
    return {
      label: gatewayConnection.displayName,
      iconType: policy.defaultProviderType,
    };
  }

  const orgProvider = getSelectedByokProvider(policy, providers);
  if (orgProvider) {
    return {
      label: getUILabel(orgProvider.type),
      iconType: orgProvider.type,
    };
  }
  if (
    policy.credentialScope === "member" &&
    isOAuthMemberType(policy.defaultProviderType)
  ) {
    return {
      label: getUILabel(policy.defaultProviderType),
      iconType: policy.defaultProviderType,
    };
  }

  return {
    label: getUILabel(policy.defaultProviderType),
    iconType: policy.defaultProviderType,
  };
}

function PolicyActionsMenu({
  policy,
  disabled,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: OrgModelPolicy;
  disabled: boolean;
  canDelete: boolean;
  onEdit: (policy: OrgModelPolicy) => void;
  onDelete: (policy: OrgModelPolicy) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          showTooltip
          type="button"
          variant="quiet"
          size="icon-sm"
          className="shrink-0 rounded-lg"
          disabled={disabled}
          aria-label={t(
            ($) => {
              return $.settings.models.policies.actionsFor;
            },
            {
              model: policy.modelLabel,
            },
          )}
        >
          <EllipsisVertical size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            onEdit(policy);
          }}
        >
          <Pencil size={14} />
          {t(($) => {
            return $.settings.models.actions.editModel;
          })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          disabled={disabled || !canDelete}
          onSelect={() => {
            onDelete(policy);
          }}
        >
          <Trash size={14} />
          {t(($) => {
            return $.settings.models.actions.deleteModel;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddModelButton({
  hasModels,
  disabled,
  onClick,
}: {
  hasModels: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (!hasModels) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="neutral"
      size="sm"
      className="h-9 gap-2 rounded-lg"
      disabled={disabled}
      onClick={onClick}
    >
      <Plus size={14} />
      {t(($) => {
        return $.settings.models.actions.addModel;
      })}
    </Button>
  );
}

function PolicyRow({
  policy,
  providers,
  connections,
  disabled,
  canDelete,
  onEdit,
  onDelete,
}: {
  policy: OrgModelPolicy;
  providers: ModelProviderResponse[];
  connections: ModelProviderConnectionResponse[];
  disabled: boolean;
  canDelete: boolean;
  onEdit: (policy: OrgModelPolicy) => void;
  onDelete: (policy: OrgModelPolicy) => void;
}) {
  const { t } = useTranslation();
  const detail = getPolicyDetail(policy);
  const routeSummary = getPolicyRouteSummary(
    policy,
    providers,
    connections,
    t(($) => {
      return $.settings.models.policies.builtIn;
    }),
  );
  const modelIconType = getModelIconType(policy.model);
  const builtInPriceTier = isBuiltInModelProviderType(
    policy.defaultProviderType,
  )
    ? getBuiltInModelPriceTier(policy.model)
    : undefined;

  return (
    <div
      data-testid={`org-model-policy-row-${policy.model}`}
      className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg px-3 py-3.5 transition-colors after:pointer-events-none after:absolute after:bottom-0 after:left-[3.75rem] after:right-3 after:h-px after:bg-divider/50 after:content-[''] last:after:hidden hover:bg-gray-50 dark:hover:bg-gray-100 lg:grid-cols-[minmax(0,1fr)_236px_96px_36px]"
    >
      <div className="col-start-1 row-start-1 flex min-w-0 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2">
          {modelIconType && (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 dark:bg-gray-100">
              <ProviderIcon type={modelIconType} size={18} />
            </span>
          )}
          <p className="min-w-0 truncate text-sm font-medium text-foreground">
            {policy.modelLabel}
          </p>
          {policy.routeStatus !== "valid" && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <AlertTriangle size={12} />
              {policy.routeStatus === "missing_provider"
                ? t(($) => {
                    return $.settings.models.policies.missingProvider;
                  })
                : t(($) => {
                    return $.settings.models.policies.invalidRoute;
                  })}
            </span>
          )}
        </div>
        {detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {detail}
          </p>
        )}
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end lg:col-start-4">
        <PolicyActionsMenu
          policy={policy}
          disabled={disabled}
          canDelete={canDelete}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
      <div className="col-start-1 row-start-2 flex min-w-0 flex-col justify-center lg:col-start-2 lg:row-start-1">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <span className="flex size-7 shrink-0 items-center justify-center">
            <ProviderIcon type={routeSummary.iconType} size={16} />
          </span>
          <span className="min-w-0 truncate">{routeSummary.label}</span>
        </div>
      </div>
      <div className="col-start-2 row-start-2 flex items-center justify-end lg:col-start-3 lg:row-start-1 lg:justify-start">
        {builtInPriceTier === undefined ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <PriceTierBadge tier={builtInPriceTier} />
        )}
      </div>
    </div>
  );
}

function RouteChoiceButton({
  active,
  disabled = false,
  pro = false,
  title,
  description,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  pro?: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      style={{
        border: active
          ? "var(--border-width-surface) solid hsl(var(--primary))"
          : "var(--border-width-surface) solid hsl(var(--gray-400))",
      }}
      className={cn(
        "flex flex-col gap-0.5 rounded-xl bg-card px-5 py-4 text-left transition-colors",
        active && "bg-primary/5",
        !active && !disabled && "hover:bg-state-hover",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2 text-sm font-medium text-foreground">
        <span className="whitespace-nowrap">{title}</span>
        {pro && <ProBadge />}
      </span>
      <span className="text-[13px] text-muted-foreground">{description}</span>
    </button>
  );
}

function ProviderTypeSelect({
  value,
  types,
  placeholder,
  onChange,
}: {
  value: ModelProviderType | null;
  types: ModelProviderType[];
  placeholder: string;
  onChange: (type: ModelProviderType) => void;
}) {
  if (types.length === 0) {
    return null;
  }

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        onChange(next as ModelProviderType);
      }}
    >
      <SelectTrigger className="h-10 rounded-lg" style={ZERO_BORDER}>
        <SelectValue placeholder={placeholder}>
          {value && (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderIcon type={value} size={16} />
              <span className="min-w-0 truncate">{getUILabel(value)}</span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {types
          .filter((type) => {
            return getSelectableProviderTypes().includes(type);
          })
          .map((type) => {
            return (
              <SelectItem key={type} value={type}>
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderIcon type={type} size={16} />
                  <span className="min-w-0 flex-1 truncate">
                    {getUILabel(type)}
                  </span>
                </div>
              </SelectItem>
            );
          })}
      </SelectContent>
    </Select>
  );
}

const MASKED_API_KEY = "••••••••••••••••";

function ApiKeyProviderSection({
  selectedProviderType,
  apiTypes,
  routeProvider,
  apiKeyValue,
  apiKeyTouched,
  apiKeyError,
  onChange,
  onApiKeyChange,
  onApiKeyFocus,
}: {
  selectedProviderType: ModelProviderType | null;
  apiTypes: ModelProviderType[];
  routeProvider: ModelProviderResponse | null;
  apiKeyValue: string;
  apiKeyTouched: boolean;
  apiKeyError: string | null;
  onChange: (type: ModelProviderType) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyFocus: () => void;
}) {
  const { t } = useTranslation();
  const secretSignupUrl = selectedProviderType
    ? getProviderSignupUrl(selectedProviderType)
    : null;
  const showMaskedExistingKey = Boolean(routeProvider) && !apiKeyTouched;
  const displayedKey = showMaskedExistingKey ? MASKED_API_KEY : apiKeyValue;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.settings.models.policies.provider;
          })}
        </label>
        <ProviderTypeSelect
          value={selectedProviderType}
          types={apiTypes}
          placeholder={t(($) => {
            return $.settings.models.policies.selectProvider;
          })}
          onChange={onChange}
        />
      </div>
      {selectedProviderType && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            {t(
              ($) => {
                return $.settings.models.policies.providerApiKey;
              },
              {
                provider: getUILabel(selectedProviderType),
              },
            )}
          </label>
          <Input
            type="password"
            autoComplete="off"
            value={displayedKey}
            placeholder={t(($) => {
              return $.settings.models.policies.apiKeyPlaceholder;
            })}
            onFocus={() => {
              if (showMaskedExistingKey) {
                onApiKeyFocus();
              }
            }}
            onChange={(e) => {
              onApiKeyChange(e.target.value);
            }}
            className={apiKeyError ? "h-10 border-destructive" : "h-10"}
          />
          {apiKeyError ? (
            <p className="text-xs text-destructive">{apiKeyError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(($) => {
                return $.settings.models.policies.secretStored;
              })}{" "}
              {secretSignupUrl ? (
                <a
                  href={secretSignupUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-text underline"
                >
                  {t(($) => {
                    return $.settings.models.policies.getKey;
                  })}
                </a>
              ) : null}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function GatewayProviderSection({
  model,
  connections,
  surfaceId,
  onChange,
}: {
  model: SupportedRunModel;
  connections: ModelProviderConnectionResponse[];
  surfaceId: string | null;
  onChange: (surfaceId: string, providerType: ModelProviderType) => void;
}) {
  const { t } = useTranslation();
  const options = gatewaySurfacesForModel(connections, model);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.settings.models.policies.gatewayProvider;
        })}
      </label>
      <Select
        value={surfaceId}
        onValueChange={(next) => {
          const selected = options.find((option) => {
            return option.surface.id === next;
          });
          if (selected) {
            onChange(
              selected.surface.id,
              gatewayProviderType(selected.surface.protocol),
            );
          }
        }}
      >
        <SelectTrigger className="h-10 rounded-lg" style={ZERO_BORDER}>
          <SelectValue
            placeholder={t(($) => {
              return $.settings.models.policies.selectGateway;
            })}
          >
            {surfaceId
              ? options.find((option) => {
                  return option.surface.id === surfaceId;
                })?.connection.displayName
              : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(({ connection, surface }) => {
            return (
              <SelectItem key={surface.id} value={surface.id}>
                {connection.displayName}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {options.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.models.policies.noMappedGateway;
          })}
        </p>
      )}
    </div>
  );
}

function buildPolicyUpdate(params: {
  policies: OrgModelPolicy[];
  model: SupportedRunModel;
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  provider: ModelProviderResponse | null;
  surfaceId: string | null;
}): UpdateOrgModelPolicy | null {
  const existing = params.policies.find((policy) => {
    return policy.model === params.model;
  });
  const base = existing
    ? toUpdate(existing)
    : makeDefaultPolicy(params.model, params.policies.length === 0);

  if (params.routeKind === "built-in") {
    return {
      ...base,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: null,
    };
  }

  if (!params.providerType) {
    return null;
  }

  if (params.routeKind === "oauth") {
    return {
      ...base,
      defaultProviderType: isBuiltInModelProviderType(params.providerType)
        ? "built-in"
        : params.providerType,
      credentialScope: "member",
      modelProviderId: null,
      modelProviderSurfaceId: null,
    };
  }

  if (params.routeKind === "gateway") {
    if (!params.surfaceId) {
      return null;
    }
    return {
      ...base,
      defaultProviderType: isBuiltInModelProviderType(params.providerType)
        ? "built-in"
        : params.providerType,
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: params.surfaceId,
    };
  }

  if (!params.provider) {
    return null;
  }

  return {
    ...base,
    defaultProviderType: isBuiltInModelProviderType(params.provider.type)
      ? "built-in"
      : params.provider.type,
    credentialScope: "org",
    modelProviderId: params.provider.id,
    modelProviderSurfaceId: null,
  };
}

function modelRequiresProUpgrade(
  model: SupportedRunModel | null,
  modelCapabilities: ModelPlanCapabilities,
): boolean {
  return model !== null && !modelAllowedForPlan(model, modelCapabilities);
}

function getDialogPrimaryLabel(params: {
  mode: ModelPolicyDialogMode;
  upgradeRequired: boolean;
  upgradeLabel: string;
  addLabel: string;
  saveLabel: string;
}): string {
  if (params.upgradeRequired) {
    return params.upgradeLabel;
  }
  return params.mode === "add" ? params.addLabel : params.saveLabel;
}

function isSubmitDisabled(params: {
  selectedModel: SupportedRunModel | null;
  saving: boolean;
  inlineSaving: boolean;
  checkoutLoading: boolean;
  upgradeRequired: boolean;
  routeKind: ModelPolicyRouteKind;
  selectedProviderType: ModelProviderType | null;
  surfaceId: string | null;
}): boolean {
  if (
    !params.selectedModel ||
    params.saving ||
    params.inlineSaving ||
    params.checkoutLoading
  ) {
    return true;
  }
  if (params.upgradeRequired) {
    return false;
  }
  if (params.routeKind === "built-in") {
    return false;
  }
  if (params.routeKind === "gateway") {
    return params.surfaceId === null;
  }
  return params.selectedProviderType === null;
}

function getDefaultProviderTypeForRoute(params: {
  routeKind: ModelPolicyRouteKind;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
}): ModelProviderType | null {
  if (params.routeKind === "api-key") {
    return params.apiTypes[0] ?? null;
  }
  if (params.routeKind === "oauth") {
    return params.oauthTypes[0] ?? null;
  }
  return null;
}

function getSelectedProviderType(params: {
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
}): ModelProviderType | null {
  if (params.routeKind === "api-key") {
    return params.providerType && params.apiTypes.includes(params.providerType)
      ? params.providerType
      : (params.apiTypes[0] ?? null);
  }
  if (params.routeKind === "oauth") {
    return params.providerType &&
      params.oauthTypes.includes(params.providerType)
      ? params.providerType
      : (params.oauthTypes[0] ?? null);
  }
  if (params.routeKind === "gateway") {
    return params.providerType;
  }
  return null;
}

function getSelectedRouteProvider(params: {
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
  providers: ModelProviderResponse[];
}): ModelProviderResponse | null {
  if (params.routeKind === "api-key") {
    return findProviderByType(params.providers, params.providerType);
  }
  return null;
}

function ModelSelectionField({
  selectedModel,
  addableModels,
  modelCapabilities,
  disabled,
  onChange,
}: {
  selectedModel: SupportedRunModel | null;
  addableModels: SupportedRunModel[];
  modelCapabilities: ModelPlanCapabilities;
  disabled: boolean;
  onChange: (model: SupportedRunModel) => void;
}) {
  const { t } = useTranslation();
  const selectedModelIcon = selectedModel
    ? getModelIconType(selectedModel)
    : null;
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.settings.models.policies.model;
        })}
      </label>
      <Select
        value={selectedModel}
        onValueChange={(next) => {
          onChange(next as SupportedRunModel);
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-10 rounded-lg" style={ZERO_BORDER}>
          <SelectValue
            placeholder={t(($) => {
              return $.settings.models.policies.selectModel;
            })}
          >
            {selectedModel && (
              <div className="flex items-center gap-2">
                {selectedModelIcon && (
                  <ProviderIcon type={selectedModelIcon} size={16} />
                )}
                <span>{getCanonicalModelDisplayName(selectedModel)}</span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {addableModels.map((model) => {
            const iconType = getModelIconType(model);
            const restricted = !modelAllowedForPlan(model, modelCapabilities);
            return (
              <SelectItem key={model} value={model}>
                <div className="flex w-full min-w-0 items-center gap-2">
                  {iconType && <ProviderIcon type={iconType} size={16} />}
                  <span className="min-w-0 flex-1 truncate">
                    {getCanonicalModelDisplayName(model)}
                  </span>
                  {restricted && <ProBadge />}
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function ProviderRouteChoices({
  routeKind,
  apiTypes,
  oauthTypes,
  gatewayCount,
  supportByok,
  onChoose,
}: {
  routeKind: ModelPolicyRouteKind;
  apiTypes: ModelProviderType[];
  oauthTypes: ModelProviderType[];
  gatewayCount: number;
  supportByok: boolean;
  onChoose: (routeKind: ModelPolicyRouteKind) => void;
}) {
  const { t } = useTranslation();
  const oauthRouteKind = getOAuthRouteKind(oauthTypes);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.settings.models.policies.providedBy;
        })}
      </label>
      <div
        role="radiogroup"
        aria-label={t(($) => {
          return $.settings.models.policies.providedBy;
        })}
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
      >
        <RouteChoiceButton
          active={routeKind === "built-in"}
          title={t(($) => {
            return $.settings.models.policies.builtIn;
          })}
          description={t(($) => {
            return $.settings.models.policies.builtInDescription;
          })}
          onClick={() => {
            onChoose("built-in");
          }}
        />
        <RouteChoiceButton
          active={routeKind === "api-key"}
          disabled={apiTypes.length === 0}
          pro={!supportByok}
          title={t(($) => {
            return $.settings.models.policies.apiKey;
          })}
          description={t(($) => {
            return $.settings.models.policies.apiKeyDescription;
          })}
          onClick={() => {
            onChoose("api-key");
          }}
        />
        <RouteChoiceButton
          active={routeKind === "gateway"}
          disabled={gatewayCount === 0}
          pro={!supportByok}
          title={t(($) => {
            return $.settings.models.policies.gateway;
          })}
          description={t(($) => {
            return $.settings.models.policies.gatewayDescription;
          })}
          onClick={() => {
            onChoose("gateway");
          }}
        />
        {oauthTypes.length > 0 && (
          <RouteChoiceButton
            active={routeKind === "oauth"}
            pro={!supportByok}
            title={
              oauthRouteKind === "codex"
                ? t(($) => {
                    return $.settings.models.policies.codexSubscription;
                  })
                : t(($) => {
                    return $.settings.models.policies.claudeSubscription;
                  })
            }
            description={
              oauthRouteKind === "codex"
                ? t(($) => {
                    return $.settings.models.policies
                      .codexSubscriptionDescription;
                  })
                : t(($) => {
                    return $.settings.models.policies
                      .claudeSubscriptionDescription;
                  })
            }
            onClick={() => {
              onChoose("oauth");
            }}
          />
        )}
      </div>
    </div>
  );
}

function ProviderRouteConfiguration({
  routeKind,
  selectedModel,
  selectedProviderType,
  apiTypes,
  routeProvider,
  apiKeyValue,
  apiKeyTouched,
  apiKeyError,
  connections,
  selectedSurfaceId,
  onApiProviderChange,
  onApiKeyChange,
  onApiKeyFocus,
  onGatewayChange,
}: {
  routeKind: ModelPolicyRouteKind;
  selectedModel: SupportedRunModel | null;
  selectedProviderType: ModelProviderType | null;
  apiTypes: ModelProviderType[];
  routeProvider: ModelProviderResponse | null;
  apiKeyValue: string;
  apiKeyTouched: boolean;
  apiKeyError: string | null;
  connections: ModelProviderConnectionResponse[];
  selectedSurfaceId: string | null;
  onApiProviderChange: (providerType: ModelProviderType) => void;
  onApiKeyChange: (value: string) => void;
  onApiKeyFocus: () => void;
  onGatewayChange: (surfaceId: string, providerType: ModelProviderType) => void;
}) {
  if (routeKind === "api-key") {
    return (
      <ApiKeyProviderSection
        selectedProviderType={selectedProviderType}
        apiTypes={apiTypes}
        routeProvider={routeProvider}
        apiKeyValue={apiKeyValue}
        apiKeyTouched={apiKeyTouched}
        apiKeyError={apiKeyError}
        onChange={onApiProviderChange}
        onApiKeyChange={onApiKeyChange}
        onApiKeyFocus={onApiKeyFocus}
      />
    );
  }
  if (routeKind === "gateway" && selectedModel) {
    return (
      <GatewayProviderSection
        model={selectedModel}
        connections={connections}
        surfaceId={selectedSurfaceId}
        onChange={onGatewayChange}
      />
    );
  }
  return null;
}

function ModelPolicyRouteDialog({
  policies,
  addableModels,
  providers,
  connections,
  saving,
  modelCapabilities,
  onUpgrade,
  onSubmit,
}: {
  policies: OrgModelPolicy[];
  addableModels: SupportedRunModel[];
  providers: ModelProviderResponse[];
  connections: ModelProviderConnectionResponse[];
  saving: boolean;
  modelCapabilities: ModelPlanCapabilities;
  onUpgrade: () => void;
  onSubmit: (next: UpdateOrgModelPolicy[]) => void;
}) {
  const { t } = useTranslation();
  const dialog = useGet(modelPolicyDialogState$);
  const close = useSet(closeModelPolicyDialog$);
  const completeClose = useSet(completeModelPolicyDialogClose$);
  const setModel = useSet(updateModelPolicyDialogModel$);
  const setRoute = useSet(updateModelPolicyDialogRoute$);
  const apiKeyValue = useGet(modelPolicyApiKey$);
  const apiKeyError = useGet(modelPolicyApiKeyError$);
  const apiKeyTouched = useGet(modelPolicyApiKeyTouched$);
  const setApiKey = useSet(setModelPolicyApiKey$);
  const setApiKeyError = useSet(setModelPolicyApiKeyError$);
  const markApiKeyTouched = useSet(markModelPolicyApiKeyTouched$);
  const pageSignal = useGet(pageSignal$);
  const [inlineSaveLoadable, submitInlineApiKeyRoute] = useLoadableSet(
    submitModelPolicyApiKeyRoute$,
  );
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const inlineSaving = inlineSaveLoadable.state === "loading";
  const checkoutLoading = checkoutLoadable.state === "loading";
  const busy = saving || inlineSaving || checkoutLoading;
  const firstAllowedModel =
    addableModels.find((model) => {
      return modelAllowedForPlan(model, modelCapabilities);
    }) ?? null;
  const selectedModel = dialog.model ?? firstAllowedModel ?? null;
  const upgradeRequired = modelRequiresProUpgrade(
    selectedModel,
    modelCapabilities,
  );
  const apiTypes = selectedModel ? getApiProviderTypes(selectedModel) : [];
  const oauthTypes = selectedModel ? getOAuthProviderTypes(selectedModel) : [];
  const gatewayOptions = selectedModel
    ? gatewaySurfacesForModel(connections, selectedModel)
    : [];
  const selectedGateway =
    gatewayOptions.find((option) => {
      return option.surface.id === dialog.surfaceId;
    }) ?? gatewayOptions[0];
  const selectedSurfaceId =
    dialog.routeKind === "gateway"
      ? (selectedGateway?.surface.id ?? null)
      : null;
  const selectedProviderType =
    dialog.routeKind === "gateway" && selectedGateway
      ? gatewayProviderType(selectedGateway.surface.protocol)
      : getSelectedProviderType({
          routeKind: dialog.routeKind,
          providerType: dialog.providerType,
          apiTypes,
          oauthTypes,
        });
  const routeProvider = getSelectedRouteProvider({
    routeKind: dialog.routeKind,
    providerType: selectedProviderType,
    providers,
  });
  const isReplacingKey = dialog.routeKind === "api-key" && apiKeyTouched;
  const needsFreshKey =
    dialog.routeKind === "api-key" &&
    selectedProviderType !== null &&
    routeProvider === null;

  const chooseRoute = (routeKind: ModelPolicyRouteKind) => {
    if (!modelCapabilities.supportByok && routeKind !== "built-in") {
      onUpgrade();
      return;
    }
    if (routeKind === "gateway") {
      setRoute({
        routeKind,
        providerType: selectedGateway
          ? gatewayProviderType(selectedGateway.surface.protocol)
          : null,
        surfaceId: selectedGateway?.surface.id ?? null,
      });
    } else {
      setRoute({
        routeKind,
        providerType: getDefaultProviderTypeForRoute({
          routeKind,
          apiTypes,
          oauthTypes,
        }),
      });
    }
  };

  const handleModelChange = (model: SupportedRunModel) => {
    setModel(model);
  };

  const handleSubmit = (newTab: boolean) => {
    if (!selectedModel || busy) {
      return;
    }

    if (upgradeRequired) {
      detach(
        checkout("pro", newTab, undefined, pageSignal),
        Reason.DomCallback,
      );
      return;
    }

    if (
      dialog.routeKind === "api-key" &&
      selectedProviderType &&
      (needsFreshKey || isReplacingKey)
    ) {
      if (!hasTokenInputValue(apiKeyValue)) {
        setApiKeyError(
          t(($) => {
            return $.settings.models.policies.apiKeyRequired;
          }),
        );
        return;
      }
      detach(
        submitInlineApiKeyRoute(
          {
            model: selectedModel,
            providerType: isBuiltInModelProviderType(selectedProviderType)
              ? "built-in"
              : selectedProviderType,
            apiKey: sanitizeTokenInput(apiKeyValue),
          },
          pageSignal,
        ),
        Reason.DomCallback,
      );
      return;
    }

    const update = buildPolicyUpdate({
      policies,
      model: selectedModel,
      routeKind: dialog.routeKind,
      providerType: selectedProviderType,
      provider: routeProvider,
      surfaceId: selectedSurfaceId,
    });
    if (!update) {
      return;
    }
    onSubmit(upsertPolicy(policies, update));
    close();
  };

  const primaryLabel = getDialogPrimaryLabel({
    mode: dialog.mode,
    upgradeRequired,
    upgradeLabel: t(($) => {
      return $.settings.models.actions.upgradeToPro;
    }),
    addLabel: t(($) => {
      return $.settings.models.actions.addModel;
    }),
    saveLabel: t(($) => {
      return $.settings.shared.saveChanges;
    }),
  });
  const submitDisabled = isSubmitDisabled({
    selectedModel,
    saving,
    inlineSaving,
    checkoutLoading,
    upgradeRequired,
    routeKind: dialog.routeKind,
    selectedProviderType,
    surfaceId: selectedSurfaceId,
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open && !busy) {
          close();
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeClose();
        }
      }}
    >
      <DialogContent
        maxWidth="3xl"
        closeLabel={t(($) => {
          return $.settings.shared.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {dialog.mode === "add"
              ? t(($) => {
                  return $.settings.models.actions.addModel;
                })
              : t(($) => {
                  return $.settings.models.actions.editModel;
                })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.settings.models.policies.dialogDescription;
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <ModelSelectionField
            selectedModel={selectedModel}
            addableModels={addableModels}
            modelCapabilities={modelCapabilities}
            disabled={dialog.mode === "edit"}
            onChange={handleModelChange}
          />
          <ProviderRouteChoices
            routeKind={dialog.routeKind}
            apiTypes={apiTypes}
            oauthTypes={oauthTypes}
            gatewayCount={gatewayOptions.length}
            supportByok={modelCapabilities.supportByok}
            onChoose={chooseRoute}
          />
          <ProviderRouteConfiguration
            routeKind={dialog.routeKind}
            selectedModel={selectedModel}
            selectedProviderType={selectedProviderType}
            apiTypes={apiTypes}
            routeProvider={routeProvider}
            apiKeyValue={apiKeyValue}
            apiKeyTouched={apiKeyTouched}
            apiKeyError={apiKeyError}
            connections={connections}
            selectedSurfaceId={selectedSurfaceId}
            onApiProviderChange={(providerType) => {
              setRoute({ routeKind: "api-key", providerType });
            }}
            onApiKeyChange={setApiKey}
            onApiKeyFocus={markApiKeyTouched}
            onGatewayChange={(surfaceId, providerType) => {
              setRoute({
                routeKind: "gateway",
                providerType,
                surfaceId,
              });
            }}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            {t(($) => {
              return $.settings.shared.cancel;
            })}
          </Button>
          <Button
            onClick={(event) => {
              handleSubmit(event.metaKey || event.ctrlKey);
            }}
            disabled={submitDisabled}
          >
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function resolveModelPolicySectionData(params: {
  policiesLoadable: Loadable<OrgModelPoliciesResponse>;
  lastPolicies: OrgModelPoliciesResponse | undefined;
  providersLoadable: Loadable<ModelProviderResponse[]>;
  lastProviders: ModelProviderResponse[] | undefined;
  connectionsLoadable: Loadable<ModelProviderConnectionResponse[]>;
  lastConnections: ModelProviderConnectionResponse[] | undefined;
  modelCapabilitiesLoadable: Loadable<ModelPlanCapabilities>;
  lastModelCapabilities: ModelPlanCapabilities | undefined;
}) {
  const data =
    params.policiesLoadable.state === "hasData"
      ? params.policiesLoadable.data
      : params.lastPolicies;
  const providers =
    params.providersLoadable.state === "hasData"
      ? params.providersLoadable.data
      : (params.lastProviders ?? []);
  const providersReady =
    params.providersLoadable.state === "hasData" ||
    params.lastProviders !== undefined;
  const connections =
    params.connectionsLoadable.state === "hasData"
      ? params.connectionsLoadable.data
      : (params.lastConnections ?? []);
  const connectionsReady =
    params.connectionsLoadable.state === "hasData" ||
    params.lastConnections !== undefined;
  const modelCapabilities =
    params.modelCapabilitiesLoadable.state === "hasData"
      ? params.modelCapabilitiesLoadable.data
      : (params.lastModelCapabilities ?? DEFAULT_MODEL_PLAN_CAPABILITIES);
  const modelCapabilitiesReady =
    params.modelCapabilitiesLoadable.state === "hasData" ||
    params.lastModelCapabilities !== undefined;
  const showSkeleton =
    (!data && params.policiesLoadable.state === "loading") ||
    (!providersReady && params.providersLoadable.state === "loading") ||
    (!connectionsReady && params.connectionsLoadable.state === "loading") ||
    (!modelCapabilitiesReady &&
      params.modelCapabilitiesLoadable.state === "loading");
  return {
    data,
    providers,
    connections,
    modelCapabilities,
    showSkeleton,
  };
}

export function OrgModelPoliciesSection() {
  const { t } = useTranslation();
  const policiesLoadable = useLoadable(orgModelPolicies$);
  const lastPolicies = useLastResolved(orgModelPolicies$);
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const lastProviders = useLastResolved(orgConfiguredProviders$);
  const connectionsLoadable = useLoadable(modelProviderConnections$);
  const lastConnections = useLastResolved(modelProviderConnections$);
  const modelCapabilitiesLoadable = useLoadable(modelPlanCapabilities$);
  const lastModelCapabilities = useLastResolved(modelPlanCapabilities$);
  const pageSignal = useGet(pageSignal$);
  const openAddModelDialog = useSet(openAddModelPolicyDialog$);
  const openEditModelDialog = useSet(openEditModelPolicyDialog$);
  const openSettingsBillingPlans = useSet(openSettingsBillingPlans$);
  const reloadPersonalModelProvider = useSet(reloadPersonalModelProvider$);
  const [updateLoadable, updatePolicies] = useLoadableSet(
    updateOrgModelPolicies$,
  );
  const saving = updateLoadable.state === "loading";

  const { data, providers, connections, modelCapabilities, showSkeleton } =
    resolveModelPolicySectionData({
      policiesLoadable,
      lastPolicies,
      providersLoadable,
      lastProviders,
      connectionsLoadable,
      lastConnections,
      modelCapabilitiesLoadable,
      lastModelCapabilities,
    });

  if (showSkeleton) {
    return <ModelPoliciesSkeleton />;
  }

  if (!data) {
    return null;
  }

  const policies = data.policies;
  const visiblePolicies = policies.filter((policy) => {
    return ACTIVE_RUN_MODELS.includes(policy.model);
  });
  const configuredModels = new Set(
    policies.map((policy) => {
      return policy.model;
    }),
  );
  const addableModels = ACTIVE_RUN_MODELS.filter((model) => {
    return isAddableBuiltInModel(model) && !configuredModels.has(model);
  });

  const submit = (next: UpdateOrgModelPolicy[]) => {
    detach(
      (async () => {
        await updatePolicies(
          { policies: filterPolicyUpdatesForPlan(next, modelCapabilities) },
          pageSignal,
        );
        pageSignal.throwIfAborted();
        reloadPersonalModelProvider();
      })(),
      Reason.DomCallback,
    );
  };
  const openComparePlans = () => {
    openSettingsBillingPlans();
  };
  const handleDefaultModelChange = (model: SupportedRunModel) => {
    if (saving || model === data.workspaceDefaultModel) {
      return;
    }
    submit(makePolicyDefault(policies, model));
  };
  const handleOpenAddModel = () => {
    if (saving) {
      return;
    }
    const initialModel =
      addableModels.find((model) => {
        return modelAllowedForPlan(model, modelCapabilities);
      }) ??
      addableModels[0] ??
      null;
    openAddModelDialog(initialModel);
  };
  const handleEditPolicy = (policy: OrgModelPolicy) => {
    if (saving) {
      return;
    }
    openEditModelDialog(policy);
  };
  const handleDeletePolicy = (policy: OrgModelPolicy) => {
    if (saving || policies.length <= 1) {
      return;
    }
    submit(removePolicy(policies, policy.model));
  };

  return (
    <section className="flex flex-col gap-6">
      <DefaultModelRow
        policies={visiblePolicies}
        workspaceDefaultModel={data.workspaceDefaultModel}
        disabled={saving}
        modelCapabilities={modelCapabilities}
        onChange={handleDefaultModelChange}
        onUpgrade={openComparePlans}
      />
      <div className="flex flex-col gap-3">
        <SettingsSectionHeading
          title={t(($) => {
            return $.settings.models.policies.availableModels;
          })}
          description={t(($) => {
            return $.settings.models.policies.workspaceDescription;
          })}
          action={
            <AddModelButton
              hasModels={addableModels.length > 0}
              disabled={saving}
              onClick={handleOpenAddModel}
            />
          }
        />
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={{
            border: "var(--border-width-surface) solid hsl(var(--gray-400))",
          }}
        >
          <div className="hidden grid-cols-[minmax(0,1fr)_236px_96px_36px] gap-3 border-b border-border/50 px-5 py-3 text-xs font-medium text-muted-foreground lg:grid">
            <span>
              {t(($) => {
                return $.settings.models.policies.model;
              })}
            </span>
            <span>
              {t(($) => {
                return $.settings.models.policies.runsThrough;
              })}
            </span>
            <span>
              {t(($) => {
                return $.settings.models.policies.pricing;
              })}
            </span>
            <span />
          </div>
          <div className="p-2">
            {visiblePolicies.map((policy) => {
              return (
                <PolicyRow
                  key={policy.id}
                  policy={policy}
                  providers={providers}
                  connections={connections}
                  disabled={false}
                  canDelete={policies.length > 1}
                  onEdit={handleEditPolicy}
                  onDelete={handleDeletePolicy}
                />
              );
            })}
          </div>
        </div>
      </div>
      <ModelPolicyRouteDialog
        policies={policies}
        addableModels={addableModels}
        providers={providers}
        connections={connections}
        saving={saving}
        modelCapabilities={modelCapabilities}
        onUpgrade={openComparePlans}
        onSubmit={submit}
      />
    </section>
  );
}

function ModelPoliciesSkeleton() {
  return (
    <section className="flex flex-col gap-3">
      <div className="h-5 w-24 rounded bg-muted/50 animate-pulse" />
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        {[0, 1, 2].map((item) => {
          return (
            <div key={item} className="flex h-16 items-center gap-3 px-4">
              <div className="h-5 w-9 rounded-full bg-muted/50 animate-pulse" />
              <div className="h-4 w-40 rounded bg-muted/50 animate-pulse" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

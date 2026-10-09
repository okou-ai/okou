import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ChatThreadServiceTier,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { formatReplacementSubscriptionRequiredMessage } from "@okouai/api-contracts/contracts/errors";
import {
  AUTO_SELECTED_MODEL,
  isAutoSelectedModel,
} from "@okouai/core/auto-run-model";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import { db$ } from "../external/db";
import { memberModelRouteContextFromAccounts } from "./effective-model-route.service";
import type { ExecutionMemberMetadata } from "./execution-member-metadata.service";
import {
  memberSubscriptionModelRoutesFromCatalog,
  type MemberSubscriptionModelRoute,
} from "./member-subscription-models.service";
import type {
  MemberModelBootstrap,
  OrgModelBootstrap,
} from "./model-bootstrap.service";
import {
  catalogDisplayName,
  loadModelCatalog$,
  resolveCatalogModel,
  resolveCatalogRunModel,
  type ModelCatalog,
} from "./model-catalog.service";
import {
  catalogModelForSelectedId,
  isCatalogFastServiceTierSupported,
} from "./model-route-capabilities.service";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export interface ModelSelectionBootstrap {
  readonly org: OrgModelBootstrap;
  readonly member: MemberModelBootstrap;
  readonly memberMetadata: ExecutionMemberMetadata;
}
export function modelProviderWriteTypeForLaunch(
  type: string,
): ModelProviderType {
  return modelProviderTypeSchema.parse(type);
}
export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string;
}
export interface DefaultModelFirstPin extends ModelFirstPin {
  readonly serviceTier: ChatThreadServiceTier | null;
}
/** New thread, member, input and Run selections use the canonical Auto ID. */
export function autoSelectionPin(): ModelFirstPin {
  return {
    modelProviderId: null,
    modelProviderType: "built-in",
    modelProviderCredentialScope: "org",
    selectedModel: AUTO_SELECTED_MODEL,
  };
}
function subscriptionPin(entry: MemberSubscriptionModelRoute): ModelFirstPin {
  return {
    modelProviderId: entry.providerId,
    modelProviderType: entry.providerType,
    modelProviderCredentialScope: "member",
    selectedModel: entry.model,
  };
}
function unavailablePersonalPin(
  catalog: ModelCatalog,
  selectedModel: string | null,
): ModelFirstPin | null {
  const requestedModel = selectedModel
    ? catalogModelForSelectedId(catalog, selectedModel)
    : null;
  const resolution = requestedModel
    ? resolveCatalogModel(catalog, requestedModel)
    : null;
  const canonicalModel =
    resolution && resolution.kind !== "unknown"
      ? resolution.resolvedModel
      : null;
  const route = catalog.routes.find((candidate) => {
    return (
      candidate.model === canonicalModel &&
      candidate.providerType === candidate.subscriptionType &&
      candidate.concreteProviderType === candidate.subscriptionType &&
      (candidate.subscriptionType === "codex-oauth-token" ||
        candidate.subscriptionType === "claude-code-oauth-token")
    );
  });
  return route
    ? {
        modelProviderId: null,
        modelProviderType: route.providerType,
        modelProviderCredentialScope: "member",
        selectedModel: route.model,
      }
    : null;
}
interface SelectionParams {
  readonly orgId: string;
  readonly userId: string;
  readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
  readonly catalog?: ModelCatalog;
  readonly modelBootstrap?: ModelSelectionBootstrap;
}
const modelRoutingFacts$ = command(
  async ({ get, set }, params: SelectionParams, signal?: AbortSignal) => {
    const captured = params.modelBootstrap;
    if (
      captured &&
      (captured.org.orgId !== params.orgId ||
        captured.member.orgId !== params.orgId ||
        captured.member.userId !== params.userId)
    ) {
      throw new Error("Model bootstrap identity mismatch");
    }
    const db = get(db$);
    const [catalog, accounts, preferences] = await Promise.all([
      captured?.org.catalog ?? params.catalog ?? set(loadModelCatalog$, signal),
      captured
        ? captured.member.accounts.map((account) => {
            return {
              ...account,
              providerId: account.modelProviderId,
            };
          })
        : db
            .select({
              type: modelProviderAccounts.type,
              providerId: modelProviderAccounts.modelProviderId,
              isActive: modelProviderAccounts.isActive,
              needsReconnect: modelProviderAccounts.needsReconnect,
            })
            .from(modelProviderAccounts)
            .where(
              and(
                eq(modelProviderAccounts.orgId, params.orgId),
                eq(modelProviderAccounts.userId, params.userId),
                isNull(modelProviderAccounts.disconnectedAt),
              ),
            ),
      captured
        ? captured.memberMetadata.preferences
          ? [captured.memberMetadata.preferences]
          : []
        : db
            .select({
              selectedModel: orgMembersMetadata.selectedModel,
              serviceTier: orgMembersMetadata.serviceTier,
            })
            .from(orgMembersMetadata)
            .where(
              and(
                eq(orgMembersMetadata.orgId, params.orgId),
                eq(orgMembersMetadata.userId, params.userId),
              ),
            )
            .limit(1),
    ]);
    signal?.throwIfAborted();
    const member = memberModelRouteContextFromAccounts(accounts);
    return {
      catalog,
      member,
      preference: preferences[0],
      subscriptions: memberSubscriptionModelRoutesFromCatalog(catalog, member),
    };
  },
);
/**
 * Resolve personal selections; Auto aliases are handled separately and the
 * legacy capture ID remains unavailable as a public selectable model.
 */
export function resolveRunSelectionModel(
  catalog: ModelCatalog,
  selectedId: string,
): string | null {
  if (isAutoSelectedModel(selectedId)) {
    return null;
  }
  const model = catalogModelForSelectedId(catalog, selectedId);
  return model === null || isAutoSelectedModel(model)
    ? null
    : resolveCatalogRunModel(catalog, model);
}
export function isReplacedModelSelection(
  catalog: ModelCatalog,
  model: string | null,
): boolean {
  return (
    model !== null && resolveCatalogModel(catalog, model).kind === "replaced"
  );
}
export const resolveDefaultModelFirstPin$ = command(
  async (
    { set },
    params: SelectionParams,
    signal?: AbortSignal,
  ): Promise<DefaultModelFirstPin> => {
    const facts = await set(modelRoutingFacts$, params, signal);
    const model = facts.preference?.selectedModel;
    const selectedModel = model
      ? resolveRunSelectionModel(facts.catalog, model)
      : null;
    const personal = facts.subscriptions.find((entry) => {
      return entry.model === selectedModel;
    });
    if (!personal) {
      return { ...autoSelectionPin(), serviceTier: null };
    }
    const tier = facts.preference?.serviceTier;
    const serviceTier =
      tier === "priority" && personal.serviceTier === "priority"
        ? "priority"
        : null;
    return { ...subscriptionPin(personal), serviceTier };
  },
);
export const resolveModelSelectionPin$ = command(
  async (
    { set },
    params: SelectionParams & {
      readonly purpose: "configure" | "capture";
      readonly modelSelection: {
        readonly modelProviderId: string;
        readonly selectedModel: string;
      };
    },
    signal: AbortSignal,
  ): Promise<ModelFirstPin | ReturnType<typeof badRequestMessage>> => {
    // New intents canonicalize; queued snapshots below retain their captured ID.
    if (
      params.modelSelection.selectedModel === AUTO_SELECTED_MODEL ||
      (params.purpose === "capture" &&
        isAutoSelectedModel(params.modelSelection.selectedModel))
    ) {
      return autoSelectionPin();
    }
    const facts = await set(modelRoutingFacts$, params, signal);
    const selectedModel = resolveRunSelectionModel(
      facts.catalog,
      params.modelSelection.selectedModel,
    );
    const personal = facts.subscriptions.find((entry) => {
      return entry.model === selectedModel;
    });
    if (personal) {
      if (
        params.modelSelection.modelProviderId !==
          MODEL_FIRST_SELECTION_PROVIDER_ID &&
        params.modelSelection.modelProviderId !== personal.providerId
      ) {
        return badRequestMessage(
          "Unknown personal subscription for this workspace member",
        );
      }
      return subscriptionPin(personal);
    }
    // Canonical personal metadata preserves ownership even when its route is disabled;
    // classification is not permission to execute that route, so the pick rejects it.
    const unavailable =
      params.purpose === "capture"
        ? unavailablePersonalPin(
            facts.catalog,
            params.modelSelection.selectedModel,
          )
        : null;
    return (
      unavailable ??
      badRequestMessage(
        "Select Auto or a model from your connected personal subscription",
      )
    );
  },
);
const SUBSCRIPTION_LABELS: Readonly<Record<string, "Codex" | "Claude">> = {
  "codex-oauth-token": "Codex",
  "claude-code-oauth-token": "Claude",
};
/**
 * A replaced selection whose runnable successor is offered only by a personal
 * subscription the member has not connected. A connected account, including one
 * that needs reconnecting, routes the successor and keeps its own errors.
 */
export function replacementSubscriptionRequired(
  catalog: ModelCatalog,
  selectedId: string,
  pin: ModelFirstPin,
): {
  readonly subscriptionType: string;
  readonly response: ReturnType<typeof badRequestMessage>;
} | null {
  const subscriptionType = pin.modelProviderType;
  const label = subscriptionType
    ? SUBSCRIPTION_LABELS[subscriptionType]
    : undefined;
  if (
    !subscriptionType ||
    label === undefined ||
    pin.modelProviderCredentialScope !== "member" ||
    pin.modelProviderId !== null ||
    pin.selectedModel === null ||
    !isReplacedModelSelection(catalog, selectedId) ||
    resolveCatalogRunModel(catalog, pin.selectedModel) === null
  ) {
    return null;
  }
  return {
    subscriptionType,
    response: badRequestMessage(
      formatReplacementSubscriptionRequiredMessage({
        replacedModelLabel: catalogDisplayName(catalog, selectedId),
        successorLabel: catalogDisplayName(catalog, pin.selectedModel),
        subscriptionLabel: label,
      }),
    ),
  };
}
export type ProviderModelSupport = "validate" | "trust-enqueued";
export function validateCodexServiceTier(params: {
  readonly catalog: ModelCatalog;
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: "fast" | null;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (params.codexServiceTier !== "fast") {
    return undefined;
  }
  return isCatalogFastServiceTierSupported(
    params.catalog,
    params.pin.selectedModel,
    params.pin.modelProviderType,
  )
    ? undefined
    : badRequestMessage("Fast mode is unavailable for this model route");
}
export function resolveQueuedModelSelectionPinFromSnapshot(params: {
  readonly catalog: ModelCatalog;
  readonly selectedModel: string;
  readonly subscriptionModels: readonly MemberSubscriptionModelRoute[];
  /**
   * The member's logical provider types. A provider is removed with its last
   * account row, so a type here means an account of it exists, including a
   * retained disconnected one, as at capture.
   */
  readonly memberProviderTypes: ReadonlySet<string>;
}): ModelFirstPin | ReturnType<typeof badRequestMessage> {
  // A captured decision is immutable metadata, not a new selection request.
  if (isAutoSelectedModel(params.selectedModel)) {
    return { ...autoSelectionPin(), selectedModel: params.selectedModel };
  }
  const selectedModel = resolveRunSelectionModel(
    params.catalog,
    params.selectedModel,
  );
  const personal = params.subscriptionModels.find((entry) => {
    return entry.model === selectedModel;
  });
  if (personal) {
    return subscriptionPin(personal);
  }
  // Queued inputs can lose route authority after capture. Preserve canonical
  // ownership across disabling and replacement; never settle them against Auto.
  const unavailable = unavailablePersonalPin(
    params.catalog,
    params.selectedModel,
  );
  if (!unavailable) {
    return badRequestMessage(
      "Select Auto or a model from your connected personal subscription",
    );
  }
  // A replaced input of a member without any account of the successor's
  // subscription names the subscription; a retained disconnected account
  // keeps the reconnect error, as at capture.
  const subscriptionRequired = replacementSubscriptionRequired(
    params.catalog,
    params.selectedModel,
    unavailable,
  );
  return subscriptionRequired &&
    !params.memberProviderTypes.has(subscriptionRequired.subscriptionType)
    ? subscriptionRequired.response
    : unavailable;
}

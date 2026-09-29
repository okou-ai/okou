import {
  getFrameworkForType,
  getBuiltInConcreteProviderType,
  isBuiltInModelProviderType,
  isSupportedRunModel,
  isModelSupportedByProvider,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import { writeDb$ } from "../external/db";
import { providerTypeForSurfaceProtocol } from "./effective-model-route.service";
import type {
  ExternalModelProviderPlanCapabilitiesSource,
  ModelFirstPin,
  ProviderModelSupport,
} from "./model-selection.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";
import {
  checkOrgCreditsForRunAdmission$,
  checkOrgPlanRunAdmission,
} from "./run-admission.service";

interface ProviderAdmissionInput {
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
  readonly externalPlanCapabilities: ExternalModelProviderPlanCapabilitiesSource;
  readonly providerModelSupport: ProviderModelSupport;
}

function providerFramework(
  provider: ReturnType<typeof modelProviderTypeSchema.parse> | null,
  selectedModel: string | null,
) {
  return provider
    ? getFrameworkForType(
        isBuiltInModelProviderType(provider) &&
          isSupportedRunModel(selectedModel)
          ? getBuiltInConcreteProviderType(selectedModel)
          : provider,
      )
    : null;
}

const loadProviderAdmissionSources$ = command(
  async ({ set }, params: ProviderAdmissionInput, signal?: AbortSignal) => {
    const db = set(writeDb$);
    let effectiveModelProvider =
      params.modelPin.modelProviderType || params.requestedModelProvider;
    if (!params.modelPin.modelProviderType && params.modelPin.modelProviderId) {
      const [provider] = await db
        .select({ type: modelProviders.type })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.id, params.modelPin.modelProviderId),
            eq(modelProviders.orgId, params.orgId),
            or(
              eq(modelProviders.userId, params.userId),
              eq(modelProviders.userId, "__org__"),
            ),
          ),
        )
        .limit(1);
      signal?.throwIfAborted();
      effectiveModelProvider = provider?.type ?? params.requestedModelProvider;
    }
    const selectedModel = params.modelPin.selectedModel;
    const parsed = modelProviderTypeSchema.safeParse(effectiveModelProvider);
    const knownProvider = parsed.success ? parsed.data : null;
    let supported =
      params.providerModelSupport === "trust-enqueued" ||
      !isSupportedRunModel(selectedModel) ||
      (knownProvider !== null &&
        isModelSupportedByProvider(selectedModel, knownProvider));
    if (!supported && params.modelPin.modelProviderId && selectedModel) {
      const [surface] = await db
        .select({
          protocol: modelProviderSurfaces.protocol,
          modelMappings: modelProviderSurfaces.modelMappings,
        })
        .from(modelProviderSurfaces)
        .innerJoin(
          modelProviderConnections,
          eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
        )
        .where(
          and(
            eq(modelProviderSurfaces.id, params.modelPin.modelProviderId),
            eq(modelProviderConnections.orgId, params.orgId),
          ),
        )
        .limit(1);
      signal?.throwIfAborted();
      const surfaceProvider = surface
        ? providerTypeForSurfaceProtocol(surface.protocol)
        : null;
      supported =
        surfaceProvider !== null &&
        surfaceProvider === effectiveModelProvider &&
        typeof surface?.modelMappings[selectedModel] === "string";
    }
    signal?.throwIfAborted();
    return {
      effectiveModelProvider,
      supported,
      cliAgentType: providerFramework(knownProvider, selectedModel),
    };
  },
);

/** Resolve current business sources and credit admission without passing a database. */
export const resolveModelFirstProviderAdmission$ = command(
  async ({ set }, params: ProviderAdmissionInput, signal?: AbortSignal) => {
    const { effectiveModelProvider, cliAgentType, supported } = await set(
      loadProviderAdmissionSources$,
      params,
      signal,
    );
    if (!supported) {
      return {
        effectiveModelProvider,
        cliAgentType,
        error: badRequestMessage(
          "The selected model is not supported by the current model provider",
        ),
      };
    }
    const selectedModel = params.modelPin.selectedModel;
    const error = isBuiltInModelProviderType(effectiveModelProvider)
      ? await set(
          checkOrgCreditsForRunAdmission$,
          {
            orgId: params.orgId,
            userId: params.userId,
            modelProviderType: effectiveModelProvider,
            selectedModel,
          },
          signal,
        )
      : checkOrgPlanRunAdmission({
          capabilities:
            params.externalPlanCapabilities.kind === "resolved"
              ? params.externalPlanCapabilities.capabilities
              : await set(loadOrgPlanCapabilities$, params.orgId, signal),
          modelProviderType: effectiveModelProvider,
          selectedModel,
        });
    signal?.throwIfAborted();
    return { effectiveModelProvider, cliAgentType, error };
  },
);

import { command, computed, type Computed } from "ccstate";
import {
  formatRunFailureForExternalSurface,
  formatPersonalSubscriptionUsageLimitForExternalSurface,
} from "@okouai/api-contracts/contracts/errors";
import {
  getFrameworkForType,
  normalizeRunModelId,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelProviderFramework } from "@okouai/api-contracts/contracts/model-provider-types";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import {
  catalogDisplayName,
  modelCatalog$,
  type ModelCatalog,
} from "./model-catalog.service";

interface RunErrorProviderContext {
  readonly status: string;
  readonly modelProviderType: ModelProviderType | null;
  readonly failureReason: RunFailureReasonToken | null;
  readonly framework: ModelProviderFramework | null;
  readonly selectedModel: string | null;
}

interface FormatRunErrorLikeWebMessageParams {
  readonly chatThreadId?: string | null;
  readonly runId: string;
  readonly failureReason?: RunFailureReasonToken;
  readonly framework?: ModelProviderFramework | null;
  readonly modelProviderType?: ModelProviderType | null;
  readonly selectedModel?: string | null;
}

function buildModelProvidersUrl(): string {
  const appUrl = env("APP_URL");
  return `${appUrl}/?settings=model`;
}

function formatLatestSessionProviderType(
  value: string | null,
): ModelProviderType | null {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function runErrorProviderContext(
  runId: string,
): Computed<Promise<RunErrorProviderContext | undefined>> {
  return computed(async (get): Promise<RunErrorProviderContext | undefined> => {
    const [run] = await get(db$)
      .select({
        status: agentRuns.status,
        modelProviderType: agentRuns.modelProvider,
        modelRuntimeProviderType: agentRuns.modelRuntimeProvider,
        failureReason: agentRuns.failureReason,
        selectedModel: agentRuns.selectedModel,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return undefined;
    }

    const modelProviderType = formatLatestSessionProviderType(
      run.modelProviderType,
    );
    const modelRuntimeProviderType = formatLatestSessionProviderType(
      run.modelRuntimeProviderType,
    );
    const frameworkProviderType = modelRuntimeProviderType ?? modelProviderType;

    return {
      status: run.status,
      modelProviderType,
      failureReason: run.failureReason,
      framework:
        frameworkProviderType === null
          ? null
          : getFrameworkForType(frameworkProviderType),
      selectedModel: run.selectedModel,
    };
  });
}

/**
 * User-facing name of a run's model: the catalog display name of the model
 * the run actually used. Retired catalog rows keep their own display name, so
 * history never shows a replacement's name. Models outside the catalog are
 * shown verbatim.
 */
async function resolveRunModelDisplayName(
  catalogSnapshot: ModelCatalog,
  selectedModel: string,
): Promise<string> {
  const catalog = await catalogSnapshot;
  return catalogDisplayName(catalog, normalizeRunModelId(selectedModel.trim()));
}

function formatRunErrorLikeWebMessage(
  params: FormatRunErrorLikeWebMessageParams,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const providerContext =
      params.modelProviderType !== undefined &&
      params.selectedModel !== undefined
        ? undefined
        : await get(runErrorProviderContext(params.runId));
    const modelProviderType =
      params.modelProviderType !== undefined
        ? params.modelProviderType
        : providerContext?.modelProviderType;
    const selectedModel =
      params.selectedModel !== undefined
        ? params.selectedModel
        : providerContext?.selectedModel;
    let selectedModelLabel: string | null = null;
    if (selectedModel?.trim()) {
      const catalog = await get(modelCatalog$);
      // Preserve the original eager receiver read before model formatting.
      get(db$);
      selectedModelLabel = await resolveRunModelDisplayName(
        catalog,
        selectedModel,
      );
    }
    return formatRunFailureForExternalSurface({
      failureReason: params.failureReason,
      framework: params.framework,
      selectedModelLabel,
      modelProviderType,
      claudeCodeCredentialRecovery: {
        modelProviderType,
        modelProvidersUrl: buildModelProvidersUrl(),
      },
    });
  });
}

export const formatRunErrorForRunOwner$ = command(
  async (
    { get },
    params: Omit<
      FormatRunErrorLikeWebMessageParams,
      "failureReason" | "framework" | "modelProviderType"
    > & { readonly externalSurface?: boolean },
    signal: AbortSignal,
  ): Promise<string> => {
    const providerContext = await get(runErrorProviderContext(params.runId));
    signal.throwIfAborted();
    if (providerContext?.status === "cancelled") {
      return "Run cancelled";
    }
    if (providerContext?.status === "timeout") {
      return "Run timed out";
    }

    const message = await get(
      formatRunErrorLikeWebMessage({
        ...params,
        failureReason: providerContext?.failureReason ?? undefined,
        framework: providerContext?.framework ?? null,
        modelProviderType: providerContext?.modelProviderType ?? null,
        selectedModel: providerContext?.selectedModel ?? null,
      }),
    );
    signal.throwIfAborted();
    if (!params.externalSurface) {
      return message;
    }
    return (
      formatPersonalSubscriptionUsageLimitForExternalSurface({
        failureReason: providerContext?.failureReason,
        modelProviderType: providerContext?.modelProviderType,
        modelProvidersUrl: buildModelProvidersUrl(),
      }) ?? message
    );
  },
);

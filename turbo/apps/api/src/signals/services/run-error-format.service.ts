import { command, computed, type Computed } from "ccstate";
import { formatRunErrorForExternalSurface } from "@okouai/api-contracts/contracts/errors";
import {
  getFrameworkForType,
  modelProviderCredentialScopeSchema,
  normalizeRunModelId,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ModelProviderFramework } from "@okouai/api-contracts/contracts/model-provider-types";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$, type ReadonlyDb } from "../external/db";
import {
  catalogDisplayName,
  modelCatalog$,
  type ModelCatalog,
} from "./model-catalog.service";

const INSUFFICIENT_CREDITS_MARKER = "insufficient_credits";
const PRO_REQUIRED_MARKER = "pro_required";

interface RunErrorProviderContext {
  readonly modelProviderType: ModelProviderType | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly failureReason: RunFailureReasonToken | null;
  readonly framework: ModelProviderFramework | null;
  readonly selectedModel: string | null;
}

interface FormatRunErrorLikeWebMessageParams {
  readonly chatThreadId?: string | null;
  readonly runId: string;
  readonly errorMessage: string;
  readonly failureReason?: RunFailureReasonToken;
  readonly framework?: ModelProviderFramework | null;
  readonly modelProviderType?: ModelProviderType | null;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope | null;
  readonly selectedModel?: string | null;
}

function buildModelProvidersUrl(): string {
  const appUrl = env("APP_URL");
  return `${appUrl}/?settings=model`;
}

function buildPersonalModelProvidersUrl(): string {
  const appUrl = env("APP_URL");
  return `${appUrl}/?settings=model`;
}

function buildClaudeCodeCredentialRecoveryUrl(params: {
  readonly modelProviderType: ModelProviderType | null | undefined;
  readonly modelProviderCredentialScope:
    | ModelProviderCredentialScope
    | null
    | undefined;
}): string {
  if (
    params.modelProviderType === "claude-code-oauth-token" &&
    params.modelProviderCredentialScope === "member"
  ) {
    return buildPersonalModelProvidersUrl();
  }
  return buildModelProvidersUrl();
}

function isProRequiredRunError(message: string): boolean {
  return message.toLowerCase().includes(PRO_REQUIRED_MARKER);
}

function isInsufficientCreditsRunError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "insufficient_credits" ||
    normalized.startsWith("insufficient_credits: insufficient credits.") ||
    normalized ===
      "insufficient credits. add credits or configure your own api key to continue." ||
    normalized ===
      "api error: 402 insufficient credits. add credits or configure your own api key to continue."
  );
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

function formatRunModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderCredentialScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function runErrorProviderContext(
  runId: string,
): Computed<Promise<RunErrorProviderContext | undefined>> {
  return computed(async (get): Promise<RunErrorProviderContext | undefined> => {
    const [run] = await get(db$)
      .select({
        modelProviderType: agentRuns.modelProvider,
        modelRuntimeProviderType: agentRuns.modelRuntimeProvider,
        modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
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
    const frameworkProviderType =
      modelRuntimeProviderType ??
      (modelProviderType === "built-in" ? null : modelProviderType);

    return {
      modelProviderType,
      modelProviderCredentialScope: formatRunModelProviderCredentialScope(
        run.modelProviderCredentialScope,
      ),
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
  db: ReadonlyDb,
  selectedModel: string,
): Promise<string> {
  const catalog = await catalogSnapshot;
  return catalogDisplayName(catalog, normalizeRunModelId(selectedModel.trim()));
}

function formatRunErrorLikeWebMessage(
  params: FormatRunErrorLikeWebMessageParams,
): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const errorMessage = params.errorMessage.trim() || "Run failed";
    if (params.failureReason === undefined) {
      if (isProRequiredRunError(errorMessage)) {
        return PRO_REQUIRED_MARKER;
      }
      if (isInsufficientCreditsRunError(errorMessage)) {
        return INSUFFICIENT_CREDITS_MARKER;
      }
    }

    const providerContext =
      params.modelProviderType !== undefined &&
      params.modelProviderCredentialScope !== undefined &&
      params.selectedModel !== undefined
        ? undefined
        : await get(runErrorProviderContext(params.runId));
    const modelProviderType =
      params.modelProviderType !== undefined
        ? params.modelProviderType
        : providerContext?.modelProviderType;
    const modelProviderCredentialScope =
      params.modelProviderCredentialScope !== undefined
        ? params.modelProviderCredentialScope
        : providerContext?.modelProviderCredentialScope;
    const selectedModel =
      params.selectedModel !== undefined
        ? params.selectedModel
        : providerContext?.selectedModel;
    const selectedModelLabel = selectedModel?.trim()
      ? await resolveRunModelDisplayName(
          await get(modelCatalog$),
          get(db$),
          selectedModel,
        )
      : null;
    return formatRunErrorForExternalSurface({
      code: "INTERNAL_SERVER_ERROR",
      message: errorMessage,
      failureReason: params.failureReason,
      framework: params.framework,
      selectedModelLabel,
      modelProviderType,
      claudeCodeCredentialRecovery: {
        modelProviderType,
        modelProvidersUrl: buildClaudeCodeCredentialRecoveryUrl({
          modelProviderType,
          modelProviderCredentialScope,
        }),
      },
    });
  });
}

export const formatRunErrorForRunOwner$ = command(
  async (
    { get },
    params: Omit<
      FormatRunErrorLikeWebMessageParams,
      | "failureReason"
      | "framework"
      | "modelProviderType"
      | "modelProviderCredentialScope"
    >,
    signal: AbortSignal,
  ): Promise<string> => {
    const providerContext = await get(runErrorProviderContext(params.runId));
    signal.throwIfAborted();

    return await get(
      formatRunErrorLikeWebMessage({
        ...params,
        failureReason: providerContext?.failureReason ?? undefined,
        framework: providerContext?.framework ?? null,
        modelProviderType: providerContext?.modelProviderType ?? null,
        modelProviderCredentialScope:
          providerContext?.modelProviderCredentialScope ?? null,
        selectedModel: providerContext?.selectedModel ?? null,
      }),
    );
  },
);

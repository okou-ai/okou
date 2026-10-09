import { getModelProviderPiEndpoint } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import {
  isPiAgentModelSupported,
  type PiAgentModelConfig,
} from "@okouai/pi-agent-runtime";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_STAGE1_PERSONAL_MODEL,
  type PiMemoryStage1Model,
} from "@okouai/pi-agent-runtime/api";
import { eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { command } from "ccstate";
import { resolveCurrentPersonalSubscriptionBundleForApi$ } from "./agent-webhook-firewall-auth.service";
import { resolvePiMemoryBuiltinRoute$ } from "./pi-memory-builtin-config";
import {
  selectPiMemoryCurrentCredential$,
  type PiMemoryCurrentCredential,
} from "./pi-memory-current-credential.service";
import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import {
  catalogBuiltInRoute,
  catalogRoutesFor,
  type ModelCatalog,
  ModelCatalogInvariantError,
} from "./model-catalog.service";
import type { PiMemoryQuotaSource } from "./pi-memory-quota.service";

import {
  readPersonalSubscriptionAccount$,
  readPersonalSubscriptionCredentialBundle$,
} from "./model-provider-account.service";

export type PiMemoryStage1CredentialSkip =
  | "source_missing"
  | "source_owner_mismatch"
  | "credential_unavailable"
  | "provider_model_unsupported";

export class PiMemoryStage1CredentialError extends Error {
  constructor(readonly errorClass: PiMemoryStage1CredentialSkip) {
    super("Pi memory Stage 1 credential unavailable");
    this.name = "PiMemoryStage1CredentialError";
  }
}

export class PiMemoryStage1CredentialRefreshError extends Error {
  readonly errorClass = "credential_refresh_failed";
  constructor() {
    super("Pi memory Stage 1 credential refresh failed");
    this.name = "PiMemoryStage1CredentialRefreshError";
  }
}

export interface PiMemoryStage1Billing {
  readonly mode: "builtin" | "subscription";
  readonly orgId: string;
  readonly userId: string;
}

interface SourceIdentity {
  readonly sourceRunId: string;
  readonly orgId: string;
  readonly userId: string;
}

export type PiMemoryStage1CredentialResult =
  | { readonly status: "skip"; readonly reason: PiMemoryStage1CredentialSkip }
  | {
      readonly status: "available";
      readonly model: PiAgentModelConfig;
      /** The binding's extraction model: admission, usage and cost share it. */
      readonly selectedModel: PiMemoryStage1Model;
      readonly billing: PiMemoryStage1Billing;
      readonly modelProviderType: string;
      /**
       * Long-context threshold of the catalog route pricing this extraction
       * (null: single tier), captured with the credential like a foreground
       * run's `modelUsageLongContextMinTotalInputTokens`.
       */
      readonly longContextMinTotalInputTokens: number | null;
      readonly quota: PiMemoryQuotaSource;
      /** Exact captured values, revalidated without refresh or default selection. */
      readonly proof: PiMemoryStage1CredentialProof;
    };

const readSourceBinding$ = command(async ({ get }, source: SourceIdentity) => {
  const [binding] = await get(db$)
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, source.sourceRunId))
    .limit(1);
  return binding;
});

const readBuiltinKey$ = command(async ({ get }, modelKeyId: string) => {
  const [key] = await get(db$)
    .select({ apiKey: builtInModelKeys.apiKey })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, modelKeyId))
    .limit(1);
  return key?.apiKey;
});

/** Finite row read and decoding before the existing caller cancellation gate. */
const readStage1FeatureContext$ = command(
  async ({ get }, source: SourceIdentity) => {
    const featureSwitchContextRows0 = await get(db$)
      .select({
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(userFeatureSwitchRowCondition(source.orgId, source.userId));
    return featureSwitchContextFromRows(
      source.orgId,
      source.userId,
      featureSwitchContextRows0,
    );
  },
);

interface PiMemoryStage1CredentialProof {
  readonly source: SourceIdentity;
  readonly binding: NonNullable<
    Awaited<ReturnType<typeof readSourceBinding$.write>>
  >;
  readonly credential:
    | {
        readonly kind: "builtin";
        readonly modelKeyId: string;
        readonly apiKey: string;
      }
    | {
        readonly kind: "codex";
        readonly id: string;
        readonly token: string;
        readonly accountId: string;
        readonly context: ReturnType<typeof featureSwitchContextFromRows>;
      };
}

interface ResolutionContext {
  readonly source: SourceIdentity;
  readonly binding: NonNullable<
    Awaited<ReturnType<typeof readSourceBinding$.write>>
  >;
  readonly selected: PiMemoryCurrentCredential;
  readonly context: Awaited<ReturnType<typeof featureSwitchContextFromRows>>;
  readonly catalog: ModelCatalog;
}

function skip(
  reason: PiMemoryStage1CredentialSkip,
): PiMemoryStage1CredentialResult {
  return { status: "skip", reason };
}

/** The binding decides both the extraction model and who pays for it. */
interface Stage1Selection {
  readonly selectedModel: PiMemoryStage1Model;
  readonly mode: PiMemoryStage1Billing["mode"];
  readonly longContextMinTotalInputTokens: number | null;
}

/**
 * The long-context threshold of the highest-priority Built-in route of
 * `model` priced under the model's own ID, the `usage_pricing` provider
 * extraction usage is recorded and valued under (null: single tier).
 */
export function piMemoryStage1ModelPricingThreshold(
  catalog: ModelCatalog,
  model: PiMemoryStage1Model,
): number | null {
  const route = catalogRoutesFor(catalog, model, "built-in").find(
    (candidate) => {
      return candidate.pricingProvider === model;
    },
  );
  return route?.longContextMinTotalInputTokens ?? null;
}

/**
 * Personal subscription extraction is not billed; its cost observation values usage with the
 * `usage_pricing` rows of the model's own ID and so follows that rule's
 * threshold.
 */
function subscriptionStage1Selection(catalog: ModelCatalog): Stage1Selection {
  return {
    selectedModel: PI_MEMORY_STAGE1_PERSONAL_MODEL,
    mode: "subscription",
    longContextMinTotalInputTokens: piMemoryStage1ModelPricingThreshold(
      catalog,
      PI_MEMORY_STAGE1_PERSONAL_MODEL,
    ),
  };
}

function availableCredential(
  args: ResolutionContext,
  model: PiAgentModelConfig,
  selection: Stage1Selection,
  credential: PiMemoryStage1CredentialProof["credential"],
  quota: PiMemoryQuotaSource,
): PiMemoryStage1CredentialResult {
  const { source, binding } = args;
  if (!isPiAgentModelSupported(model)) {
    return skip("provider_model_unsupported");
  }
  return {
    status: "available",
    model,
    selectedModel: selection.selectedModel,
    modelProviderType: args.selected.type,
    longContextMinTotalInputTokens: selection.longContextMinTotalInputTokens,
    quota,
    billing: {
      mode: selection.mode,
      orgId: source.orgId,
      userId: source.userId,
    },
    proof: { source, binding, credential },
  };
}

const builtinCredential$ = command(
  async (
    { set },
    args: ResolutionContext,
    signal: AbortSignal,
  ): Promise<PiMemoryStage1CredentialResult> => {
    // Maintenance has a fixed internal binding, independent of chat admission.
    // Pricing still uses the held snapshot of the actual served route.
    const route = await set(resolvePiMemoryBuiltinRoute$, signal);
    signal.throwIfAborted();
    if (route?.providerType !== "openrouter-codex") {
      return skip("provider_model_unsupported");
    }
    const dialect = "openai-completions";
    const endpoint = getModelProviderPiEndpoint(route.providerType, dialect);
    if (!endpoint) {
      return skip("provider_model_unsupported");
    }
    // The served route's own pricing trigger. The route was resolved from this
    // snapshot, so a miss is a broken invariant: fail closed rather than bill
    // every token at the base (single-tier) categories.
    const servedRoute = catalogBuiltInRoute(
      args.catalog,
      PI_MEMORY_STAGE1_BUILT_IN_MODEL,
      route.providerType,
    );
    if (!servedRoute) {
      throw new ModelCatalogInvariantError(
        "Pi memory Stage 1 pricing threshold is missing",
      );
    }
    const apiKey = await set(readBuiltinKey$, route.modelKeyId);
    signal.throwIfAborted();
    if (!apiKey?.trim()) {
      return skip("credential_unavailable");
    }
    return availableCredential(
      args,
      {
        provider: "openrouter",
        apiKey,
        model: route.upstreamModel,
        baseUrl: endpoint.baseUrl,
        dialect,
        transport: "sse",
      },
      {
        selectedModel: PI_MEMORY_STAGE1_BUILT_IN_MODEL,
        mode: "builtin",
        longContextMinTotalInputTokens:
          servedRoute.longContextMinTotalInputTokens,
      },
      { kind: "builtin", modelKeyId: route.modelKeyId, apiKey },
      { providerClass: "builtin" },
    );
  },
);

const codexCredential$ = command(
  async (
    { set },
    args: ResolutionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<PiMemoryStage1CredentialResult> => {
    const { source, context } = args;
    const accountArgs = { id, orgId: source.orgId, userId: source.userId };
    const account = await set(readPersonalSubscriptionAccount$, accountArgs);
    signal.throwIfAborted();
    if (!account || account.type !== "codex-oauth-token") {
      return skip("credential_unavailable");
    }
    const lookup = {
      orgId: source.orgId,
      userId: source.userId,
      providerKey: "codex-oauth-token",
      metadata: {
        sourceType: "model-provider" as const,
        sourceId: id,
        sourceUserId: source.userId,
        metadataKey: "codex-oauth-token",
      },
      featureSwitchContext: context,
    };
    // No foreground runId: disconnected accounts retained for live runs are unavailable here.
    const refreshed = await set(
      resolveCurrentPersonalSubscriptionBundleForApi$,
      { ...lookup, key: "CHATGPT_ACCESS_TOKEN" },
      signal,
    );
    if (refreshed.status !== "available") {
      if (
        refreshed.reconnectState &&
        !refreshed.reconnectState.needsReconnect
      ) {
        throw new PiMemoryStage1CredentialRefreshError();
      }
      return skip("credential_unavailable");
    }
    // The canonical bundle reads the access token and account ID together after refresh.
    const token = refreshed.values.get("CHATGPT_ACCESS_TOKEN");
    const accountId = refreshed.values.get("CHATGPT_ACCOUNT_ID");
    signal.throwIfAborted();
    if (
      !token?.trim() ||
      !accountId?.trim() ||
      account.externalAccountId !== accountId
    ) {
      return skip("credential_unavailable");
    }
    const endpoint = getModelProviderPiEndpoint(
      "codex-oauth-token",
      "openai-codex-responses",
    );
    if (!endpoint) {
      return skip("provider_model_unsupported");
    }
    return availableCredential(
      args,
      {
        provider: "openai-codex",
        baseUrl: endpoint.baseUrl,
        model: PI_MEMORY_STAGE1_PERSONAL_MODEL,
        apiKey: token,
        accountId,
        dialect: "openai-codex-responses",
        transport: "sse",
      },
      subscriptionStage1Selection(args.catalog),
      { kind: "codex", id, token, accountId, context },
      { providerClass: "codex", accessToken: token, accountId },
    );
  },
);

/** Source ownership is authority; current owner credentials choose the route. */
export const resolvePiMemoryStage1Credential$ = command(
  async (
    { set },
    catalogSnapshot: ModelCatalog,
    source: SourceIdentity,
    signal: AbortSignal,
  ): Promise<PiMemoryStage1CredentialResult> => {
    const binding = await set(readSourceBinding$, source);
    signal.throwIfAborted();
    if (!binding) {
      return skip("source_missing");
    }
    if (binding.orgId !== source.orgId || binding.userId !== source.userId) {
      return skip("source_owner_mismatch");
    }
    const context = await set(readStage1FeatureContext$, source);
    signal.throwIfAborted();
    const catalog = catalogSnapshot;
    signal.throwIfAborted();
    const selected = await set(selectPiMemoryCurrentCredential$, source);
    signal.throwIfAborted();
    const args = {
      source,
      binding,
      selected,
      context,
      catalog,
    };
    if (selected.type === "built-in") {
      return await set(builtinCredential$, args, signal);
    }
    if (!selected.id) {
      return skip("credential_unavailable");
    }
    return await set(codexCredential$, args, selected.id, signal);
  },
);

/** Re-read exact captured bindings and credentials; never refresh or select defaults. */
export const validatePiMemoryStage1Credential$ = command(
  async (
    { set },
    proof: PiMemoryStage1CredentialProof,
    signal: AbortSignal,
  ): Promise<void> => {
    const current = await set(readSourceBinding$, proof.source);
    signal.throwIfAborted();
    if (!current) {
      throw new PiMemoryStage1CredentialError("source_missing");
    }
    if (JSON.stringify(current) !== JSON.stringify(proof.binding)) {
      throw new PiMemoryStage1CredentialError("source_owner_mismatch");
    }
    const credential = proof.credential;
    if (credential.kind === "builtin") {
      const key = await set(readBuiltinKey$, credential.modelKeyId);
      signal.throwIfAborted();
      if (key !== credential.apiKey) {
        throw new PiMemoryStage1CredentialError("credential_unavailable");
      }
      return;
    }
    const account = await set(readPersonalSubscriptionAccount$, {
      id: credential.id,
      orgId: proof.source.orgId,
      userId: proof.source.userId,
    });
    signal.throwIfAborted();
    if (
      !account ||
      account.type !== "codex-oauth-token" ||
      account.needsReconnect ||
      account.externalAccountId !== credential.accountId
    ) {
      throw new PiMemoryStage1CredentialError("credential_unavailable");
    }
    const bundle = await set(readPersonalSubscriptionCredentialBundle$, {
      orgId: proof.source.orgId,
      userId: proof.source.userId,
      type: "codex-oauth-token",
      sourceId: credential.id,
      featureSwitchContext: credential.context,
    });
    signal.throwIfAborted();
    if (
      bundle?.account.id !== credential.id ||
      bundle.account.needsReconnect ||
      bundle.values.get("CHATGPT_ACCESS_TOKEN") !== credential.token ||
      bundle.values.get("CHATGPT_ACCOUNT_ID") !== credential.accountId
    ) {
      throw new PiMemoryStage1CredentialError("credential_unavailable");
    }
  },
);

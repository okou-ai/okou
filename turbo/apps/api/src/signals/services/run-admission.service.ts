import {
  isBuiltInModelProviderType,
  RETIRED_RUN_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command } from "ccstate";
import { and, eq, gt, inArray, isNull, lte, sql, sum } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import {
  badRequestMessage,
  insufficientCredits,
  paidPlanRequired,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  loadOrgPlanCapabilities$,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { getSpendableUsagePackCredits } from "./usage-pack-credit.service";
import {
  isMemberSubscriptionRoute,
  memberModelRouteContextFromAccounts,
} from "./effective-model-route.service";
import { resolveUsageAllowanceAvailability$ } from "./usage-allowance-availability.service";
import {
  catalogModelForSelectedId,
  catalogRunModelRouteAccess,
} from "./model-route-capabilities.service";
import {
  catalogHasProviderRoute,
  isCatalogModelRunnable,
  type ModelCatalog,
} from "./model-catalog.service";

type RunAdmissionFailure =
  | ReturnType<typeof insufficientCredits>
  | ReturnType<typeof paidPlanRequired>
  | ReturnType<typeof badRequestMessage>;
type CreditDb = Pick<Db, "$with" | "select" | "with">;

export interface OrgCreditAvailability {
  readonly status: OrgPlanCapabilities["status"];
  readonly restrictedBuiltInModels: boolean;
  readonly spendableCredits: number;
  readonly usagePackCredits: number;
}
type OrgPlanRunAdmissionCapabilities = Pick<
  OrgPlanCapabilities,
  "status" | "restrictedBuiltInModels"
>;
export interface RunCreditAdmissionState {
  readonly orgId: string;
  readonly status: typeof agentRuns.$inferSelect.status;
  readonly creditAdmitted: boolean;
}

/** One captured admission phase, including its already-owned catalog snapshot. */
export interface RunAdmissionInput {
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly enforceBuiltInCredits: boolean;
}

function creditBalanceQuery(orgId: string, at: Date) {
  const builder = new QueryBuilder();
  const expired = builder.$with("expired").as(
    builder
      .select({
        total: sum(creditExpiresRecord.remaining)
          .mapWith(nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder))
          .as("total"),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, orgId),
          lte(creditExpiresRecord.expiresAt, at),
          gt(creditExpiresRecord.remaining, 0),
        ),
      ),
  );
  return builder
    .with(expired)
    .select({
      credits: sql`${orgMetadata.credits}`
        .mapWith(nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder))
        .as("credits"),
      unsettledExpired: expired.total,
    })
    .from(expired)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, orgId))
    .as("admission_credit_balance");
}

function memberCreditsQuery(orgId: string, userId: string, at: Date) {
  return new QueryBuilder()
    .select({
      total: sum(usagePackCreditGrants.remainingAmount)
        .mapWith(nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder))
        .as("total"),
    })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, orgId),
        eq(usagePackCreditGrants.userId, userId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    )
    .as("admission_member_credits");
}

function memberAccountsQuery(
  input: Pick<RunAdmissionInput, "orgId" | "userId">,
) {
  return new QueryBuilder()
    .select({
      type: modelProviderAccounts.type,
      providerId: modelProviderAccounts.modelProviderId,
      isActive: modelProviderAccounts.isActive,
      needsReconnect: modelProviderAccounts.needsReconnect,
    })
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.orgId, input.orgId),
        eq(modelProviderAccounts.userId, input.userId),
        inArray(modelProviderAccounts.type, [
          "claude-code-oauth-token",
          "codex-oauth-token",
        ]),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    )
    .as("admission_member_accounts");
}

function needsPersonalSubscription(input: RunAdmissionInput) {
  return (
    Boolean(input.selectedModel) &&
    (input.modelProviderType === "claude-code-oauth-token" ||
      input.modelProviderType === "codex-oauth-token")
  );
}

function personalSubscriptionFromAccounts(
  input: RunAdmissionInput,
  accounts: readonly {
    readonly type: string;
    readonly providerId: string;
    readonly isActive: boolean;
    readonly needsReconnect: boolean;
  }[],
) {
  return isMemberSubscriptionRoute({
    catalog: input.catalog,
    member: memberModelRouteContextFromAccounts(input.userId, accounts),
    model: input.selectedModel,
    providerType: input.modelProviderType,
    credentialScope: "member",
  });
}

function creditAvailability(
  capabilities: OrgPlanCapabilities | null,
  balance:
    | {
        readonly credits: number | null;
        readonly unsettledExpired: number | null;
      }
    | undefined,
  usagePackCredits: number,
): OrgCreditAvailability | null {
  return capabilities && balance?.credits !== null && balance !== undefined
    ? {
        status: capabilities.status,
        restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
        spendableCredits: balance.credits - (balance.unsettledExpired ?? 0),
        usagePackCredits,
      }
    : null;
}

function admissionBeforeAllowance(
  input: RunAdmissionInput,
  availability: OrgCreditAvailability | null,
  personalSubscription: boolean,
): RunAdmissionFailure | "allowance_required" | null {
  const routeFailure = checkCatalogRunRoute(input.catalog, input);
  if (routeFailure) {
    return routeFailure;
  }
  const planFailure = checkOrgPlanRunAdmission({
    ...input,
    capabilities: availability,
    personalSubscription,
  });
  if (planFailure) {
    return planFailure;
  }
  return !isBuiltInModelProviderType(input.modelProviderType) ||
    (availability &&
      (availability.usagePackCredits > 0 || availability.spendableCredits > 0))
    ? null
    : "allowance_required";
}

/** Runtime input is a plain captured snapshot; this command owns all reads. */
export const checkRunAdmission$ = command(
  async (
    { set },
    input: RunAdmissionInput,
    signal: AbortSignal,
  ): Promise<RunAdmissionFailure | null> => {
    const db = set(writeDb$);
    const at = nowDate();
    const capabilities = await set(
      loadOrgPlanCapabilities$,
      input.orgId,
      signal,
    );
    let personalSubscription = false;
    if (needsPersonalSubscription(input)) {
      const accounts = await db.select().from(memberAccountsQuery(input));
      signal.throwIfAborted();
      personalSubscription = personalSubscriptionFromAccounts(input, accounts);
    }
    if (!input.enforceBuiltInCredits) {
      return (
        checkOrgPlanRunAdmission({
          ...input,
          capabilities,
          personalSubscription,
        }) ?? null
      );
    }
    const [[balance], [memberCredits]] = await Promise.all([
      db.select().from(creditBalanceQuery(input.orgId, at)),
      db.select().from(memberCreditsQuery(input.orgId, input.userId, at)),
    ]);
    signal.throwIfAborted();
    const admission = admissionBeforeAllowance(
      input,
      creditAvailability(capabilities, balance, memberCredits?.total ?? 0),
      personalSubscription,
    );
    if (admission !== "allowance_required") {
      return admission;
    }
    const available = await set(
      resolveUsageAllowanceAvailability$,
      input.orgId,
      signal,
    );
    return available && available.remainingUnits > 0
      ? null
      : insufficientCredits();
  },
);

export const checkOrgCreditsForRunAdmission$ = command(
  async (
    { set },
    input: Omit<
      RunAdmissionInput,
      "enforceBuiltInCredits" | "selectedModel"
    > & { readonly selectedModel?: string | null },
    signal: AbortSignal,
  ): Promise<RunAdmissionFailure | undefined> => {
    const failure = await set(
      checkRunAdmission$,
      {
        ...input,
        selectedModel: input.selectedModel,
        enforceBuiltInCredits: true,
      },
      signal,
    );
    return failure ?? undefined;
  },
);

export function isFreePlanForCreditAdmission(
  planKey: string | null | undefined,
): boolean {
  return planKey === "limited-free-1";
}

export function runHasActiveCreditAdmission(
  run: Pick<RunCreditAdmissionState, "status" | "creditAdmitted">,
): boolean {
  return (
    run.creditAdmitted && (run.status === "pending" || run.status === "running")
  );
}

export async function loadRunCreditAdmissionState(params: {
  readonly db: Db;
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<RunCreditAdmissionState | undefined> {
  const [run] = await params.db
    .select({
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      creditAdmitted: agentRuns.creditAdmitted,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, params.runId),
        eq(agentRuns.orgId, params.orgId),
        eq(agentRuns.userId, params.userId),
      ),
    )
    .limit(1);
  return run;
}

export async function resolveActiveRunCreditAdmission(params: {
  readonly db: Db;
  readonly runId: string | undefined;
  readonly orgId: string;
  readonly userId: string;
}): Promise<boolean> {
  if (!params.runId) {
    return false;
  }
  const run = await loadRunCreditAdmissionState({
    ...params,
    runId: params.runId,
  });
  return run !== undefined && runHasActiveCreditAdmission(run);
}

export async function resolveOrgCreditAvailability(params: {
  readonly db: CreditDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<OrgCreditAvailability | null> {
  const at = nowDate();
  const expired = params.db.$with("expired").as(
    params.db
      .select({
        total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("total"),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, params.orgId),
          lte(creditExpiresRecord.expiresAt, at),
          gt(creditExpiresRecord.remaining, sql`0`),
        ),
      ),
  );
  const rows = await params.db
    .with(expired)
    .select({
      credits: sql`${orgMetadata.credits}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
      ),
      unsettledExpired: expired.total,
    })
    .from(expired)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, params.orgId));

  const row = rows[0];
  if (!row || row.credits === null) {
    return null;
  }

  const credits = row.credits;
  const spendableCredits = credits - row.unsettledExpired;
  const capabilities = await loadOrgPlanCapabilities(params.db, params.orgId);
  if (!capabilities) {
    return null;
  }
  const usagePackCredits = await getSpendableUsagePackCredits(params.db, {
    orgId: params.orgId,
    userId: params.userId,
    at,
  });
  return {
    status: capabilities.status,
    restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
    spendableCredits,
    usagePackCredits,
  };
}

/**
 * Runtime guard from the run's catalog snapshot: the selected model must be
 * an active catalog model with an enabled route, and a Built-in run needs an
 * enabled Built-in route. Retired or unknown IDs are resolved (or rejected)
 * before admission; this only stops an unresolved ID from reaching a runner.
 */
export function checkCatalogRunRoute(
  catalog: ModelCatalog,
  params: {
    readonly modelProviderType: string | null | undefined;
    readonly selectedModel?: string | null;
  },
): RunAdmissionFailure | undefined {
  if (!params.selectedModel) {
    return undefined;
  }
  // Normalized through the catalog like the plan check: a catalog model ID,
  // or a route upstream ID that names exactly one catalog model.
  const model = catalogModelForSelectedId(catalog, params.selectedModel);
  const builtIn = isBuiltInModelProviderType(params.modelProviderType);
  if (model !== null) {
    if (!isCatalogModelRunnable(catalog, model)) {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }
    return builtIn && !catalogHasProviderRoute(catalog, model, "built-in")
      ? badRequestMessage(RETIRED_RUN_MODEL_MESSAGE)
      : undefined;
  }
  // Built-in only runs catalog models.
  if (builtIn) {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  // A provider-native ID is an upstream model of catalog routes. It is
  // retired only when every catalog model it is an upstream of is retired;
  // an ID the catalog does not know stays the provider's own model.
  const upstreamOf = catalog.routes.filter((route) => {
    return route.upstreamModel === params.selectedModel;
  });
  return upstreamOf.length > 0 &&
    !upstreamOf.some((route) => {
      return route.enabled && isCatalogModelRunnable(catalog, route.model);
    })
    ? badRequestMessage(RETIRED_RUN_MODEL_MESSAGE)
    : undefined;
}

/**
 * The denial for a catalog model a free (restricted) plan cannot run on the
 * requested route. It names the catalog's free Built-in models and the one
 * other way in: the member's own connected subscription.
 */
export function restrictedPlanModelRequired(
  catalog: ModelCatalog,
  displayName: string,
): ReturnType<typeof paidPlanRequired> {
  const freeModels = catalog.models
    .filter((model) => {
      return model.builtInOnRestrictedPlans && model.replacedBy === null;
    })
    .map((model) => {
      return model.displayName;
    });
  const choose =
    freeModels.length > 0 ? `choose ${freeModels.join(" or ")} or ` : "";
  return paidPlanRequired(
    displayName,
    `On the free plan, ${choose}connect your own Claude Code or Codex subscription.`,
  );
}

export function checkOrgPlanRunAdmission(params: {
  /** The run's catalog snapshot, loaded once by the caller. */
  readonly catalog: ModelCatalog;
  readonly capabilities: OrgPlanRunAdmissionCapabilities | null;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  /**
   * The run uses the member's own connected, valid subscription on the
   * model's catalog subscription route (Auto or Custom), verified by the
   * caller through `isMemberSubscriptionRoute`. It is the only route a free
   * plan may use besides its free Built-in models.
   */
  readonly personalSubscription?: boolean;
}): RunAdmissionFailure | undefined {
  const { capabilities } = params;
  const modelAccess = catalogRunModelRouteAccess(
    params.catalog,
    params.selectedModel,
    params.modelProviderType,
    capabilities?.restrictedBuiltInModels && !params.personalSubscription,
  );
  const routeFailure = checkCatalogRunRoute(params.catalog, params);
  if (routeFailure) {
    return routeFailure;
  }
  if (!capabilities || capabilities.status !== "active") {
    return insufficientCredits();
  }
  // A catalog model a free plan cannot run on this route asks for a paid
  // plan by name and points at the free alternatives.
  const restrictedModel =
    modelAccess === "pro_required" && params.selectedModel
      ? params.catalog.byModel.get(
          catalogModelForSelectedId(params.catalog, params.selectedModel) ?? "",
        )
      : undefined;
  if (restrictedModel) {
    return restrictedPlanModelRequired(
      params.catalog,
      restrictedModel.displayName,
    );
  }
  return modelAccess === "pro_required" ? insufficientCredits() : undefined;
}

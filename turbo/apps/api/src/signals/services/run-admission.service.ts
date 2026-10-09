import {
  isBuiltInModelProviderType,
  RETIRED_RUN_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, gt, lte, sql, sum } from "drizzle-orm";
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
import type { Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { getSpendableUsagePackCredits } from "./usage-pack-credit.service";
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
 * Every run model, Built-in or personal subscription, is a catalog model.
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
  if (model === null || !isCatalogModelRunnable(catalog, model)) {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  return isBuiltInModelProviderType(params.modelProviderType) &&
    !catalogHasProviderRoute(catalog, model, "built-in")
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
   * model's catalog subscription route, verified by the
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

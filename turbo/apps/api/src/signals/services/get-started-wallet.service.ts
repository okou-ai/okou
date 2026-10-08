import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { slackRewardWalletEntitlement } from "./slack-installation-reward";

/** Bootstrap the wallet and its initial authorization projection in one statement.
 * Existing wallets retain their own entitlement, including an intentional absence.
 */
export const ensureGetStartedRewardWallet$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const wallet = db
      .insert(orgMetadataCanonicalWrites)
      .values({ orgId })
      .onConflictDoNothing()
      .returning({ orgId: orgMetadataCanonicalWrites.orgId })
      .getSQL();
    const values = slackRewardWalletEntitlement(orgId);
    await db.execute(sql`WITH wallet AS (${wallet})
      INSERT INTO ${orgPlanEntitlements} (
        org_id, plan_key, plan_rank, source, status, base_concurrency_limit,
        can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
        restricted_built_in_models,
        workflow_webhook_trigger_allowed, audio_lifetime_limit, audio_daily_rate_limit,
        audio_daily_duration_seconds, source_metadata, updated_at
      ) SELECT org_id, ${values.planKey}, ${values.planRank}, ${values.source}, ${values.status},
        ${values.baseConcurrencyLimit}, ${values.canBuyConcurrency}, ${values.canBuyCredits},
        ${values.showUsagePack}, ${values.autoRechargeAllowed},
        ${values.restrictedBuiltInModels},
        ${values.workflowWebhookTriggerAllowed}, ${values.audioLifetimeLimit},
        ${values.audioDailyRateLimit}, ${values.audioDailyDurationSeconds},
        ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)},
        ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}
      FROM wallet ON CONFLICT (org_id) DO NOTHING`);
    signal.throwIfAborted();
  },
);

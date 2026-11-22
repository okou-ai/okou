import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { writeDb$ } from "../external/db";
import { logOnboardingCreditsAlreadyGranted } from "./onboarding-credit-grants.service";
import {
  orgLimitedFreeBootstrapPublicationRow,
  orgLimitedFreeBootstrapPublicationSql,
} from "./org-limited-free-bootstrap-publication";

interface EnsureOrgLimitedFreeBootstrapArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const cachedAt = nowDate();
    const membership = writeDb
      .insert(orgMembersCache)
      .values({
        orgId: args.orgId,
        userId: args.ownerUserId,
        role: "admin",
        cachedAt,
      })
      .onConflictDoNothing()
      .getSQL();
    await writeDb.execute(sql`WITH membership AS (${membership})
      INSERT INTO ${orgMembersMetadata} (
        org_id, user_id, selected_model, created_at, updated_at
      ) VALUES (${args.orgId}, ${args.ownerUserId}, ${AUTO_SELECTED_MODEL},
        ${sql.param(cachedAt, orgMembersMetadata.createdAt)},
        ${sql.param(cachedAt, orgMembersMetadata.updatedAt)})
      ON CONFLICT DO NOTHING`);
    signal.throwIfAborted();

    const [publication] = parseRawRows(
      orgLimitedFreeBootstrapPublicationRow,
      await writeDb.execute(orgLimitedFreeBootstrapPublicationSql(args)),
    );
    signal.throwIfAborted();
    if (!publication) {
      throw new Error("Workspace initialization returned no outcome");
    }
    if (publication.receiptAlreadyGranted) {
      logOnboardingCreditsAlreadyGranted(args.orgId);
    }
  },
);

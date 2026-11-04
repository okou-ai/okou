import { publishContentBundle$ } from "./content-bundle.service";
import { SEED_INSTRUCTIONS } from "@okouai/core/seed-instructions";
import { randomUUID } from "node:crypto";
import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { db$, writeDb$ } from "../external/db";
import { defaultAgentJoinCondition } from "./agent-data.service";
import { logOnboardingCreditsAlreadyGranted } from "./onboarding-credit-grants.service";
import {
  orgLimitedFreeBootstrapPublicationRow,
  orgLimitedFreeBootstrapPublicationSql,
} from "./org-limited-free-bootstrap-publication";

const L = logger("org-limited-free-bootstrap.service");

interface EnsureOrgLimitedFreeBootstrapArgs {
  readonly orgId: string;
  readonly ownerUserId: string;
}

type BootstrapReservation =
  | {
      readonly status: "skipped";
      readonly agentId: string;
    }
  | {
      readonly status: "reserved";
      readonly agentId: string;
    };

interface EnsureOrgLimitedFreeBootstrapResult {
  readonly bootstrapped: boolean;
  readonly agentId: string | null;
}

const reserveBootstrapAgent$ = command(
  async (
    { get, set },
    args: EnsureOrgLimitedFreeBootstrapArgs & { readonly agentId: string },
    signal: AbortSignal,
  ): Promise<BootstrapReservation> => {
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
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: { role: "admin", cachedAt },
      })
      .returning({
        orgId: orgMembersCache.orgId,
        userId: orgMembersCache.userId,
      })
      .getSQL();
    // Both inserted and updated membership identities prepare preferences.
    // Keep the partial target list so omitted fields retain database defaults.
    await writeDb.execute(sql`WITH membership AS (${membership})
      INSERT INTO ${orgMembersMetadata} (
        org_id, user_id, selected_model, created_at, updated_at
      ) SELECT membership.org_id, membership.user_id, ${AUTO_SELECTED_MODEL},
        ${sql.param(cachedAt, orgMembersMetadata.createdAt)},
        ${sql.param(cachedAt, orgMembersMetadata.updatedAt)} FROM membership
      ON CONFLICT DO NOTHING`);
    signal.throwIfAborted();

    // Preparation stays committed if a later ordinary lookup fails.
    const db = get(db$);
    const [orgRow] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (orgRow?.defaultAgentId) {
      const [existing] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          defaultAgentReferenceCondition(args.orgId, orgRow.defaultAgentId),
        )
        .limit(1);
      signal.throwIfAborted();
      if (existing) {
        return { status: "skipped", agentId: existing.id };
      }
      throw new Error("The workspace default Agent reference is invalid");
    }

    return { status: "reserved", agentId: args.agentId };
  },
);

function defaultAgentReferenceCondition(orgId: string, agentId: string) {
  return and(eq(agents.orgId, orgId), eq(agents.id, agentId));
}

function completedBootstrapResult(
  args: EnsureOrgLimitedFreeBootstrapArgs,
  result: EnsureOrgLimitedFreeBootstrapResult,
) {
  if (result.bootstrapped) {
    L.debug("Org limited-free bootstrap completed", {
      orgId: args.orgId,
      agentId: result.agentId,
    });
  }
  return result;
}

export const ensureOrgLimitedFreeBootstrap$ = command(
  async (
    { set },
    args: EnsureOrgLimitedFreeBootstrapArgs,
    signal: AbortSignal,
  ): Promise<EnsureOrgLimitedFreeBootstrapResult> => {
    const writeDb = set(writeDb$);
    const reservation = await set(
      reserveBootstrapAgent$,
      { ...args, agentId: randomUUID() },
      signal,
    );
    signal.throwIfAborted();

    if (reservation.status === "skipped") {
      return { bootstrapped: false, agentId: reservation.agentId };
    }

    const instructionsBundle = await set(
      publishContentBundle$,
      [
        {
          path: "instructions.md",
          content: Buffer.from(SEED_INSTRUCTIONS, "utf8"),
        },
      ],
      signal,
    );
    const [publication] = parseRawRows(
      orgLimitedFreeBootstrapPublicationRow,
      await writeDb.execute(
        orgLimitedFreeBootstrapPublicationSql({
          ...args,
          agentId: reservation.agentId,
          instructionsBundle,
        }),
      ),
    );
    signal.throwIfAborted();
    if (!publication) {
      throw new Error("Bootstrap publication did not return its outcome");
    }
    let result: EnsureOrgLimitedFreeBootstrapResult;
    if (publication.agentId !== null) {
      if (publication.receiptAlreadyGranted) {
        logOnboardingCreditsAlreadyGranted(args.orgId);
      }
      result = { bootstrapped: true, agentId: publication.agentId };
    } else {
      // A losing insertion wrote no bootstrap state. Preserve the original
      // fresh published-default read after its unique-key wait, without
      // adopting an unbound same-name Agent or adding another publication.
      const [published] = await writeDb
        .select({ id: agents.id })
        .from(orgMetadata)
        .innerJoin(agents, defaultAgentJoinCondition())
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1);
      signal.throwIfAborted();
      if (!published) {
        throw new Error("Cannot bootstrap Okou over an unbound existing Agent");
      }
      result = { bootstrapped: false, agentId: published.id };
    }
    signal.throwIfAborted();
    return completedBootstrapResult(args, result);
  },
);

import { agentphoneConnectionCodes } from "@okouai/db/schema/agentphone-connection-code";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  getTableColumns,
  gt,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  normalizeAgentPhoneHandle,
  type AgentPhoneChannel,
  type AgentPhoneUserLink,
} from "./agentphone-shared.service";
import { completedGetStartedQuestPublication } from "./get-started-member-reward";
import { slackRewardWalletEntitlement } from "./slack-installation-reward";

type LinkResult =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "conflict";
      readonly reason: "phone-handle-linked" | "org-linked" | "conflict";
    }
  | { readonly kind: "linked"; readonly userLink: AgentPhoneUserLink };
type LinkSource =
  | { readonly kind: "direct"; readonly orgId: string; readonly userId: string }
  | { readonly kind: "code"; readonly codeHash: string };

/** Replace only the binding the user confirmed; a failed switch keeps it intact. */
export const switchAgentPhoneIdentity$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly phoneHandle: string;
      readonly replacePhoneHandle: string;
    },
    signal: AbortSignal,
  ): Promise<LinkResult | { readonly kind: "stale" }> => {
    const db = set(writeDb$);
    const previous = db.$with("previous_phone_link").as(
      db
        .delete(agentphoneUserLinks)
        .where(
          and(
            eq(agentphoneUserLinks.orgId, args.orgId),
            eq(agentphoneUserLinks.userId, args.userId),
            eq(agentphoneUserLinks.phoneHandle, args.replacePhoneHandle),
          ),
        )
        .returning({
          userId: agentphoneUserLinks.userId,
          orgId: agentphoneUserLinks.orgId,
        }),
    );
    // A fresh link also retires the old sender's routes and contact-card state.
    // Do not ignore an insert conflict: the entire statement must roll back so
    // a competing claim of the requested handle preserves the original link.
    const replacement = db.$with(
      "replacement_phone_link",
      getTableColumns(agentphoneUserLinks),
    ).as(sql`
      INSERT INTO ${agentphoneUserLinks} (phone_handle, user_id, org_id)
      SELECT ${sql.param(args.phoneHandle, agentphoneUserLinks.phoneHandle)},
        ${previous.userId}, ${previous.orgId} FROM ${previous}
      RETURNING *
    `);
    const result = await settle(
      db.with(previous, replacement).select().from(replacement),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (
        isUniqueViolation(
          result.error,
          "idx_agentphone_user_links_phone_handle",
        )
      ) {
        return { kind: "conflict", reason: "phone-handle-linked" };
      }
      throw result.error;
    }
    const [userLink] = result.value;
    if (userLink) {
      return { kind: "linked", userLink };
    }

    // A repeated request after an uncertain response may already have succeeded.
    const [existing] = await db
      .select()
      .from(agentphoneUserLinks)
      .where(
        and(
          eq(agentphoneUserLinks.orgId, args.orgId),
          eq(agentphoneUserLinks.userId, args.userId),
          eq(agentphoneUserLinks.phoneHandle, args.phoneHandle),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return existing
      ? { kind: "linked", userLink: existing }
      : { kind: "stale" };
  },
);

function existingLinkResult(
  rows: readonly AgentPhoneUserLink[],
  identity: { readonly orgId: string; readonly userId: string },
  phoneHandle: string,
): LinkResult | null {
  const phone = rows.find((row) => {
    return row.phoneHandle === phoneHandle;
  });
  if (phone) {
    return phone.orgId === identity.orgId && phone.userId === identity.userId
      ? { kind: "linked", userLink: phone }
      : { kind: "conflict", reason: "phone-handle-linked" };
  }
  const member = rows.find((row) => {
    return row.orgId === identity.orgId && row.userId === identity.userId;
  });
  return member ? { kind: "conflict", reason: "org-linked" } : null;
}

interface LinkIdentity {
  readonly orgId: string;
  readonly userId: string;
}

function phoneLinkResult(
  rows: readonly {
    readonly existing: AgentPhoneUserLink | null;
    readonly inserted: AgentPhoneUserLink | null;
  }[],
  identity: LinkIdentity,
  phoneHandle: string,
): LinkResult {
  const first = rows[0];
  if (!first) {
    return { kind: "invalid" };
  }
  const existing = existingLinkResult(
    rows.flatMap((row) => {
      return row.existing ? [row.existing] : [];
    }),
    identity,
    phoneHandle,
  );
  if (existing) {
    return existing;
  }
  return first.inserted
    ? { kind: "linked", userLink: first.inserted }
    : { kind: "conflict", reason: "conflict" };
}

function newLinkWalletEntitlementSql(identity: LinkIdentity) {
  const values = slackRewardWalletEntitlement(identity.orgId);
  const columns = Object.entries(getTableColumns(orgPlanEntitlements));
  const fields = Object.entries(values).map(([name, value]) => {
    const column = columns.find(([property]) => {
      return property === name;
    })?.[1];
    if (!column) {
      throw new Error(`Unknown AgentPhone wallet entitlement field: ${name}`);
    }
    return {
      column: sql.identifier(column.name),
      value: sql.param(value, column),
    };
  });
  // Drizzle's SELECT insert requires every column. Keep the original partial
  // list so omitted entitlement fields retain their real database defaults.
  return sql`INSERT INTO ${orgPlanEntitlements} (${sql.join(
    fields.map((field) => {
      return field.column;
    }),
    sql`, `,
  )})
    SELECT ${sql.join(
      fields.map((field) => {
        return field.value;
      }),
      sql`, `,
    )} FROM phone_link_wallet WHERE true
    ON CONFLICT (org_id) DO NOTHING RETURNING org_id`;
}

function phoneLinkPublicationPlan(
  identity: LinkIdentity,
  phoneHandle: string,
  at: Date,
  existingRead: SQL,
  consumption: SQL | undefined,
) {
  const builder = new QueryBuilder();
  const identityColumns = {
    orgId: agentphoneUserLinks.orgId,
    userId: agentphoneUserLinks.userId,
  };
  const consumed = consumption
    ? builder.$with("phone_link_code", identityColumns).as(consumption)
    : undefined;
  const admitted = builder.$with("phone_link_identity", identityColumns).as(sql`
    SELECT ${sql.param(identity.orgId, agentphoneUserLinks.orgId)}::text AS org_id,
      ${sql.param(identity.userId, agentphoneUserLinks.userId)}::text AS user_id
    WHERE ${consumed ? exists(builder.select({ orgId: consumed.orgId }).from(consumed)) : sql`true`}
  `);
  const wallet = builder.$with("phone_link_wallet", {
    orgId: orgMetadata.orgId,
  }).as(sql`INSERT INTO ${orgMetadataCanonicalWrites} (org_id)
      SELECT ${admitted.orgId} FROM ${admitted} WHERE true
      ON CONFLICT DO NOTHING RETURNING org_id`);
  const entitlement = builder
    .$with("phone_link_entitlement", { orgId: orgPlanEntitlements.orgId })
    .as(newLinkWalletEntitlementSql(identity));
  const columns = getTableColumns(agentphoneUserLinks);
  const existing = builder.$with("phone_link_existing", columns).as(sql`
    SELECT matching.* FROM (${existingRead}) AS matching
    WHERE ${exists(builder.select({ orgId: admitted.orgId }).from(admitted))}
  `);
  const inserted = builder.$with("phone_link_inserted", columns).as(sql`
    INSERT INTO ${agentphoneUserLinks} (phone_handle, user_id, org_id)
    SELECT ${sql.param(phoneHandle, agentphoneUserLinks.phoneHandle)},
      ${admitted.userId}, ${admitted.orgId} FROM ${admitted}
    WHERE ${notExists(builder.select({ id: existing.id }).from(existing))}
    ON CONFLICT DO NOTHING RETURNING *
  `);
  const publication = completedGetStartedQuestPublication(
    { ...identity, questKey: "imessage", sourceKey: "agentphone-link" },
    at,
    builder.select({ id: inserted.id }).from(inserted).getSQL(),
  );
  const claim = builder.$with("claim", {}).as(publication.claim);
  const reward = builder.$with("phone_link_reward", {}).as(publication.grant);
  return {
    ctes: [
      ...(consumed ? [consumed] : []),
      admitted,
      wallet,
      entitlement,
      existing,
      inserted,
      claim,
      reward,
    ],
    admitted,
    existing,
    inserted,
  };
}

/** Link, optional one-time code consumption, and its reward are one finite commit. */
export const linkAgentPhoneIdentity$ = command(
  async (
    { set },
    args: {
      readonly phoneHandle: string;
      readonly channel: AgentPhoneChannel;
      readonly source: LinkSource;
    },
    signal: AbortSignal,
  ): Promise<LinkResult> => {
    const db = set(writeDb$);
    const phoneHandle = normalizeAgentPhoneHandle(
      args.phoneHandle,
      args.channel,
    );
    const at = nowDate();
    let identity: LinkIdentity;
    let consumption: SQL | undefined;
    if (args.source.kind === "direct") {
      identity = args.source;
    } else {
      const candidates = await db
        .select({
          id: agentphoneConnectionCodes.id,
          orgId: agentphoneConnectionCodes.orgId,
          userId: agentphoneConnectionCodes.userId,
        })
        .from(agentphoneConnectionCodes)
        .where(
          and(
            eq(agentphoneConnectionCodes.codeHash, args.source.codeHash),
            isNull(agentphoneConnectionCodes.consumedAt),
            gt(agentphoneConnectionCodes.expiresAt, at),
          ),
        )
        .limit(2);
      signal.throwIfAborted();
      const candidate = candidates[0];
      if (candidates.length !== 1 || !candidate) {
        return { kind: "invalid" };
      }
      identity = candidate;
      consumption = db
        .update(agentphoneConnectionCodes)
        .set({
          consumedAt: at,
          consumedPhoneHandle: phoneHandle,
          updatedAt: at,
        })
        .where(
          and(
            eq(agentphoneConnectionCodes.id, candidate.id),
            eq(agentphoneConnectionCodes.orgId, identity.orgId),
            eq(agentphoneConnectionCodes.userId, identity.userId),
            eq(agentphoneConnectionCodes.codeHash, args.source.codeHash),
            isNull(agentphoneConnectionCodes.consumedAt),
            gt(agentphoneConnectionCodes.expiresAt, at),
            sql`(SELECT count(*) FROM (SELECT 1 FROM ${agentphoneConnectionCodes} AS active_code
          WHERE active_code.code_hash = ${args.source.codeHash}
            AND active_code.consumed_at IS NULL
            AND active_code.expires_at > ${sql.param(at, agentphoneConnectionCodes.expiresAt)}
          LIMIT 2) AS matching) = 1`,
          ),
        )
        .returning({
          orgId: agentphoneConnectionCodes.orgId,
          userId: agentphoneConnectionCodes.userId,
        })
        .getSQL();
    }
    const existingRead = db
      .select()
      .from(agentphoneUserLinks)
      .where(
        or(
          eq(agentphoneUserLinks.phoneHandle, phoneHandle),
          and(
            eq(agentphoneUserLinks.userId, identity.userId),
            eq(agentphoneUserLinks.orgId, identity.orgId),
          ),
        ),
      )
      .limit(2)
      .getSQL();
    const plan = phoneLinkPublicationPlan(
      identity,
      phoneHandle,
      at,
      existingRead,
      consumption,
    );
    const rows = await db
      .with(...plan.ctes)
      .select({
        existing: {
          id: plan.existing.id,
          phoneHandle: plan.existing.phoneHandle,
          userId: plan.existing.userId,
          orgId: plan.existing.orgId,
          createdAt: plan.existing.createdAt,
          updatedAt: plan.existing.updatedAt,
        },
        inserted: {
          id: plan.inserted.id,
          phoneHandle: plan.inserted.phoneHandle,
          userId: plan.inserted.userId,
          orgId: plan.inserted.orgId,
          createdAt: plan.inserted.createdAt,
          updatedAt: plan.inserted.updatedAt,
        },
      })
      .from(plan.admitted)
      .leftJoin(plan.existing, sql`true`)
      .leftJoin(plan.inserted, sql`true`);
    signal.throwIfAborted();
    return phoneLinkResult(rows, identity, phoneHandle);
  },
);

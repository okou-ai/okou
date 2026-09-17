import type {
  GetStartedClaimStatus,
  GetStartedQuestKey,
} from "@okouai/api-contracts/contracts/get-started";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Durable completion receipts; deleting a source entity never resets eligibility. */
export const getStartedClaims = pgTable(
  "get_started_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    beneficiaryUserId: text("beneficiary_user_id"),
    questKey: varchar("quest_key", { length: 20 })
      .$type<GetStartedQuestKey>()
      .notNull(),
    sourceKey: text("source_key").notNull(),
    rewardKey: text("reward_key"),
    rewardSlot: integer("reward_slot"),
    rewardTarget: varchar("reward_target", { length: 8 })
      .$type<"user" | "org">()
      .notNull(),
    rewardAmount: bigint("reward_amount", { mode: "number" }).notNull(),
    status: varchar("status", { length: 20 })
      .$type<GetStartedClaimStatus>()
      .default("pending")
      .notNull(),
    invitationId: text("invitation_id"),
    inviteeUserId: text("invitee_user_id"),
    sourceEventId: uuid("source_event_id"),
    runId: uuid("run_id"),
    workflowId: uuid("workflow_id"),
    postUrl: text("post_url"),
    evidenceText: text("evidence_text"),
    reason: text("reason"),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    memberCreditGrantId: uuid("member_credit_grant_id"),
    orgCreditRecordId: uuid("org_credit_record_id"),
    completedAt: timestamp("completed_at"),
    reviewedAt: timestamp("reviewed_at"),
    grantedAt: timestamp("granted_at"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_get_started_claim_source").on(
        table.actorUserId,
        table.questKey,
        table.sourceKey,
      ),
      uniqueIndex("uq_get_started_reward_key").on(table.rewardKey),
      uniqueIndex("uq_get_started_reward_slot").on(
        table.beneficiaryUserId,
        table.questKey,
        table.rewardSlot,
      ),
      uniqueIndex("uq_get_started_slack_org")
        .on(table.orgId)
        .where(
          sql`${table.questKey} = 'slack' AND ${table.status} = 'granted'`,
        ),
      uniqueIndex("uq_get_started_invitation").on(table.invitationId),
      index("idx_get_started_user").on(
        table.beneficiaryUserId,
        table.questKey,
        table.status,
      ),
      index("idx_get_started_org").on(
        table.orgId,
        table.questKey,
        table.status,
      ),
      index("idx_get_started_pending")
        .on(table.nextAttemptAt)
        .where(sql`${table.status} IN ('pending', 'reviewing')`),
      check(
        "get_started_quest_check",
        sql`${table.questKey} IN ('connector', 'slack', 'workflow', 'invite', 'share', 'checkin')`,
      ),
      check(
        "get_started_status_check",
        sql`${table.status} IN ('pending', 'reviewing', 'granted', 'rejected', 'ineligible')`,
      ),
      check(
        "get_started_target_check",
        sql`(${table.questKey} = 'slack' AND ${table.rewardTarget} = 'org' AND ${table.beneficiaryUserId} IS NULL) OR (${table.questKey} <> 'slack' AND ${table.rewardTarget} = 'user' AND ${table.beneficiaryUserId} IS NOT NULL)`,
      ),
      check(
        "get_started_grant_check",
        sql`(${table.status} = 'granted' AND ${table.rewardKey} IS NOT NULL AND ${table.grantedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.expiresAt} = ${table.grantedAt} + interval '168 hours' AND ((${table.rewardTarget} = 'user' AND ${table.memberCreditGrantId} IS NOT NULL AND ${table.orgCreditRecordId} IS NULL) OR (${table.rewardTarget} = 'org' AND ${table.orgCreditRecordId} IS NOT NULL AND ${table.memberCreditGrantId} IS NULL))) OR (${table.status} <> 'granted' AND ${table.rewardKey} IS NULL AND ${table.grantedAt} IS NULL AND ${table.expiresAt} IS NULL AND ${table.memberCreditGrantId} IS NULL AND ${table.orgCreditRecordId} IS NULL)`,
      ),
      check(
        "get_started_slot_check",
        sql`(${table.status} <> 'granted' AND ${table.rewardSlot} IS NULL) OR (${table.status} = 'granted' AND ((${table.questKey} = 'invite' AND ${table.rewardSlot} BETWEEN 1 AND 15 AND ${table.rewardSlot} IS NOT NULL) OR (${table.questKey} IN ('workflow', 'share') AND ${table.rewardSlot} = 1 AND ${table.rewardSlot} IS NOT NULL) OR (${table.questKey} IN ('connector', 'slack', 'checkin') AND ${table.rewardSlot} IS NULL)))`,
      ),
      check(
        "get_started_amount_check",
        sql`${table.rewardAmount} = CASE ${table.questKey} WHEN 'slack' THEN 2000 WHEN 'share' THEN 2000 WHEN 'workflow' THEN 1000 ELSE 100 END`,
      ),
    ];
  },
);

import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agent";
import { chatThreads } from "./chat-thread";
import { orgMembersMetadata } from "./org-members-metadata";

/**
 * Why a delivery exists, and which generation results it may consume.
 *
 * It mirrors the generation's own purpose, and delivery only ever reads a
 * result produced for the same one. A protected preview result can therefore
 * never be delivered by a later production occurrence that happens to share an
 * owner and an anchor.
 */
export const MORNING_BRIEF_DELIVERY_PURPOSES = [
  "preview",
  "production",
] as const;
export type MorningBriefDeliveryPurpose =
  (typeof MORNING_BRIEF_DELIVERY_PURPOSES)[number];

/**
 * What happened to this delivery's email channel.
 *
 * Every value is terminal for the delivery transaction. `enqueued` is a
 * handoff to the shared email outbox, which is a real consumer with its own
 * lifetime, retries and completion fence: it resolves that row to sent or
 * failed, or cleanup removes it. Nothing here waits for a queue that does not
 * exist, and this column is never used as the dedupe identity — the row itself
 * is.
 *
 * - `enqueued` — an outbox intent was created and handed to the shared drain.
 * - `unsubscribed` — the owner has opted out of optional email.
 * - `suppressed` — the resolved address is suppressed.
 * - `no_email` — no address could be resolved without refilling an erased cache.
 * - `render_rejected` — the accepted body cannot be carried by the template, so
 *   no shorter brief was mailed.
 */
export const MORNING_BRIEF_DELIVERY_EMAIL_RESOLUTIONS = [
  "enqueued",
  "unsubscribed",
  "suppressed",
  "no_email",
  "render_rejected",
] as const;
export type MorningBriefDeliveryEmailResolution =
  (typeof MORNING_BRIEF_DELIVERY_EMAIL_RESOLUTIONS)[number];

/**
 * The durable, content-free identity of one native Morning Brief delivery.
 *
 * Its logical identity is the collection occurrence that produced the brief,
 * exactly as the generation's is. Purpose, digest and the rendered artefacts it
 * points at are provenance for that single slot: no prompt, schema or renderer
 * revision can open a second delivery of the same occurrence.
 *
 * Durable ownership is inherited rather than re-invented. The composite key to
 * `org_members_metadata` is the same member row Morning Brief collection and
 * generation hang from, so membership, user and organization cleanup remove
 * these rows as well. The Agent and thread keys fence the two lifecycle
 * deletions that invalidate a destination.
 *
 * Its lifetime is deliberately **longer** than the work it describes:
 *
 * - No foreign key to `morning_brief_generations`. That row has a bounded
 *   preview retention and is swept; an expired result must never delete the
 *   identity that prevents a second delivery, and it can never be recreated to
 *   repeat one.
 * - No foreign key to `chat_events`. Hot canonical events are retained for 30
 *   days while this identity has to outlive them, and `delivered_at` keeps the
 *   unread watermark answerable after the event row is gone.
 * - No foreign key to `email_outbox`. Outbox rows live about fifteen minutes
 *   and are then cleaned up; that must resolve to "the intent is finished",
 *   never "this brief was never delivered".
 *
 * It stores no source body, prompt, rendered text or recipient address. The
 * digest identifies the delivered body without keeping a second copy of it.
 */
export const morningBriefDeliveries = pgTable(
  "morning_brief_deliveries",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    scheduledFor: timestamp("scheduled_for").notNull(),
    collectionKind: text("collection_kind").notNull(),
    collectionVersion: integer("collection_version").notNull(),

    /** Which purpose's result this delivery consumed. Never a key column. */
    executionPurpose: text("execution_purpose", {
      enum: MORNING_BRIEF_DELIVERY_PURPOSES,
    }).notNull(),
    /**
     * The accepted result reference this delivery consumed.
     *
     * The generation row itself is swept when its bounded retention elapses,
     * so this is the only durable mapping from the reference a caller still
     * holds to the delivery it already produced. It is an opaque identifier,
     * not content, and it is resolved only inside the owner's own scope.
     */
    resultAttemptId: uuid("result_attempt_id").notNull(),
    /** The membership generation this delivery was committed under. */
    membershipId: text("membership_id").notNull(),
    /** Native owner epoch presented at commit; null only for preview lineage. */
    nativeOwnerEpoch: integer("native_owner_epoch"),
    /**
     * The exact installation and schedule this delivery acted under.
     *
     * Agent identity alone is not the binding: reinstalling Morning Brief on
     * the same Agent produces a new workflow and automation, and the previous
     * installation's work must not be authorized by the new one.
     */
    workflowId: uuid("workflow_id").notNull(),
    automationId: uuid("automation_id").notNull(),
    /** The Agent that owned the destination thread at delivery. */
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agents.id;
        },
        { onDelete: "cascade" },
      ),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    /** The canonical run-less `output.message` this delivery committed. */
    chatEventId: uuid("chat_event_id").notNull(),
    /** SHA-256 of the delivered body. Identity only, never the body. */
    resultDigest: text("result_digest").notNull(),
    /** One of MORNING_BRIEF_DELIVERY_EMAIL_RESOLUTIONS. */
    emailResolution: text("email_resolution", {
      enum: MORNING_BRIEF_DELIVERY_EMAIL_RESOLUTIONS,
    }).notNull(),
    /** The handed-off outbox intent, while the shared drain still has one. */
    emailOutboxId: uuid("email_outbox_id"),
    /** Creation instant of the committed Chat event. */
    deliveredAt: timestamp("delivered_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_deliveries_pk",
        columns: [
          table.orgId,
          table.userId,
          table.scheduledFor,
          table.collectionKind,
          table.collectionVersion,
        ],
      }),
      foreignKey({
        name: "fk_morning_brief_deliveries_member",
        columns: [table.orgId, table.userId],
        foreignColumns: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      }).onDelete("cascade"),
      // Replay after the source result is swept resolves the delivery through
      // the reference the caller still holds, inside their own scope.
      uniqueIndex("morning_brief_deliveries_attempt_unique").on(
        table.orgId,
        table.userId,
        table.resultAttemptId,
      ),
      // The read watermark resolves a native delivery through this event.
      uniqueIndex("morning_brief_deliveries_chat_event_unique").on(
        table.chatEventId,
      ),
      // A native outbox row belongs to exactly one delivery, which is what the
      // shared drain validates before admitting a send. NULLs stay distinct.
      uniqueIndex("morning_brief_deliveries_outbox_unique").on(
        table.emailOutboxId,
      ),
      // The native read-watermark candidate: newest delivery for one thread.
      index("morning_brief_deliveries_thread_idx").on(
        table.chatThreadId,
        table.deliveredAt.desc(),
      ),
      // Owner-scoped revocation, and the Agent cascade's own lookup.
      index("morning_brief_deliveries_agent_idx").on(table.agentId),
    ];
  },
);

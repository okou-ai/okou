import { MORNING_BRIEF_OFFICIAL_DEFINITION_NAME } from "@okouai/api-contracts/contracts/morning-brief-preference";
import {
  chatThreads,
  type ChatThreadProvenance,
} from "@okouai/db/schema/chat-thread";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

/**
 * Whole-thread Morning Brief provenance.
 *
 * The brief must never summarise its own output, and a current workflow
 * binding cannot answer that question: uninstalling the Official Workflow
 * deletes the binding, and a thread title, a single ordinary-looking input, or
 * an unbroken sequence of event numbers proves nothing about the rest of the
 * thread's history. So the fact is recorded on the thread itself, by the code
 * paths that actually put official Morning Brief content there.
 *
 * Three rules hold everywhere in this module:
 *
 * 1. `ordinary` is only ever written by a successful new ordinary-Chat INSERT.
 *    Nothing here upgrades an existing row to `ordinary`.
 * 2. `morning_brief` is sticky. It may replace an unknown or ordinary value and
 *    is never cleared by a rename, an uninstall, later ordinary conversation, a
 *    replay, a feature-switch change, or workflow cleanup. It disappears only
 *    with its thread.
 * 3. Every write is scoped to the thread's own owner, so a replayed or
 *    misdirected request cannot stamp another member's row.
 */

/** The classification a successful new ordinary-Chat INSERT carries. */
export const ORDINARY_CHAT_THREAD_PROVENANCE =
  "ordinary" satisfies ChatThreadProvenance;

/** The sticky whole-thread exclusion this module owns. */
export const MORNING_BRIEF_CHAT_THREAD_PROVENANCE =
  "morning_brief" satisfies ChatThreadProvenance;

interface ChatThreadProvenanceOwner {
  readonly chatThreadId: string;
  readonly userId: string;
}

/**
 * Mark a thread as having hosted official Morning Brief content.
 *
 * This is the one exclusion write for the whole feature. Callers run it inside
 * the transaction that commits the Brief input, binding, or delivery, so the
 * exclusion and the content it describes either both land or neither does. S6
 * direct Morning Brief delivery must call exactly this operation from its own
 * canonical write transaction rather than introduce a second rule.
 *
 * `updated_at` is deliberately left alone: this is internal classification, not
 * user-visible activity, and the sidebar orders threads by that column.
 */
export async function excludeMorningBriefChatThread(
  tx: Tx,
  owner: ChatThreadProvenanceOwner,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ provenance: MORNING_BRIEF_CHAT_THREAD_PROVENANCE })
    .where(
      and(
        eq(chatThreads.id, owner.chatThreadId),
        eq(chatThreads.userId, owner.userId),
      ),
    );
}

/**
 * Drop a positive `ordinary` classification a caller can no longer stand
 * behind, leaving the thread explicitly unknown.
 *
 * Used when an official source reaches a thread but cannot be resolved
 * authoritatively. Guessing in either direction is unsafe, and leaving a stale
 * `ordinary` value would keep the thread eligible for collection. The predicate
 * makes the operation incapable of clearing a sticky exclusion.
 */
async function forgetOrdinaryChatThreadProvenance(
  tx: Tx,
  owner: ChatThreadProvenanceOwner,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({ provenance: null })
    .where(
      and(
        eq(chatThreads.id, owner.chatThreadId),
        eq(chatThreads.userId, owner.userId),
        eq(chatThreads.provenance, ORDINARY_CHAT_THREAD_PROVENANCE),
      ),
    );
}

type OfficialWorkflowSource =
  /** At least one source is the official Morning Brief installation. */
  | "morning-brief"
  /** Every source resolved, and none of them is Morning Brief. */
  | "other"
  /** A claimed source does not resolve in this organization. */
  | "unresolved";

/**
 * Classify workflow sources by the persisted `officialDefinitionName`.
 *
 * The definition name is the only authority here. A workflow title, display
 * name or slug is user-editable and an uninstall removes the row entirely, so
 * neither can decide whether official Brief content is arriving. Resolution is
 * organization-scoped: Morning Brief is installed per member, but content
 * produced by any member's installation still lands in the destination thread,
 * and that thread must be excluded either way.
 */
async function classifyOfficialWorkflowSources(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly workflowIds: readonly string[];
  },
): Promise<OfficialWorkflowSource> {
  if (args.workflowIds.length === 0) {
    return "unresolved";
  }
  const rows = await tx
    .select({
      id: workflows.id,
      officialDefinitionName: workflows.officialDefinitionName,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        inArray(workflows.id, [...new Set(args.workflowIds)]),
      ),
    );
  if (
    rows.some((row) => {
      return (
        row.officialDefinitionName === MORNING_BRIEF_OFFICIAL_DEFINITION_NAME
      );
    })
  ) {
    return "morning-brief";
  }
  return rows.length === new Set(args.workflowIds).size
    ? "other"
    : "unresolved";
}

/**
 * Record what an official workflow source means for the thread it enters.
 *
 * Morning Brief sources make the exclusion sticky. A source that cannot be
 * resolved leaves the thread unknown instead of eligible. Any other resolved
 * official or ordinary workflow changes nothing, because a workflow running in
 * a thread is not by itself a reason to hide that thread from the user's own
 * brief.
 */
export async function recordOfficialWorkflowThreadProvenance(
  tx: Tx,
  args: ChatThreadProvenanceOwner & {
    readonly orgId: string;
    readonly workflowIds: readonly string[];
  },
): Promise<void> {
  const source = await classifyOfficialWorkflowSources(tx, {
    orgId: args.orgId,
    workflowIds: args.workflowIds,
  });
  const owner = { chatThreadId: args.chatThreadId, userId: args.userId };
  if (source === "morning-brief") {
    await excludeMorningBriefChatThread(tx, owner);
    return;
  }
  if (source === "unresolved") {
    await forgetOrdinaryChatThreadProvenance(tx, owner);
  }
}

import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import {
  googleFormsAutomationCursors,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { sql, type SQL } from "drizzle-orm";
import type { workflowAutomations } from "@okouai/db/runtime/workflow-automation";

type FormsCursorSource = Pick<
  typeof workflowAutomations.$inferSelect,
  | "orgId"
  | "ownerUserId"
  | "workflowId"
  | "kind"
  | "eventType"
  | "eventConnectorId"
  | "eventConfig"
  | "enabled"
  | "officialBlueprintKey"
  | "officialIntendedEnabled"
>;

/** A source replacement or user stop starts a new delivery interval. */
export function googleFormsCursorMustReset(
  previous: FormsCursorSource,
  next: FormsCursorSource,
): boolean {
  const wasForms = previous.eventType === "google-forms-response-submitted";
  const isForms = next.eventType === "google-forms-response-submitted";
  if (!wasForms && !isForms) {
    return false;
  }
  if (
    !wasForms ||
    !isForms ||
    previous.orgId !== next.orgId ||
    previous.ownerUserId !== next.ownerUserId ||
    previous.workflowId !== next.workflowId ||
    previous.kind !== next.kind ||
    previous.eventConnectorId !== next.eventConnectorId ||
    (next.officialBlueprintKey === null
      ? !next.enabled
      : next.officialIntendedEnabled === false)
  ) {
    return true;
  }
  const previousConfig = googleFormsResponseSubmittedEventConfigSchema.parse(
    previous.eventConfig,
  );
  const nextConfig = googleFormsResponseSubmittedEventConfigSchema.parse(
    next.eventConfig,
  );
  return (
    previousConfig.connectorId !== nextConfig.connectorId ||
    previousConfig.form.id !== nextConfig.form.id
  );
}

/**
 * Publish a prepared source while its automation row is owned. Callers delete
 * incompatible/closed intervals first; an existing same-source cursor retains
 * delivery progress even when watch preparation sees newer responses.
 */
export function googleFormsCursorPublicationStatement(
  automation: FormsCursorSource & { readonly id: string },
  seedCursor: string | null,
  currentTime: Date,
  publication?: {
    readonly gate: SQL;
    readonly reset: boolean;
  },
) {
  if (
    !automation.enabled ||
    automation.eventType !== "google-forms-response-submitted"
  ) {
    return null;
  }
  if (seedCursor === null) {
    throw new Error(
      "Google Forms structure publication requires its prepared cursor",
    );
  }
  const config = googleFormsResponseSubmittedEventConfigSchema.parse(
    automation.eventConfig,
  );
  return sql`
    INSERT INTO ${googleFormsAutomationCursors}
      (automation_id, watch_state_id, last_seen_submitted_time, created_at, updated_at)
    SELECT ${automation.id}::uuid, ${googleFormsWatchStates.id}, ${seedCursor},
      ${currentTime.toISOString()}::timestamp, ${currentTime.toISOString()}::timestamp
    FROM ${googleFormsWatchStates}
    WHERE ${googleFormsWatchStates.orgId} = ${automation.orgId}
      AND ${googleFormsWatchStates.userId} = ${automation.ownerUserId}
      AND ${googleFormsWatchStates.connectorId} = ${config.connectorId}::uuid
      AND ${googleFormsWatchStates.formId} = ${config.form.id}
      ${publication ? sql`AND ${publication.gate}` : sql.empty()}
    ON CONFLICT (automation_id) DO UPDATE
      SET watch_state_id = excluded.watch_state_id,
        updated_at = excluded.updated_at
        ${publication?.reset ? sql`, last_seen_submitted_time = excluded.last_seen_submitted_time, created_at = excluded.created_at` : sql.empty()}
    RETURNING automation_id
  `;
}

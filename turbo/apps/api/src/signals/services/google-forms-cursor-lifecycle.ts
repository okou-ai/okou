import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import {
  googleFormsAutomationCursors,
  googleFormsWatchStates,
} from "@okouai/db/schema/google-forms-event";
import { sql } from "drizzle-orm";
import type { workflowAutomations } from "@okouai/db/schema/workflow";

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

/** Build publication SQL for a structure change while its automation row is owned. */
export function googleFormsCursorPublicationStatement(
  automation: FormsCursorSource & { readonly id: string },
  seedCursor: string | null,
  currentTime: Date,
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
    ON CONFLICT (automation_id) DO UPDATE
      SET watch_state_id = excluded.watch_state_id, updated_at = excluded.updated_at
    RETURNING automation_id
  `;
}

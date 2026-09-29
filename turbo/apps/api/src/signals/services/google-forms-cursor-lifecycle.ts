import { googleFormsResponseSubmittedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
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

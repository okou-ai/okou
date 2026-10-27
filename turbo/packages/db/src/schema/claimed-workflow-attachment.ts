import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/** Exact packages owned by a successful claim until Runner completion.
 * These references have no revision, lease, timeout or publication role.
 * RESTRICT keeps history deletion from erasing a surviving consumer's retain.
 */
export const claimedWorkflowAttachments = pgTable(
  "claimed_workflow_attachments",
  {
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "restrict" },
      ),
    orgId: text("org_id").notNull(),
    objectKey: text("object_key").notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.runId, table.objectKey] }),
      index("claimed_workflow_attachments_object_idx").on(
        table.orgId,
        table.objectKey,
      ),
    ];
  },
);

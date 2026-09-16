import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sharedThreads } from "./shared-thread";

/** One immutable resource snapshot per outbound integration reply. */
export const integrationArtifactDeliveries = pgTable(
  "integration_artifact_deliveries",
  {
    deliveryKey: text("delivery_key").primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .unique()
      .references(
        () => {
          return sharedThreads.id;
        },
        { onDelete: "cascade" },
      ),
    sourceContentHash: text("source_content_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

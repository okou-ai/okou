import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const artifactFavorites = pgTable(
  "artifact_favorites",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Favorites survive physical removal of the referenced artifact.
    artifactId: uuid("artifact_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId, table.artifactId] }),
      index("idx_artifact_favorites_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt.desc(),
        table.artifactId.desc(),
      ),
    ];
  },
);

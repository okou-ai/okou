import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { runUploadedFiles } from "./run-uploaded-file";

/** Named file viewers remain independent of the file's general audience. */
export const artifactFileShares = pgTable(
  "artifact_file_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fileId: uuid("file_id")
      .notNull()
      .references(
        () => {
          return runUploadedFiles.id;
        },
        { onDelete: "cascade" },
      ),
    email: text("email").notNull(),
    userId: text("user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("artifact_file_shares_file_email").on(table.fileId, table.email),
    ];
  },
);

import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectErasureJournal } from "./connection";

/** Explicit, separately authorized installation; never called by main migrations. */
export async function migrateErasureJournal(
  connectionString: string,
): Promise<void> {
  const connection = connectErasureJournal(connectionString);
  try {
    await migrate(drizzle(connection), {
      migrationsFolder: fileURLToPath(
        new URL("../../erasure-journal-migrations", import.meta.url),
      ),
      migrationsSchema: "erasure_journal_migrations",
    });
  } finally {
    await connection.end();
  }
}

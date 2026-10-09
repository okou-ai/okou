import {
  storagePublicationGenerations,
  storagePublicationTokens,
} from "@okouai/db/schema/storage-publication-fence";
import { asc, eq } from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";

/** Pure statements; the lifecycle owner preserves generation-before-token locks. */
export function agentPublicationFenceDeletionSql(agentId: string) {
  const condition = eq(storagePublicationGenerations.agentId, agentId);
  return [
    new QueryBuilder()
      .select({
        orgId: storagePublicationGenerations.orgId,
        agentId: storagePublicationGenerations.agentId,
        subject: storagePublicationGenerations.subject,
      })
      .from(storagePublicationGenerations)
      .where(condition)
      .orderBy(
        asc(storagePublicationGenerations.orgId),
        asc(storagePublicationGenerations.agentId),
        asc(storagePublicationGenerations.subject),
      )
      .for("update")
      .getSQL(),
    new PgDialect().buildDeleteQuery({
      table: storagePublicationGenerations,
      where: condition,
    }),
    new PgDialect().buildDeleteQuery({
      table: storagePublicationTokens,
      where: eq(storagePublicationTokens.agentId, agentId),
    }),
  ];
}

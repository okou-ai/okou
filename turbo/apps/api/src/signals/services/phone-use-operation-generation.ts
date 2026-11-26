import {
  phoneUseGrants as grants,
  phoneUseOperations as operations,
} from "@okouai/db/schema/phone-use";
import { and, eq, gt, isNull, lte, notExists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export function phoneOperationGenerationMatches(generation: number) {
  // Rows from older writers still depend on the live Chat grant.
  return sql`coalesce(${eq(operations.deviceGeneration, generation)}, true)`;
}

export function phoneOperationRegistrationEnded(generation: number) {
  const newerGrant = new QueryBuilder()
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.id, operations.grantId),
        gt(grants.deviceGeneration, generation),
      ),
    );
  return sql`case when ${isNull(operations.deviceGeneration)}
    then ${notExists(newerGrant)}
    else ${lte(operations.deviceGeneration, generation)}
    end`;
}

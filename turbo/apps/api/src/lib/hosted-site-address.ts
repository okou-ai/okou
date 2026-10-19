import { eq, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { hostedDeployments, hostedSites } from "@okouai/db/runtime/hosted-site";

/** Published names keep their original owner, including after a rename. */
export function hostedSiteAddressCondition(publicSlug: string) {
  const query = new QueryBuilder();
  return inArray(
    hostedSites.id,
    query
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .where(eq(hostedSites.publicSlug, publicSlug))
      .union(
        query
          .select({ id: hostedSites.id })
          .from(hostedSites)
          .where(eq(hostedSites.slug, publicSlug)),
      )
      .union(
        query
          .select({ id: hostedDeployments.siteId })
          .from(hostedDeployments)
          .where(
            eq(sql`${hostedDeployments.manifest}->>'publicSlug'`, publicSlug),
          ),
      ),
  );
}

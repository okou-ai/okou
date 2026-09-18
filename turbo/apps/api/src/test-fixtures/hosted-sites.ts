/**
 * Current APIs create only Okou sites. This fixture represents a historical
 * VM0 site whose slug must remain reserved after redeployment is retired.
 */
import { hostedSites } from "@okouai/db/schema/hosted-site";
import { createStore } from "ccstate";

import { writeDb$ } from "../signals/external/db";

export async function insertLegacyHostedSiteFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly site: string;
}): Promise<string> {
  const db = createStore().set(writeDb$);
  const [site] = await db
    .insert(hostedSites)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      slug: args.site,
      requestedSlug: args.site,
      publicSlug: args.site,
      publicBrand: "vm0",
    })
    .returning({ id: hostedSites.id });
  if (!site) {
    throw new Error("Expected a historical hosted site");
  }
  return site.id;
}

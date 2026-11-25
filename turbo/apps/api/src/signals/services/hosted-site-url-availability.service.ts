import { command } from "ccstate";
import { and, ne } from "drizzle-orm";
import {
  artifactDeliveryKey,
  artifactDeliveryRecordSchema,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import {
  hostedSitePointerNamespace,
  linkLayoutFromSegment,
} from "@okouai/api-contracts/contracts/link-layout";
import { hostedSites } from "@okouai/db/runtime/hosted-site";
import { db$ } from "../external/db";
import { env } from "../../lib/env";
import { hostedSiteAddressCondition } from "../../lib/hosted-site-address";
import { hostedSitePointerSchema } from "../../lib/hosted-site-pointer";
import { storedObject } from "./hosted-site-publication-migration.service";

type Site = typeof hostedSites.$inferSelect;
export const availableForSite$ = command(
  async ({ get }, site: Site, publicSlug: string, signal: AbortSignal) => {
    if (site.publicSlug === publicSlug) {
      return true;
    }
    const [occupied] = await get(db$)
      .select({ id: hostedSites.id })
      .from(hostedSites)
      .where(
        and(
          hostedSiteAddressCondition(publicSlug),
          ne(hostedSites.id, site.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (occupied) {
      return false;
    }
    const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      throw new Error("Hosted site storage is not configured");
    }
    const layout = linkLayoutFromSegment(site.linkLayoutSegment);
    const [record, pointer] = await Promise.all([
      get(
        storedObject(
          bucket,
          artifactDeliveryKey(site.linkLayoutSegment, "html", publicSlug),
          signal,
        ),
      ),
      get(
        storedObject(
          bucket,
          `${hostedSitePointerNamespace(layout)}/${publicSlug}/active.json`,
          signal,
        ),
      ),
    ]);
    signal.throwIfAborted();
    if (
      record &&
      artifactDeliveryRecordSchema.parse(
        JSON.parse(record.buffer.toString("utf8")),
      ).kind !== "legacy-site"
    ) {
      return false;
    }
    // Historical publication names remain owned by their original site.
    return pointer
      ? hostedSitePointerSchema.parse(
          JSON.parse(pointer.buffer.toString("utf8")),
        ).siteId === site.id
      : record === null;
  },
);

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, gt, lt } from "drizzle-orm";
import { orgMetadata } from "../../../src/schema/org-metadata";
import type { Snapshot } from "./model";

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("Missing DATABASE_URL");
  return value;
}

export function databaseIdentity() {
  const url = new URL(databaseUrl());
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

/** Brand-neutral columns need no rewrite. Capture their exact values read-only. */
export async function scanDatabase(
  cutoff: number,
  signal: AbortSignal,
): Promise<Snapshot[]> {
  const client = postgres(databaseUrl(), { max: 1 });
  try {
    return await drizzle(client).transaction(
      async (tx) => {
        const records: Snapshot[] = [];
        let cursor: string | undefined;
        for (;;) {
          signal.throwIfAborted();
          const rows = await tx
            .select({
              orgId: orgMetadata.orgId,
              sourceType: orgMetadata.acquisitionSourceType,
              firstPartySource: orgMetadata.acquisitionFirstPartySource,
              campaignId: orgMetadata.acquisitionCampaignId,
              adGroupId: orgMetadata.acquisitionAdGroupId,
              campaign: orgMetadata.acquisitionCampaign,
              utmSource: orgMetadata.acquisitionUtmSource,
              utmMedium: orgMetadata.acquisitionUtmMedium,
              utmContent: orgMetadata.acquisitionUtmContent,
              utmTerm: orgMetadata.acquisitionUtmTerm,
              gclid: orgMetadata.acquisitionGclid,
              gbraid: orgMetadata.acquisitionGbraid,
              wbraid: orgMetadata.acquisitionWbraid,
              gaClientId: orgMetadata.acquisitionGaClientId,
              landingHost: orgMetadata.acquisitionLandingHost,
              landingPath: orgMetadata.acquisitionLandingPath,
              referrerDomain: orgMetadata.acquisitionReferrerDomain,
              recordedAt: orgMetadata.acquisitionRecordedAt,
            })
            .from(orgMetadata)
            .where(
              and(
                lt(orgMetadata.createdAt, new Date(cutoff * 1000)),
                cursor === undefined
                  ? undefined
                  : gt(orgMetadata.orgId, cursor),
              ),
            )
            .orderBy(asc(orgMetadata.orgId))
            .limit(500);
          signal.throwIfAborted();
          for (const { orgId, ...value } of rows) {
            records.push({
              resource: "org_metadata",
              id: orgId,
              value: {
                ...value,
                recordedAt: value.recordedAt?.toISOString() ?? null,
              },
            });
          }
          if (rows.length < 500) return records;
          cursor = rows.at(-1)?.orgId;
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } finally {
    await client.end();
  }
}

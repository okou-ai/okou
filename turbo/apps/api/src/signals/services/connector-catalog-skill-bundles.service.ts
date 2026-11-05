import { isDeepStrictEqual } from "node:util";
import {
  CONNECTOR_SKILL_BUNDLE_RECEIPT_MAX_BYTES,
  connectorSkillBundleReceiptKey,
  parseConnectorSkillBundleReceipt,
} from "@okouai/connectors/connector-catalog/artifacts/skill-bundles";
import { connectorCatalogEntries } from "@okouai/db/runtime/connector-catalog";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db$, writeDb$ } from "../external/db";
import {
  downloadS3BufferWithMaxBytes,
  isS3NotFoundError,
} from "../external/s3";
import { safeSync, settle } from "../utils";
import { connectorCatalogSource } from "./connector-catalog-source";
import { ConnectorCatalogSkillError } from "./connector-catalog-skill-error";

const BATCH_SIZE = 100;

/**
 * Prepare only this pinned generation. Missing receipts cover producer/API
 * rollout and retained catalog rollback targets. Remove that bridge after the
 * supported producer floor and pinned-generation preparation gates in #45309.
 */
export const prepareConnectorCatalogSkillBundles$ = command(
  async ({ get, set }, hash: string, signal: AbortSignal): Promise<void> => {
    const [unprepared] = await get(db$)
      .select({ slug: connectorCatalogEntries.slug })
      .from(connectorCatalogEntries)
      .where(
        and(
          eq(connectorCatalogEntries.hash, hash),
          isNull(connectorCatalogEntries.skillContentBundle),
          sql`${connectorCatalogEntries.skill}->>'kind' = 'bundled'`,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!unprepared) {
      return;
    }
    const entries = await get(db$)
      .select({
        slug: connectorCatalogEntries.slug,
        skill: connectorCatalogEntries.skill,
        bundle: connectorCatalogEntries.skillContentBundle,
        sourceVersionId:
          connectorCatalogEntries.skillContentBundleSourceVersionId,
      })
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, hash));
    signal.throwIfAborted();
    const source = connectorCatalogSource();
    const downloaded = await settle(
      get(
        downloadS3BufferWithMaxBytes(
          source.bucket,
          connectorSkillBundleReceiptKey(hash),
          CONNECTOR_SKILL_BUNDLE_RECEIPT_MAX_BYTES,
          signal,
        ),
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!downloaded.ok) {
      if (isS3NotFoundError(downloaded.error)) {
        return;
      }
      throw downloaded.error;
    }
    const parsed = safeSync(() => {
      return parseConnectorSkillBundleReceipt({
        rawBytes: downloaded.value,
        catalogDigest: hash,
        connectors: entries,
      });
    });
    if (!("ok" in parsed)) {
      throw new ConnectorCatalogSkillError({
        code: "invalid-reference",
        cacheable: false,
      });
    }
    const bySlug = new Map(
      entries.map((entry) => {
        return [entry.slug, entry] as const;
      }),
    );
    for (const reference of parsed.ok) {
      const existing = bySlug.get(reference.slug);
      if (
        existing !== undefined &&
        existing.bundle !== null &&
        (!isDeepStrictEqual(existing.bundle, reference.bundle) ||
          existing.sourceVersionId !== reference.sourceVersionId)
      ) {
        throw new ConnectorCatalogSkillError({
          code: "invalid-reference",
          cacheable: false,
        });
      }
    }
    const db = set(writeDb$);
    for (let offset = 0; offset < parsed.ok.length; offset += BATCH_SIZE) {
      // Only additive preparation columns change; immutable catalog fields and
      // hashes already captured by readers retain their original identity.
      const references = sql`jsonb_to_recordset(${JSON.stringify(parsed.ok.slice(offset, offset + BATCH_SIZE))}::jsonb)
        AS prepared(slug text, "sourceVersionId" text, bundle jsonb)`;
      await db
        .update(connectorCatalogEntries)
        .set({
          skillContentBundle: sql`prepared.bundle`,
          skillContentBundleSourceVersionId: sql`prepared."sourceVersionId"`,
        })
        .from(references)
        .where(
          and(
            eq(connectorCatalogEntries.hash, hash),
            eq(connectorCatalogEntries.slug, sql`prepared.slug`),
            isNull(connectorCatalogEntries.skillContentBundle),
            sql`${connectorCatalogEntries.skill}->>'versionId' = prepared."sourceVersionId"`,
          ),
        );
      signal.throwIfAborted();
    }
  },
);

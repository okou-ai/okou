import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { eq, like } from "drizzle-orm";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse } from "../utils";

const BUILT_IN_MODEL_KEY_FIXTURE_LABEL_KIND = "runtime-state-fixture";
const builtInModelKeyFixtureLabelSchema = z.object({
  kind: z.literal(BUILT_IN_MODEL_KEY_FIXTURE_LABEL_KIND),
  fixtureIds: z.array(z.string().uuid()).min(1),
  preservedLabel: z.string().nullable().optional(),
});

interface BuiltInModelKeyRow {
  readonly vendor: string;
  readonly apiKey: string;
}

function builtInModelKeyFixtureLabel(
  fixtureIds: readonly string[],
  preservedLabel?: string | null,
): string {
  return JSON.stringify({
    kind: BUILT_IN_MODEL_KEY_FIXTURE_LABEL_KIND,
    fixtureIds,
    ...(preservedLabel === undefined ? {} : { preservedLabel }),
  });
}

function parseBuiltInModelKeyFixtureLabel(label: string | null) {
  if (!label) {
    return null;
  }
  const parsed = builtInModelKeyFixtureLabelSchema.safeParse(
    safeJsonParse(label),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Acquires fixture ownership of vendor-scoped built-in model keys.
 *
 * No product API provisions this platform-managed table. Test routes from
 * different integrations share each vendor row, so every owner must be
 * recorded under the same row lock before any fixture can release it.
 */
export async function acquireBuiltInModelKeyFixture(
  db: Db,
  fixtureId: string,
  rows: readonly BuiltInModelKeyRow[],
): Promise<readonly BuiltInModelKeyRow[]> {
  const acquiredRows: BuiltInModelKeyRow[] = [];
  for (const value of rows) {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0075; new non-billing transactions are prohibited.
    const apiKey = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(builtInModelKeys)
        .values({
          ...value,
          label: builtInModelKeyFixtureLabel([fixtureId]),
        })
        .onConflictDoUpdate({
          target: builtInModelKeys.vendor,
          // Keep the existing key while atomically locking and returning its
          // vendor row. DO NOTHING followed by SELECT FOR UPDATE leaves a
          // window where the previous fixture owner can delete the row.
          set: { vendor: value.vendor },
        })
        .returning({
          id: builtInModelKeys.id,
          apiKey: builtInModelKeys.apiKey,
          label: builtInModelKeys.label,
        });
      if (!row) {
        throw new Error(
          `Expected built-in model key for vendor: ${value.vendor}`,
        );
      }

      const fixtureLabel = parseBuiltInModelKeyFixtureLabel(row.label);
      if (fixtureLabel?.fixtureIds.includes(fixtureId)) {
        return row.apiKey;
      }
      const fixtureIds = fixtureLabel
        ? [...fixtureLabel.fixtureIds, fixtureId]
        : [fixtureId];
      const preservedLabel = fixtureLabel
        ? fixtureLabel.preservedLabel
        : row.label === fixtureId
          ? undefined
          : row.label;
      await tx
        .update(builtInModelKeys)
        .set({
          label: builtInModelKeyFixtureLabel(fixtureIds, preservedLabel),
          updatedAt: nowDate(),
        })
        .where(eq(builtInModelKeys.id, row.id));
      return row.apiKey;
    });
    acquiredRows.push({ vendor: value.vendor, apiKey });
  }
  return acquiredRows;
}

/** Releases only one fixture's ownership, deleting the row at the last owner. */
export async function releaseBuiltInModelKeyFixture(
  db: Db,
  fixtureId: string,
): Promise<void> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0076; new non-billing transactions are prohibited.
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: builtInModelKeys.id, label: builtInModelKeys.label })
      .from(builtInModelKeys)
      .where(like(builtInModelKeys.label, `%${fixtureId}%`))
      .orderBy(builtInModelKeys.vendor)
      .for("update");

    for (const row of rows) {
      const fixtureLabel = parseBuiltInModelKeyFixtureLabel(row.label);
      if (!fixtureLabel?.fixtureIds.includes(fixtureId)) {
        continue;
      }
      const remainingFixtureIds = fixtureLabel.fixtureIds.filter((id) => {
        return id !== fixtureId;
      });
      if (remainingFixtureIds.length > 0) {
        await tx
          .update(builtInModelKeys)
          .set({
            label: builtInModelKeyFixtureLabel(
              remainingFixtureIds,
              fixtureLabel.preservedLabel,
            ),
            updatedAt: nowDate(),
          })
          .where(eq(builtInModelKeys.id, row.id));
        continue;
      }
      if (fixtureLabel.preservedLabel !== undefined) {
        await tx
          .update(builtInModelKeys)
          .set({
            label: fixtureLabel.preservedLabel,
            updatedAt: nowDate(),
          })
          .where(eq(builtInModelKeys.id, row.id));
        continue;
      }
      await tx.delete(builtInModelKeys).where(eq(builtInModelKeys.id, row.id));
    }
  });
}

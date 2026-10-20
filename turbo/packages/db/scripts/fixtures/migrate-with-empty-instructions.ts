import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../../drizzle.config";
import {
  applyPendingMigrations,
  type ApplyPendingMigrationsOptions,
} from "../migration-runner";

/**
 * Historical transition scenarios own disposable Agents without authored instruction
 * sources. Replay their explicit empty-fixture backfill before the final constraint.
 * Production migrations never perform this repair. Retire with pre-finalization fixtures.
 */
export async function applyFixtureMigrations(
  client: Parameters<typeof applyPendingMigrations>[0],
  options: ApplyPendingMigrationsOptions = {},
): Promise<void> {
  const journal = z
    .object({
      entries: z.array(z.object({ tag: z.string(), when: z.number() })),
    })
    .parse(
      JSON.parse(
        readFileSync(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
      ),
    );
  const finalization = journal.entries.find((entry) => {
    return entry.tag.endsWith("_finalize_agent_instructions");
  });
  if (
    finalization === undefined ||
    (options.beforeMillis !== undefined &&
      options.beforeMillis <= finalization.when)
  ) {
    await applyPendingMigrations(client, options);
    return;
  }
  await applyPendingMigrations(client, {
    ...options,
    beforeMillis: finalization.when,
  });
  const [sources] = z.array(z.object({ count: z.number() })).parse(
    await client`
    SELECT count(*)::int AS count FROM agents a JOIN storages s
      ON s.org_id=a.org_id AND s.user_id='__org__' AND s.name='agent-instructions@' || a.name
    WHERE a.instructions IS NULL`,
  );
  assert.equal(
    sources?.count,
    0,
    "Authored instruction fixtures require their own backfill",
  );
  await client`UPDATE agents SET instructions='' WHERE instructions IS NULL`;
  await applyPendingMigrations(client, options);
}

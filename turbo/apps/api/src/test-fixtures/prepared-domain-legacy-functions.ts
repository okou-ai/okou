import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";

const baseline = readFileSync(
  new URL(
    "../../../../packages/db/src/migrations/1078_baseline.sql",
    import.meta.url,
  ),
  "utf8",
);
const invitation = readFileSync(
  new URL(
    "../../../../packages/db/src/migrations/1098_retire_member_invitation_capability.sql",
    import.meta.url,
  ),
  "utf8",
);

// Active 1132 transition control: use immutable shipped SQL in the caller's
// private schema after public functions disappear. Retire retained variants
// only after the production journal confirms contraction and its cycle drains.
export async function installPreparedDomainLegacyFunctions(
  client: PoolClient,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const source =
      name === "sync_legacy_org_plan_entitlement_member_invitation_allowed"
        ? invitation
        : baseline;
    const prefix =
      source === invitation ? "CREATE OR REPLACE FUNCTION" : "CREATE FUNCTION";
    const start = source.indexOf(`${prefix} public.${name}(`);
    const end = source.indexOf("$$;", start);
    if (start === -1 || end === -1) {
      throw new Error(`Missing shipped legacy function: ${name}`);
    }
    await client.query(
      source.slice(start, end + 3).replace(`${prefix} public.`, `${prefix} `),
    );
  }
}

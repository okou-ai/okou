import { computed } from "ccstate";
import { sql, type SQL } from "drizzle-orm";
import * as z from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import {
  executionMemberDisabledPaidTools,
  executionMemberMetadata,
  executionMemberModels,
  executionMemberOverrides,
  executionMemberPackCredits,
  executionMemberQuery,
} from "./execution-member-context.service";
import type { ExecutionMemberIdentity } from "./execution-member-metadata.service";
import {
  executionOrgQuery,
  type ExecutionOrgRows,
} from "./execution-org-context.service";
import { memberModelSourcesAggregate } from "./model-source-context.service";

const rawDecoder = zodDriverValueDecoder(z.unknown());
const orgRowSchema = z.object({
  metadata: z.unknown(),
  plan: z.unknown(),
  slots: z.unknown(),
  expired: z.unknown(),
  attached: z.unknown(),
});
const memberRowsDecoder = zodDriverValueDecoder(
  z.array(z.object({ kind: z.unknown(), payload: z.unknown() })),
);

/**
 * Own one preparation statement for a new organization/member identity. A
 * different member of a shared organization reads only that member's sources;
 * the caller retains the already-owned organization nodes. Global model and
 * connector environment reads deliberately remain outside this statement.
 */
export function createExecutionOrgMemberContext(
  owner: ExecutionMemberIdentity,
  attached?: SQL,
) {
  const sources = memberModelSourcesAggregate(owner.orgId, owner.userId);
  const snapshot$ = computed(async (get) => {
    const at = nowDate();
    const memberQuery = executionMemberQuery(owner, sources, at);
    const memberRows = sql`(SELECT COALESCE(jsonb_agg(member_snapshot), '[]'::jsonb)
      FROM (${memberQuery}) AS member_snapshot)`;
    const orgRow = attached
      ? sql`(SELECT to_jsonb(org_snapshot)
          FROM (${executionOrgQuery(owner.orgId, at, attached)}) AS org_snapshot)`
      : sql`NULL`;
    const [row] = await get(db$)
      .select({
        org: orgRow.mapWith(rawDecoder),
        member: memberRows.mapWith(memberRowsDecoder),
      })
      .from(sql`(SELECT 1) AS execution_snapshot`);
    if (!row) {
      throw new Error("Execution organization/member query returned no row");
    }
    return { at, ...row };
  });
  const orgRows$ = computed(async (get): Promise<ExecutionOrgRows> => {
    const snapshot = await get(snapshot$);
    return { at: snapshot.at, rows: [orgRowSchema.parse(snapshot.org)] };
  });
  const metadata$ = computed(async (get) => {
    return executionMemberMetadata((await get(snapshot$)).member);
  });
  const overrides$ = computed(async (get) => {
    return executionMemberOverrides(
      (await get(snapshot$)).member,
      owner.userId,
    );
  });
  const disabledPaidTools$ = computed(async (get) => {
    return executionMemberDisabledPaidTools((await get(snapshot$)).member);
  });
  const packCredits$ = computed(async (get) => {
    return executionMemberPackCredits((await get(snapshot$)).member);
  });
  const memberModels$ = computed(async (get) => {
    return executionMemberModels((await get(snapshot$)).member, sources);
  });
  return {
    orgRows$,
    metadata$,
    overrides$,
    disabledPaidTools$,
    packCredits$,
    memberModels$,
  };
}

import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computed } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { array, object, unknown as zUnknown } from "zod";
import {
  pgBooleanDecoder,
  pgNullDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
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
import { officialWorkflowThreadCondition } from "./official-workflow-policy.service";

const rawDecoder = zodDriverValueDecoder(zUnknown());
const orgRowSchema = object({
  metadata: zUnknown(),
  plan: zUnknown(),
  slots: zUnknown(),
  expired: zUnknown(),
  attached: zUnknown(),
});
const memberRowsDecoder = zodDriverValueDecoder(
  array(object({ kind: zUnknown(), payload: zUnknown() })),
);
const existingSendThreadColumns = Object.freeze({
  id: chatThreads.id,
  selectedModel: chatThreads.selectedModel,
  modelSettings: chatThreads.modelSettings,
  codexServiceTier: chatThreads.codexServiceTier,
  computerUseHostId: chatThreads.computerUseHostId,
  cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
});
export type ExistingSendThreadRow = Pick<
  typeof chatThreads.$inferSelect,
  keyof typeof existingSendThreadColumns
> & { readonly isOfficialWorkflowThread: boolean };

/**
 * Own one preparation statement for a new organization/member identity. A
 * different member of a shared organization reads only that member's sources;
 * the caller retains the already-owned organization nodes. Existing Chat sends
 * capture their thread settings here as well. Global model and connector
 * environment reads retain separate owners.
 */
export function createExecutionOrgMemberContext(
  owner: ExecutionMemberIdentity,
  includeOrg: boolean,
  existingThreadId?: string,
) {
  const sources = memberModelSourcesAggregate(owner.orgId, owner.userId);
  const snapshot$ = computed(async (get) => {
    const at = nowDate();
    const memberQuery = executionMemberQuery(owner, sources, at);
    const memberRows = sql`(SELECT COALESCE(jsonb_agg(member_snapshot), '[]'::jsonb)
      FROM (${memberQuery}) AS member_snapshot)`;
    const orgRow = includeOrg
      ? sql`(SELECT to_jsonb(org_snapshot)
          FROM (${executionOrgQuery(owner.orgId, at)}) AS org_snapshot)`
      : sql`NULL`;
    const db = get(db$);
    const selection = {
      org: orgRow.mapWith(rawDecoder),
      member: memberRows.mapWith(memberRowsDecoder),
    };
    const root = sql`(SELECT 1) AS execution_snapshot`;
    const [row] = await (existingThreadId === undefined
      ? db
          .select({
            ...selection,
            existingThread: sql`NULL`.mapWith(pgNullDecoder),
          })
          .from(root)
      : db
          .select({
            ...selection,
            existingThread: {
              ...existingSendThreadColumns,
              isOfficialWorkflowThread: officialWorkflowThreadCondition({
                ...owner,
                threadId: existingThreadId,
              }).mapWith(pgBooleanDecoder),
            },
          })
          .from(root)
          .leftJoin(
            chatThreads,
            and(
              eq(chatThreads.id, existingThreadId),
              eq(chatThreads.userId, owner.userId),
              chatThreadOrganizationCondition(owner.orgId),
            ),
          ));
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
  const existingThread$ = computed(
    async (get): Promise<ExistingSendThreadRow | null> => {
      return (await get(snapshot$)).existingThread;
    },
  );
  return {
    orgRows$,
    metadata$,
    overrides$,
    disabledPaidTools$,
    packCredits$,
    memberModels$,
    existingThread$,
  };
}

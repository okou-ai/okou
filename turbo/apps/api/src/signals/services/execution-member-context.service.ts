import { computed } from "ccstate";
import { and, asc, eq, sql, sum } from "drizzle-orm";
import { z } from "zod";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { executionCreditQueries } from "./execution-credit-balance.service";
import {
  userFeatureSwitchRowCondition,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
import type {
  ExecutionMemberIdentity,
  ExecutionMemberMetadata,
} from "./execution-member-metadata.service";

const rawDecoder = zodDriverValueDecoder(z.unknown());
const profileSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
});
const preferencesSchema = z.object({
  timezone: z.string().nullable(),
  selectedImageModel: z.string().nullable(),
  selectedModel: z.string().nullable(),
  serviceTier: z.string().nullable(),
  modelSettings: modelSettingsSchema,
  cloudBrowserEnabledByDefault: z.boolean(),
});
const switchSchema = z.array(
  z.object({ userId: z.string(), switches: z.record(z.string(), z.boolean()) }),
);
const toolSchema = z.array(z.object({ toolId: z.string() }));

/** One member statement; consumers decode only their own UNION payload. */
function createExecutionMemberRows(owner: ExecutionMemberIdentity) {
  return computed(async (get) => {
    const at = nowDate();
    const db = get(db$);
    const pack = executionCreditQueries(owner, at).pack;
    return await db
      .select({
        kind: sql`'profile'::text`.mapWith(rawDecoder),
        payload:
          sql`jsonb_build_object('name', ${userCache.name}, 'email', ${userCache.email})`.mapWith(
            rawDecoder,
          ),
      })
      .from(userCache)
      .where(eq(userCache.userId, owner.userId))
      .unionAll(
        db
          .select({
            kind: sql`'preferences'::text`.mapWith(rawDecoder),
            payload:
              sql`jsonb_build_object('timezone', ${orgMembersMetadata.timezone},
          'selectedImageModel', ${orgMembersMetadata.selectedImageModel}, 'selectedModel', ${orgMembersMetadata.selectedModel},
          'serviceTier', ${orgMembersMetadata.serviceTier}, 'modelSettings', ${orgMembersMetadata.modelSettings},
          'cloudBrowserEnabledByDefault', ${orgMembersMetadata.cloudBrowserEnabledByDefault})`.mapWith(
                rawDecoder,
              ),
          })
          .from(orgMembersMetadata)
          .where(
            and(
              eq(orgMembersMetadata.orgId, owner.orgId),
              eq(orgMembersMetadata.userId, owner.userId),
            ),
          ),
      )
      .unionAll(
        db
          .select({
            kind: sql`'switches'::text`.mapWith(rawDecoder),
            payload:
              sql`COALESCE(jsonb_agg(jsonb_build_object('userId', ${userFeatureSwitches.userId}, 'switches', ${userFeatureSwitches.switches})), '[]'::jsonb)`.mapWith(
                rawDecoder,
              ),
          })
          .from(userFeatureSwitches)
          .where(userFeatureSwitchRowCondition(owner.orgId, owner.userId)),
      )
      .unionAll(
        db
          .select({
            kind: sql`'tools'::text`.mapWith(rawDecoder),
            payload:
              sql`COALESCE(jsonb_agg(jsonb_build_object('toolId', ${userDisabledPaidTools.toolId}) ORDER BY ${asc(userDisabledPaidTools.toolId)}), '[]'::jsonb)`.mapWith(
                rawDecoder,
              ),
          })
          .from(userDisabledPaidTools)
          .where(
            and(
              eq(userDisabledPaidTools.orgId, owner.orgId),
              eq(userDisabledPaidTools.userId, owner.userId),
            ),
          ),
      )
      .unionAll(
        db
          .select({
            kind: sql`'pack'::text`.mapWith(rawDecoder),
            payload:
              sql`to_jsonb(${sum(usagePackCreditGrants.remainingAmount)}::text)`.mapWith(
                rawDecoder,
              ),
          })
          .from(usagePackCreditGrants)
          .where(pack.where),
      );
  });
}

export function createExecutionMemberContext(owner: ExecutionMemberIdentity) {
  const rows$ = createExecutionMemberRows(owner);
  const metadata$ = computed(async (get): Promise<ExecutionMemberMetadata> => {
    const rows = await get(rows$);
    const profile = rows.find((row) => {
      return row.kind === "profile";
    });
    const preferences = rows.find((row) => {
      return row.kind === "preferences";
    });
    return {
      profile: profile ? profileSchema.parse(profile.payload) : null,
      preferences: preferences
        ? preferencesSchema.parse(preferences.payload)
        : null,
    };
  });
  const overrides$ = computed(async (get) => {
    const rows = await get(rows$);
    const row = rows.find((entry) => {
      return entry.kind === "switches";
    });
    if (!row) {
      throw new Error("Execution member switches query returned no row");
    }
    return userFeatureSwitchOverridesFromRows(
      switchSchema.parse(row.payload),
      owner.userId,
    );
  });
  const disabledPaidTools$ = computed(async (get) => {
    const rows = await get(rows$);
    const row = rows.find((entry) => {
      return entry.kind === "tools";
    });
    if (!row) {
      throw new Error("Execution member tools query returned no row");
    }
    return toolSchema.parse(row.payload).map((tool) => {
      return tool.toolId;
    });
  });
  const packCredits$ = computed(async (get) => {
    const rows = await get(rows$);
    const row = rows.find((entry) => {
      return entry.kind === "pack";
    });
    if (!row) {
      throw new Error("Execution member credits query returned no row");
    }
    return row.payload === null
      ? 0
      : pgInt8ToSafeIntegerSchema.parse(row.payload);
  });
  return { metadata$, overrides$, disabledPaidTools$, packCredits$ };
}

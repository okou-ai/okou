import { and, asc, eq, sql, sum } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  array,
  boolean,
  object,
  record,
  string,
  unknown as zUnknown,
} from "zod";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { userCache } from "@okouai/db/schema/user-cache";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { userDisabledPaidTools } from "@okouai/db/schema/user-disabled-paid-tools";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { executionCreditQueries } from "./execution-credit-balance.service";
import { memberModelBootstrapFromSources } from "./model-bootstrap.service";
import type { memberModelSourcesAggregate } from "./model-source-context.service";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import {
  userFeatureSwitchRowCondition,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
import type {
  ExecutionMemberIdentity,
  ExecutionMemberMetadata,
} from "./execution-member-metadata.service";

const rawDecoder = zodDriverValueDecoder(zUnknown());
const profileSchema = object({
  name: string().nullable(),
  email: string().nullable(),
});
const preferencesSchema = object({
  timezone: string().nullable(),
  selectedImageModel: string().nullable(),
  selectedModel: string().nullable(),
  serviceTier: string().nullable(),
  modelSettings: modelSettingsSchema,
  cloudBrowserEnabledByDefault: boolean(),
});
const switchSchema = array(
  object({ userId: string(), switches: record(string(), boolean()) }),
);
const toolSchema = array(object({ toolId: string() }));

/**
 * Composable member UNION; consumers decode only their own payload. The member
 * model sources are gated before enqueue together with this metadata, so they
 * share the preparation statement without moving a failure boundary.
 */
export function executionMemberQuery(
  owner: ExecutionMemberIdentity,
  sources: ReturnType<typeof memberModelSourcesAggregate>,
  at: Date,
) {
  const db = new QueryBuilder();
  const pack = executionCreditQueries(owner, at).pack;
  return db
    .select({
      kind: sql`'profile'::text`.mapWith(rawDecoder).as("kind"),
      payload:
        sql`jsonb_build_object('name', ${userCache.name}, 'email', ${userCache.email})`
          .mapWith(rawDecoder)
          .as("payload"),
    })
    .from(userCache)
    .where(eq(userCache.userId, owner.userId))
    .unionAll(
      db
        .select({
          kind: sql`'preferences'::text`.mapWith(rawDecoder).as("kind"),
          payload:
            sql`jsonb_build_object('timezone', ${orgMembersMetadata.timezone},
          'selectedImageModel', ${orgMembersMetadata.selectedImageModel}, 'selectedModel', ${orgMembersMetadata.selectedModel},
          'serviceTier', ${orgMembersMetadata.serviceTier}, 'modelSettings', ${orgMembersMetadata.modelSettings},
          'cloudBrowserEnabledByDefault', ${orgMembersMetadata.cloudBrowserEnabledByDefault})`
              .mapWith(rawDecoder)
              .as("payload"),
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
          kind: sql`'switches'::text`.mapWith(rawDecoder).as("kind"),
          payload:
            sql`COALESCE(jsonb_agg(jsonb_build_object('userId', ${userFeatureSwitches.userId}, 'switches', ${userFeatureSwitches.switches})), '[]'::jsonb)`
              .mapWith(rawDecoder)
              .as("payload"),
        })
        .from(userFeatureSwitches)
        .where(userFeatureSwitchRowCondition(owner.orgId, owner.userId)),
    )
    .unionAll(
      db
        .select({
          kind: sql`'tools'::text`.mapWith(rawDecoder).as("kind"),
          payload:
            sql`COALESCE(jsonb_agg(jsonb_build_object('toolId', ${userDisabledPaidTools.toolId}) ORDER BY ${asc(userDisabledPaidTools.toolId)}), '[]'::jsonb)`
              .mapWith(rawDecoder)
              .as("payload"),
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
          kind: sql`'pack'::text`.mapWith(rawDecoder).as("kind"),
          payload:
            sql`to_jsonb(${sum(usagePackCreditGrants.remainingAmount)}::text)`
              .mapWith(rawDecoder)
              .as("payload"),
        })
        .from(usagePackCreditGrants)
        .where(pack.where),
    )
    .unionAll(
      db
        .select({
          kind: sql`'modelSources'::text`.mapWith(rawDecoder).as("kind"),
          payload: sources.payload.as("payload"),
        })
        .from(modelProviders)
        .leftJoin(modelProviderAccounts, sources.joins.account)
        .leftJoin(modelProviderAccountSecrets, sources.joins.secret)
        .where(sources.joins.provider),
    );
}

export interface ExecutionMemberRow {
  readonly kind: unknown;
  readonly payload: unknown;
}

export function executionMemberMetadata(
  rows: readonly ExecutionMemberRow[],
): ExecutionMemberMetadata {
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
}

export function executionMemberOverrides(
  rows: readonly ExecutionMemberRow[],
  userId: string,
) {
  const row = rows.find((entry) => {
    return entry.kind === "switches";
  });
  if (!row) {
    throw new Error("Execution member switches query returned no row");
  }
  return userFeatureSwitchOverridesFromRows(
    switchSchema.parse(row.payload),
    userId,
  );
}

export function executionMemberDisabledPaidTools(
  rows: readonly ExecutionMemberRow[],
) {
  const row = rows.find((entry) => {
    return entry.kind === "tools";
  });
  if (!row) {
    throw new Error("Execution member tools query returned no row");
  }
  return toolSchema.parse(row.payload).map((tool) => {
    return tool.toolId;
  });
}

export function executionMemberPackCredits(
  rows: readonly ExecutionMemberRow[],
) {
  const row = rows.find((entry) => {
    return entry.kind === "pack";
  });
  if (!row) {
    throw new Error("Execution member credits query returned no row");
  }
  return row.payload === null
    ? 0
    : pgInt8ToSafeIntegerSchema.parse(row.payload);
}

export function executionMemberModels(
  rows: readonly ExecutionMemberRow[],
  sources: ReturnType<typeof memberModelSourcesAggregate>,
) {
  const row = rows.find((entry) => {
    return entry.kind === "modelSources";
  });
  if (!row) {
    throw new Error("Execution member model sources query returned no row");
  }
  return memberModelBootstrapFromSources(sources.decode(row.payload));
}

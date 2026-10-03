import { computed } from "ccstate";
import { and, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { z } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import {
  providerFacts,
  providerProjection,
  providerSecretJoin,
  memberModelSourcesFromRows,
} from "./model-source-context.service";
import { memberModelBootstrapFromSources } from "./model-bootstrap.service";

/** One owner for the combined org/member IO; each projection owns its decoding. */
export function createProviderContext(
  orgId: string,
  userId: string,
  includeOrg: boolean,
) {
  const projection = providerProjection();
  const accountColumns = getTableColumns(modelProviderAccounts);
  const secretColumns = {
    name: modelProviderAccountSecrets.name,
    encryptedValue: modelProviderAccountSecrets.encryptedValue,
  };
  const builder = new QueryBuilder();
  const rows$ = computed(async (get) => {
    const query = builder
      .select({
        payload: sql`jsonb_build_object(
      'userId', ${modelProviders.userId},
      'provider', ${contextJsonProjection(projection.provider)},
      'providerSecret', case when ${secrets.id} is null then null else ${contextJsonProjection(projection.providerSecret)} end,
      'account', case when ${modelProviderAccounts.id} is null then null else ${contextJsonProjection(accountColumns)} end,
      'secret', case when ${modelProviderAccountSecrets.name} is null then null else ${contextJsonProjection(secretColumns)} end
    )`
          .mapWith(zodDriverValueDecoder(z.unknown()))
          .as("payload"),
      })
      .from(modelProviders)
      .leftJoin(
        modelProviderAccounts,
        and(
          eq(modelProviders.userId, userId),
          eq(modelProviderAccounts.modelProviderId, modelProviders.id),
          eq(modelProviderAccounts.orgId, orgId),
          eq(modelProviderAccounts.userId, userId),
          isNull(modelProviderAccounts.disconnectedAt),
        ),
      )
      .leftJoin(
        modelProviderAccountSecrets,
        eq(
          modelProviderAccountSecrets.modelProviderAccountId,
          modelProviderAccounts.id,
        ),
      )
      .leftJoin(secrets, providerSecretJoin)
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          inArray(
            modelProviders.userId,
            includeOrg ? [userId, ORG_SENTINEL_USER_ID] : [userId],
          ),
        ),
      );
    const [row] = await get(db$)
      .select({
        rows: contextJsonRows(query).mapWith(
          zodDriverValueDecoder(z.unknown()),
        ),
      })
      .from(sql`(values (1)) as context_seed(value)`);
    if (!row) {
      throw new Error("Provider context query returned no row");
    }
    return row.rows;
  });
  const orgModelSources$ = computed(async (get) => {
    const raw = ownerRows(await get(rows$), ORG_SENTINEL_USER_ID);
    return providerFacts(
      z
        .array(
          z.object({
            provider: contextProjectionSchema(projection.provider),
            providerSecret: contextProjectionSchema(
              projection.providerSecret,
            ).nullable(),
          }),
        )
        .parse(raw),
    );
  });
  const memberModels$ = computed(async (get) => {
    const raw = ownerRows(await get(rows$), userId);
    const joined = z
      .array(
        z.object({
          provider: contextProjectionSchema(projection.provider),
          providerSecret: contextProjectionSchema(
            projection.providerSecret,
          ).nullable(),
          account: contextProjectionSchema(accountColumns).nullable(),
          secret: contextProjectionSchema(secretColumns).nullable(),
        }),
      )
      .parse(raw);
    return memberModelBootstrapFromSources(
      memberModelSourcesFromRows(orgId, userId, joined),
    );
  });
  return { orgModelSources$, memberModels$ };
}

function ownerRows(value: unknown, userId: string) {
  return z
    .array(z.object({ userId: z.string() }).passthrough())
    .parse(value)
    .filter((row) => {
      return row.userId === userId;
    });
}

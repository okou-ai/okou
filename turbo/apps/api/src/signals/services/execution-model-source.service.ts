import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { db$, type ReadonlyDb } from "../external/db";
import type { MemberModelBootstrap } from "./model-bootstrap.service";
import { managedSourceFromSnapshot } from "./model-source-context.service";

export type ModelSourceIdentity =
  | { readonly kind: "built-in"; readonly modelKeyId: string }
  | { readonly kind: "member"; readonly accountId: string };

export interface ModelSourceRequest {
  readonly orgId: string;
  readonly userId: string;
  readonly source: ModelSourceIdentity;
}
export type ModelSourceCredential =
  | EncryptedModelCredential
  | ManagedModelKeyReference;
export interface ManagedModelKeyReference {
  readonly kind: "managed-key";
  readonly name: string;
  readonly modelKeyId: string;
  readonly apiKey: string;
}
export interface EncryptedModelCredential {
  readonly kind: "encrypted";
  readonly name: string;
  readonly encryptedValue: string;
}
export interface ModelSourceConfiguration {
  readonly providerType: string;
  readonly authMethod: string | null;
  readonly managedVendor?: string;
}
export interface ModelSourceSnapshot {
  readonly identity: ModelSourceIdentity;
  readonly configuration: ModelSourceConfiguration;
  readonly credentials: readonly ModelSourceCredential[];
  readonly accountIdentity: string | null;
}

async function loadManagedSource(
  db: Pick<ReadonlyDb, "select">,
  source: Extract<ModelSourceIdentity, { kind: "built-in" }>,
): Promise<ModelSourceSnapshot | null> {
  const [key] = await db
    .select({
      id: builtInModelKeys.id,
      vendor: builtInModelKeys.vendor,
      apiKey: builtInModelKeys.apiKey,
    })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, source.modelKeyId))
    .limit(1);
  return managedSourceFromSnapshot(key);
}

/** Read only an already-selected source; never select defaults or decrypt. */
export function createModelSourceSnapshot(
  request: ModelSourceRequest,
  memberSnapshot?: MemberModelBootstrap,
): Computed<Promise<ModelSourceSnapshot | null>> {
  return computed(async (get): Promise<ModelSourceSnapshot | null> => {
    const db = get(db$);
    const source = request.source;
    if (source.kind === "member") {
      if (
        memberSnapshot &&
        (memberSnapshot.orgId !== request.orgId ||
          memberSnapshot.userId !== request.userId)
      ) {
        throw new Error("Model source snapshot identity mismatch");
      }
      const rows = memberSnapshot
        ? memberSnapshot.rows.filter((row) => {
            return row.account.id === source.accountId;
          })
        : await db
            .select({
              account: modelProviderAccounts,
              secret: {
                name: modelProviderAccountSecrets.name,
                encryptedValue: modelProviderAccountSecrets.encryptedValue,
              },
            })
            .from(modelProviderAccounts)
            .innerJoin(
              modelProviders,
              eq(modelProviderAccounts.modelProviderId, modelProviders.id),
            )
            .leftJoin(
              modelProviderAccountSecrets,
              eq(
                modelProviderAccountSecrets.modelProviderAccountId,
                modelProviderAccounts.id,
              ),
            )
            .where(
              and(
                eq(modelProviderAccounts.id, source.accountId),
                eq(modelProviderAccounts.orgId, request.orgId),
                eq(modelProviderAccounts.userId, request.userId),
                isNull(modelProviderAccounts.disconnectedAt),
              ),
            );
      const first = rows[0];
      if (!first) {
        return null;
      }
      return {
        identity: source,
        configuration: {
          providerType: first.account.type,
          authMethod: first.account.authMethod,
        },
        credentials: rows.flatMap((row) => {
          return row.secret
            ? [{ kind: "encrypted" as const, ...row.secret }]
            : [];
        }),
        accountIdentity: first.account.externalAccountId,
      };
    }
    return await loadManagedSource(db, source);
  });
}

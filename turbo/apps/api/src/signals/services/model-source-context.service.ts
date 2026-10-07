import {
  BUILT_IN_MODEL_ROUTE_PROVIDERS,
  getSecretNameForType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { computed } from "ccstate";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db$ } from "../external/db";
import { usagePricingByKey } from "./built-in-route-pricing";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
import type { MemberModelBootstrap } from "./model-bootstrap.service";

function providerProjection() {
  return {
    // Only identity and runtime configuration participate in these facts.
    // Account health/default/expiry fences remain on the full account projection.
    provider: {
      id: modelProviders.id,
      type: modelProviders.type,
      userId: modelProviders.userId,
      orgId: modelProviders.orgId,
      authMethod: modelProviders.authMethod,
      selectedModel: modelProviders.selectedModel,
    },
  };
}

type ProviderRow = {
  readonly provider: Pick<
    typeof modelProviders.$inferSelect,
    "id" | "type" | "userId" | "orgId" | "authMethod" | "selectedModel"
  >;
};

function providerFacts(rows: readonly ProviderRow[]) {
  return [
    ...new Map(
      rows.map((row) => {
        return [row.provider.id, row.provider];
      }),
    ).values(),
  ];
}

/** Member providers, connected accounts and both credential kinds share a read. */
export function createMemberModelSources(orgId: string, userId: string) {
  return computed(async (get) => {
    const joined = await get(db$)
      .select({
        ...providerProjection(),
        account: modelProviderAccounts,
        secret: {
          name: modelProviderAccountSecrets.name,
          encryptedValue: modelProviderAccountSecrets.encryptedValue,
        },
      })
      .from(modelProviders)
      .leftJoin(
        modelProviderAccounts,
        and(
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
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, userId),
          inArray(modelProviders.type, [
            "codex-oauth-token",
            "claude-code-oauth-token",
          ]),
        ),
      );
    return memberModelSourcesFromRows(orgId, userId, joined);
  });
}

export function memberModelSourcesFromRows(
  orgId: string,
  userId: string,
  joined: readonly (ProviderRow & {
    readonly account: typeof modelProviderAccounts.$inferSelect | null;
    readonly secret: {
      readonly name: string;
      readonly encryptedValue: string;
    } | null;
  })[],
) {
  const rows = [
    ...new Map(
      joined.flatMap((row) => {
        return row.account
          ? [
              [
                JSON.stringify([row.account.id, row.secret?.name]),
                { account: row.account, secret: row.secret },
              ] as const,
            ]
          : [];
      }),
    ).values(),
  ];
  return { orgId, userId, providers: providerFacts(joined), rows };
}

export function memberAccountSourceFromSnapshot(
  snapshot: MemberModelBootstrap,
  accountId: string,
): ModelSourceSnapshot | null {
  const rows = snapshot.rows.filter((row) => {
    return row.account.id === accountId;
  });
  const first = rows[0];
  if (!first) {
    return null;
  }
  return {
    identity: { kind: "member", accountId },
    credentialOwner: "member",
    configuration: {
      kind: "registered-provider",
      providerType: first.account.type,
      authMethod: first.account.authMethod,
    },
    credentials: rows.flatMap((row) => {
      return row.secret ? [{ kind: "encrypted" as const, ...row.secret }] : [];
    }),
    accountIdentity: first.account.externalAccountId,
  };
}

/** Global identity: metadata and managed secret are one authoritative snapshot. */
export function createManagedModelKeys() {
  return computed(async (get) => {
    return await get(db$)
      .select({
        id: builtInModelKeys.id,
        vendor: builtInModelKeys.vendor,
        apiKey: builtInModelKeys.apiKey,
      })
      .from(builtInModelKeys);
  });
}

export function managedSourceFromSnapshot(
  key:
    | Awaited<
        ReturnType<ReturnType<typeof createManagedModelKeys>["read"]>
      >[number]
    | undefined,
): ModelSourceSnapshot | null {
  if (!key) {
    return null;
  }
  const provider = Object.entries(BUILT_IN_MODEL_ROUTE_PROVIDERS).find(
    ([, config]) => {
      return config.vendor === key.vendor;
    },
  );
  if (!provider) {
    throw new Error("Managed model key vendor is unsupported");
  }
  const name = getSecretNameForType(modelProviderTypeSchema.parse(provider[0]));
  if (!name) {
    throw new Error("Managed model key has no credential binding");
  }
  return {
    identity: { kind: "built-in", modelKeyId: key.id },
    credentialOwner: "builtin",
    configuration: {
      kind: "registered-provider",
      providerType: "built-in",
      authMethod: null,
      managedVendor: key.vendor,
    },
    credentials: [
      { kind: "managed-key", name, modelKeyId: key.id, apiKey: key.apiKey },
    ],
    accountIdentity: null,
  };
}

/** Global raw pricing keys; request-specific aliases select from this projection. */
export function createModelPricing() {
  return computed(async (get) => {
    return usagePricingByKey(
      await get(db$)
        .select({
          kind: usagePricing.kind,
          provider: usagePricing.provider,
          category: usagePricing.category,
        })
        .from(usagePricing),
    );
  });
}

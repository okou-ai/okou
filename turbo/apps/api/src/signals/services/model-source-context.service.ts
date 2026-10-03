import { computed } from "ccstate";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { secrets } from "@okouai/db/schema/secret";
import {
  hasAuthMethods,
  modelProviderTypeSchema,
  BUILT_IN_MODEL_ROUTE_PROVIDERS,
  getSecretNameForType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  modelProviderSurfaceProtocolSchema,
  getModelProviderTypeForSurfaceProtocol,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { db$ } from "../external/db";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import { GATEWAY_RUNTIME_SECRET_NAME } from "./model-provider-gateway-runtime";
import type { ModelSourceSnapshot } from "./execution-model-source.service";
import { usagePricingByKey } from "./built-in-route-pricing";
import type { MemberModelBootstrap } from "./model-bootstrap.service";

const MULTI_AUTH_TYPES = modelProviderTypeSchema.options.filter(hasAuthMethods);
export const providerSecretJoin = and(
  eq(secrets.orgId, modelProviders.orgId),
  eq(secrets.userId, modelProviders.userId),
  or(
    and(
      inArray(modelProviders.type, MULTI_AUTH_TYPES),
      eq(secrets.type, "model-provider"),
    ),
    and(
      notInArray(modelProviders.type, MULTI_AUTH_TYPES),
      eq(secrets.id, modelProviders.secretId),
    ),
  ),
);
export function providerProjection() {
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
    providerSecret: {
      name: secrets.name,
      encryptedValue: secrets.encryptedValue,
    },
  };
}

type ProviderRow = {
  readonly provider: Pick<
    typeof modelProviders.$inferSelect,
    "id" | "type" | "userId" | "orgId" | "authMethod" | "selectedModel"
  >;
  readonly providerSecret: {
    readonly name: string;
    readonly encryptedValue: string;
  } | null;
};

export function providerFacts(rows: readonly ProviderRow[]) {
  const groups = new Map<string, ProviderRow[]>();
  for (const row of rows) {
    const group = groups.get(row.provider.id);
    if (group) {
      group.push(row);
    } else {
      groups.set(row.provider.id, [row]);
    }
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    if (!first) {
      throw new Error("Provider group is empty");
    }
    const provider = first.provider;
    const organization = provider.userId === ORG_SENTINEL_USER_ID;
    const credentials = [
      ...new Map(
        group.flatMap(({ providerSecret }) => {
          return providerSecret
            ? [
                [
                  providerSecret.name,
                  { kind: "encrypted" as const, ...providerSecret },
                ] as const,
              ]
            : [];
        }),
      ).values(),
    ];
    const source: ModelSourceSnapshot = {
      identity: {
        kind: organization ? "organization" : "member-provider",
        modelProviderId: provider.id,
      },
      credentialOwner: organization ? "organization" : "member",
      configuration: {
        kind: "registered-provider",
        providerType: provider.type,
        authMethod: provider.authMethod,
        configuredModel: provider.selectedModel,
      },
      credentials,
      accountIdentity: null,
    };
    return { ...provider, source };
  });
}

/** Organization provider metadata and encrypted credentials share one rowset. */
export function createOrgModelSources(orgId: string) {
  return computed(async (get) => {
    return providerFacts(
      await get(db$)
        .select(providerProjection())
        .from(modelProviders)
        .leftJoin(secrets, providerSecretJoin)
        .where(
          and(
            eq(modelProviders.orgId, orgId),
            eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          ),
        ),
    );
  });
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
      .leftJoin(secrets, providerSecretJoin)
      .where(
        and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
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
                {
                  account: row.account,
                  configuredModel: row.provider.selectedModel,
                  secret: row.secret,
                },
              ] as const,
            ]
          : [];
      }),
    ).values(),
  ];
  return { orgId, userId, providers: providerFacts(joined), rows };
}

/** Mapping and credential authority are captured together, before selection. */
export function createGatewayModelSources(orgId: string) {
  return computed(async (get) => {
    return await get(db$)
      .select({
        id: modelProviderSurfaces.id,
        protocol: modelProviderSurfaces.protocol,
        apiBaseUrl: modelProviderSurfaces.apiBaseUrl,
        authHeaderName: modelProviderSurfaces.authHeaderName,
        authHeaderTemplate: modelProviderSurfaces.authHeaderTemplate,
        modelMappings: modelProviderSurfaces.modelMappings,
        displayName: modelProviderConnections.displayName,
        encryptedValue: secrets.encryptedValue,
        secretOrgId: secrets.orgId,
      })
      .from(modelProviderSurfaces)
      .innerJoin(
        modelProviderConnections,
        eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
      )
      .leftJoin(secrets, eq(modelProviderConnections.secretId, secrets.id))
      .where(eq(modelProviderConnections.orgId, orgId));
  });
}

export function gatewaySourceFromSnapshot(
  orgId: string,
  row:
    | Awaited<
        ReturnType<ReturnType<typeof createGatewayModelSources>["read"]>
      >[number]
    | undefined,
): ModelSourceSnapshot | null {
  if (!row || row.encryptedValue === null) {
    return null;
  }
  if (row.secretOrgId !== orgId) {
    throw new Error("Gateway credential owner mismatch");
  }
  const protocol = modelProviderSurfaceProtocolSchema.parse(row.protocol);
  return {
    identity: { kind: "gateway", surfaceId: row.id },
    credentialOwner: "organization",
    configuration: {
      kind: "gateway",
      providerType: getModelProviderTypeForSurfaceProtocol(protocol),
      protocol,
      apiBaseUrl: row.apiBaseUrl,
      authHeaderName: row.authHeaderName,
      authHeaderTemplate: row.authHeaderTemplate,
      modelMappings: row.modelMappings,
      displayName: row.displayName,
    },
    credentials: [
      {
        kind: "encrypted",
        name: GATEWAY_RUNTIME_SECRET_NAME,
        encryptedValue: row.encryptedValue,
      },
    ],
    accountIdentity: null,
  };
}

export function registeredSourceFromSnapshot(
  providerId: string,
  scope: "org" | "member" | undefined,
  org: Awaited<ReturnType<ReturnType<typeof createOrgModelSources>["read"]>>,
  member: MemberModelBootstrap,
): ModelSourceSnapshot | null {
  const providers =
    scope === "org"
      ? org
      : scope === "member"
        ? member.providers
        : [...org, ...member.providers];
  return (
    providers.find((provider) => {
      return provider.id === providerId;
    })?.source ?? null
  );
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
      configuredModel: first.configuredModel,
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
      configuredModel: null,
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

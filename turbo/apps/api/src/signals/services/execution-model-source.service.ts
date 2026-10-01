import { computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { secrets } from "@okouai/db/schema/secret";
import {
  hasAuthMethods,
  modelProviderTypeSchema,
  BUILT_IN_MODEL_ROUTE_PROVIDERS,
  getSecretNameForType,
} from "@okouai/api-contracts/contracts/model-providers";
import { db$, type ReadonlyDb } from "../external/db";
import {
  modelProviderSurfaceProtocolSchema,
  getModelProviderTypeForSurfaceProtocol,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { ORG_SENTINEL_USER_ID } from "./feature-switch-scope";
import { GATEWAY_RUNTIME_SECRET_NAME } from "./model-provider-gateway-runtime";

export type ModelSourceIdentity =
  | { readonly kind: "built-in"; readonly modelKeyId: string }
  | { readonly kind: "organization"; readonly modelProviderId: string }
  | { readonly kind: "member"; readonly accountId: string }
  | { readonly kind: "member-provider"; readonly modelProviderId: string }
  | { readonly kind: "gateway"; readonly surfaceId: string };

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
}
export interface EncryptedModelCredential {
  readonly kind: "encrypted";
  readonly name: string;
  readonly encryptedValue: string;
}
export interface RegisteredProviderConfiguration {
  readonly kind: "registered-provider";
  readonly providerType: string;
  readonly authMethod: string | null;
  readonly managedVendor?: string;
  readonly configuredModel: string | null;
}
export interface GatewayProviderConfiguration {
  readonly kind: "gateway";
  readonly providerType: string;
  readonly protocol: "anthropic-messages" | "openai-responses";
  readonly displayName: string;
  readonly apiBaseUrl: string;
  readonly authHeaderName: string;
  readonly authHeaderTemplate: string;
  readonly modelMappings: Readonly<Record<string, string>>;
}
export type ModelSourceConfiguration =
  | RegisteredProviderConfiguration
  | GatewayProviderConfiguration;
export interface ModelSourceSnapshot {
  readonly identity: ModelSourceIdentity;
  readonly credentialOwner: "builtin" | "organization" | "member";
  readonly configuration: ModelSourceConfiguration;
  readonly credentials: readonly ModelSourceCredential[];
  readonly accountIdentity: string | null;
}

async function loadGatewaySource(
  db: Pick<ReadonlyDb, "select">,
  request: ModelSourceRequest,
  source: Extract<ModelSourceIdentity, { kind: "gateway" }>,
): Promise<ModelSourceSnapshot | null> {
  const [row] = await db
    .select({
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
    .innerJoin(secrets, eq(modelProviderConnections.secretId, secrets.id))
    .where(
      and(
        eq(modelProviderSurfaces.id, source.surfaceId),
        eq(modelProviderConnections.orgId, request.orgId),
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  if (row.secretOrgId !== request.orgId) {
    throw new Error("Gateway credential owner mismatch");
  }
  const protocol = modelProviderSurfaceProtocolSchema.parse(row.protocol);
  return {
    identity: source,
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

async function loadManagedSource(
  db: Pick<ReadonlyDb, "select">,
  source: Extract<ModelSourceIdentity, { kind: "built-in" }>,
): Promise<ModelSourceSnapshot | null> {
  const [key] = await db
    .select({ id: builtInModelKeys.id, vendor: builtInModelKeys.vendor })
    .from(builtInModelKeys)
    .where(eq(builtInModelKeys.id, source.modelKeyId))
    .limit(1);
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
    identity: source,
    credentialOwner: "builtin",
    configuration: {
      kind: "registered-provider",
      providerType: "built-in",
      authMethod: null,
      managedVendor: key.vendor,
      configuredModel: null,
    },
    credentials: [{ kind: "managed-key", name, modelKeyId: key.id }],
    accountIdentity: null,
  };
}

/** Read only an already-selected source; never select defaults or decrypt. */
export function createModelSourceSnapshot(
  request: ModelSourceRequest,
): Computed<Promise<ModelSourceSnapshot | null>> {
  return computed(async (get): Promise<ModelSourceSnapshot | null> => {
    const db = get(db$);
    const source = request.source;
    if (source.kind === "gateway") {
      return await loadGatewaySource(db, request, source);
    }
    if (source.kind === "member") {
      const rows = await db
        .select({
          account: modelProviderAccounts,
          configuredModel: modelProviders.selectedModel,
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
        credentialOwner: "member",
        configuration: {
          kind: "registered-provider",
          providerType: first.account.type,
          authMethod: first.account.authMethod,
          configuredModel: first.configuredModel,
        },
        credentials: rows.flatMap((row) => {
          return row.secret
            ? [{ kind: "encrypted" as const, ...row.secret }]
            : [];
        }),
        accountIdentity: first.account.externalAccountId,
      };
    }
    if (source.kind === "organization" || source.kind === "member-provider") {
      const ownerUserId =
        source.kind === "organization" ? ORG_SENTINEL_USER_ID : request.userId;
      const [provider] = await db
        .select({
          type: modelProviders.type,
          authMethod: modelProviders.authMethod,
          secretId: modelProviders.secretId,
          configuredModel: modelProviders.selectedModel,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.id, source.modelProviderId),
            eq(modelProviders.orgId, request.orgId),
            eq(modelProviders.userId, ownerUserId),
          ),
        )
        .limit(1);
      if (!provider) {
        return null;
      }
      const providerType = modelProviderTypeSchema.parse(provider.type);
      const credentials = await db
        .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
        .from(secrets)
        .where(
          and(
            eq(secrets.orgId, request.orgId),
            eq(secrets.userId, ownerUserId),
            hasAuthMethods(providerType)
              ? eq(secrets.type, "model-provider")
              : provider.secretId === null
                ? isNull(secrets.id)
                : eq(secrets.id, provider.secretId),
          ),
        );
      return {
        identity: source,
        credentialOwner:
          source.kind === "organization" ? "organization" : "member",
        configuration: {
          kind: "registered-provider",
          providerType: provider.type,
          authMethod: provider.authMethod,
          configuredModel: provider.configuredModel,
        },
        credentials: credentials.map((credential) => {
          return {
            kind: "encrypted" as const,
            ...credential,
          };
        }),
        accountIdentity: null,
      };
    }
    return await loadManagedSource(db, source);
  });
}

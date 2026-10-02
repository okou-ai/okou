import { computed, type Computed } from "ccstate";
import type { MemberModelBootstrap } from "./model-bootstrap.service";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
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
  /**
   * An exact provider row whose pin carries no credential scope. The reader
   * resolves the member/workspace owner in the same statement; the snapshot
   * identity is the resolved organization or member-provider identity.
   */
  | { readonly kind: "unscoped-provider"; readonly modelProviderId: string }
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

const MULTI_AUTH_PROVIDER_TYPES = modelProviderTypeSchema.options.filter(
  (type) => {
    return hasAuthMethods(type);
  },
);

/**
 * One statement reads the exact provider row, its owner and its encrypted
 * credentials, so ownership and credentials come from the same snapshot.
 */
async function loadRegisteredProviderSource(
  db: ReadonlyDb,
  request: ModelSourceRequest,
  source: Extract<
    ModelSourceIdentity,
    { kind: "organization" | "member-provider" | "unscoped-provider" }
  >,
): Promise<ModelSourceSnapshot | null> {
  const owners =
    source.kind === "organization"
      ? [ORG_SENTINEL_USER_ID]
      : source.kind === "member-provider"
        ? [request.userId]
        : [request.userId, ORG_SENTINEL_USER_ID];
  const rows = await db
    .select({
      type: modelProviders.type,
      authMethod: modelProviders.authMethod,
      configuredModel: modelProviders.selectedModel,
      ownerUserId: modelProviders.userId,
      secret: { name: secrets.name, encryptedValue: secrets.encryptedValue },
    })
    .from(modelProviders)
    .leftJoin(
      secrets,
      and(
        eq(secrets.orgId, modelProviders.orgId),
        eq(secrets.userId, modelProviders.userId),
        or(
          and(
            inArray(modelProviders.type, MULTI_AUTH_PROVIDER_TYPES),
            eq(secrets.type, "model-provider"),
          ),
          and(
            notInArray(modelProviders.type, MULTI_AUTH_PROVIDER_TYPES),
            eq(secrets.id, modelProviders.secretId),
          ),
        ),
      ),
    )
    .where(
      and(
        eq(modelProviders.id, source.modelProviderId),
        eq(modelProviders.orgId, request.orgId),
        inArray(modelProviders.userId, owners),
      ),
    );
  const [first] = rows;
  if (!first) {
    return null;
  }
  modelProviderTypeSchema.parse(first.type);
  const organization = first.ownerUserId === ORG_SENTINEL_USER_ID;
  return {
    identity: organization
      ? { kind: "organization", modelProviderId: source.modelProviderId }
      : { kind: "member-provider", modelProviderId: source.modelProviderId },
    credentialOwner: organization ? "organization" : "member",
    configuration: {
      kind: "registered-provider",
      providerType: first.type,
      authMethod: first.authMethod,
      configuredModel: first.configuredModel,
    },
    credentials: rows.flatMap((row) => {
      return row.secret ? [{ kind: "encrypted" as const, ...row.secret }] : [];
    }),
    accountIdentity: null,
  };
}

/** Read only an already-selected source; never select defaults or decrypt. */
export function createModelSourceSnapshot(
  request: ModelSourceRequest,
  memberSnapshot?: MemberModelBootstrap,
): Computed<Promise<ModelSourceSnapshot | null>> {
  return computed(async (get): Promise<ModelSourceSnapshot | null> => {
    const db = get(db$);
    const source = request.source;
    if (source.kind === "gateway") {
      return await loadGatewaySource(db, request, source);
    }
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
    if (
      source.kind === "organization" ||
      source.kind === "member-provider" ||
      source.kind === "unscoped-provider"
    ) {
      return await loadRegisteredProviderSource(db, request, source);
    }
    return await loadManagedSource(db, source);
  });
}
